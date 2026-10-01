import { setTimeout as sleep } from "node:timers/promises";
import { jsonEqual, ProviderFailure, type HandlerContext, type Json } from "@runtime-protocol/sdk";
import { parseRef, refOf, resolve, type Kind, type Ref } from "./refs.ts";
import {
  after,
  fetchAll,
  fetchOne,
  notVisible,
  observe,
  receipt,
  reconciling,
  record,
  refuseMembers,
  type Deps,
  type Outcome,
} from "./shared.ts";
import {
  applyPatch,
  channelView,
  checkPatch,
  commentState,
  commentView,
  itemState,
  itemView,
  MODERATION_TO_YOUTUBE,
  PLAYLIST_FIELDS,
  playlistState,
  playlistView,
  replacementPatch,
  sortedTags,
  thumbnailState,
  VIDEO_FIELDS,
  versionOf,
  videoState,
  videoView,
  writablePlaylist,
  writableVideo,
} from "./views.ts";

const V3 = "/youtube/v3";
const MAX_THUMBNAIL = 2 * 1024 * 1024;
/** How often, and how far apart, a deletion is looked for before it is left unobserved. */
const READ_BACK_TRIES = 4;
const READ_BACK_PAUSE_MS = 1_500;
const COLLECTION = {
  video: "videos",
  thumbnail: "videos",
  playlist: "playlists",
  playlist_item: "playlistItems",
  comment: "comments",
  channel: "channels",
} as const;
const PARTS: Record<Kind, string> = {
  channel: "snippet,statistics,contentDetails",
  video: "snippet,status,statistics,contentDetails",
  thumbnail: "snippet",
  playlist: "snippet,status,contentDetails",
  playlist_item: "snippet,contentDetails",
  comment: "snippet",
};
/** The parts an update reads and writes. */
const WRITE_PARTS: Record<Kind, string> = {
  channel: "snippet",
  video: "snippet,status",
  thumbnail: "snippet",
  playlist: "snippet,status",
  playlist_item: "snippet",
  comment: "snippet",
};
const NAMES: Record<Kind, string> = {
  channel: "channel",
  video: "video",
  thumbnail: "thumbnail",
  playlist: "playlist",
  playlist_item: "playlist item",
  comment: "comment",
};

/** The state a version is made of, per kind (channels have none). */
function stateOf(kind: Kind, resource: Record<string, any>): Json | undefined {
  switch (kind) {
    case "video":
      return videoState(resource);
    case "thumbnail":
      return thumbnailState(resource);
    case "playlist":
      return playlistState(resource);
    case "playlist_item":
      return itemState(resource);
    case "comment":
      return commentState(resource);
    case "channel":
      return undefined;
  }
}

/** Reads one resource; refuses what does not exist or belongs to another channel. */
async function load(
  ctx: HandlerContext,
  deps: Deps,
  ref: Ref,
  part = PARTS[ref.kind],
): Promise<Record<string, any>> {
  const id = ref.kind === "channel" ? ref.channel : ref.id;
  const found = await fetchOne(ctx, deps, COLLECTION[ref.kind], id, part);
  if (!found)
    throw new ProviderFailure(
      ref.kind === "comment"
        ? "the YouTube comment does not exist or is not public (held or rejected)"
        : `the YouTube ${NAMES[ref.kind]} does not exist`,
    );
  const owner = found["snippet"]?.["channelId"];
  if (
    ["video", "thumbnail", "playlist", "playlist_item"].includes(ref.kind) &&
    owner !== undefined &&
    owner !== deps.channel
  )
    throw new ProviderFailure(`the YouTube ${NAMES[ref.kind]} belongs to another channel`);
  if (ref.kind === "playlist_item" && found["snippet"]?.["playlistId"] !== ref.playlist)
    throw new ProviderFailure("the YouTube playlist item is not in that playlist");
  return found;
}

function checkVersion(kind: Kind, resource: Record<string, any>, expected: unknown): void {
  if (expected === undefined) return;
  const state = stateOf(kind, resource);
  const current = state ? versionOf(state) : undefined;
  if (current !== expected)
    throw new ProviderFailure(
      `the YouTube ${NAMES[kind]} changed: expected version ${String(expected)}, found ${current ?? "none"}`,
    );
}

const refs = (deps: Deps) => ({
  video: (id: string) => refOf({ kind: "video", channel: deps.channel, id }),
  thumbnail: (id: string) => refOf({ kind: "thumbnail", channel: deps.channel, id }),
  playlist: (id: string) => refOf({ kind: "playlist", channel: deps.channel, id }),
  comment: (id: string) => refOf({ kind: "comment", channel: deps.channel, id }),
  item: (playlist: string, id: string) =>
    refOf({ kind: "playlist_item", channel: deps.channel, playlist, id }),
});

// ---------------------------------------------------------------------------------------
// resource.read

export async function read(input: Json, ctx: HandlerContext, deps: Deps) {
  const ref = resolve(deps.channel, input["resource"], [
    "channel",
    "video",
    "thumbnail",
    "playlist",
    "playlist_item",
    "comment",
  ]);
  const r = refs(deps);
  const found = await load(ctx, deps, ref);
  const state = stateOf(ref.kind, found);
  const version = state ? versionOf(state) : undefined;
  if (input["version"] !== undefined && input["version"] !== version)
    throw new ProviderFailure("YouTube serves only the current version of a resource");
  let content: Json;
  switch (ref.kind) {
    case "channel":
      content = channelView(found, r.playlist);
      break;
    case "video":
      content = videoView(found, r.thumbnail);
      break;
    case "thumbnail":
      content = state!;
      break;
    case "playlist":
      content = playlistView(found);
      break;
    case "playlist_item":
      content = itemView(found, (id) => refOf({ kind: "video", channel: deps.channel, id }));
      break;
    case "comment":
      content = commentView(found, r.comment);
      break;
  }
  const fields = input["fields"] as string[] | undefined;
  if (fields)
    content = Object.fromEntries(Object.entries(content).filter(([k]) => fields.includes(k)));
  const updatedAt = found["snippet"]?.["updatedAt"];
  const resource = {
    ref: refOf(ref),
    type: ref.kind,
    ...(version ? { version } : {}),
    ...(typeof updatedAt === "string" ? { updated_at: updatedAt } : {}),
  };
  return {
    output: { resource, content, media_type: "application/json" },
    evidence: [
      receipt(ctx, resource.ref, ref.kind, { id: found["id"] ?? null, version: version ?? null }),
    ],
  };
}

// ---------------------------------------------------------------------------------------
// resource.search

interface Hit {
  ref: string;
  type: string;
  title?: string;
  snippet?: string;
}

const clip = (value: unknown, max: number) =>
  typeof value === "string" && value ? value.slice(0, max) : undefined;
const hit = (ref: string, type: string, title: unknown, snippet: unknown): Hit => ({
  ref,
  type,
  ...(clip(title, 500) ? { title: clip(title, 500)! } : {}),
  ...(clip(snippet, 2000) ? { snippet: clip(snippet, 2000)! } : {}),
});

export async function search(input: Json, ctx: HandlerContext, deps: Deps) {
  const type = (input["type"] as string | undefined) ?? "video";
  const filters = record(input["filters"]);
  const query = input["query"] as string | undefined;
  const allowed: Record<string, string[]> = {
    video: [],
    playlist: [],
    playlist_item: ["playlist"],
    comment: ["video", "parent", "moderation_status"],
  };
  if (!allowed[type])
    throw new ProviderFailure(
      `YouTube searches video, playlist, playlist_item and comment, not ${type}`,
    );
  for (const name of Object.keys(filters))
    if (!allowed[type]!.includes(name))
      throw new ProviderFailure(`${name} is not a filter of YouTube ${type} searches`);
  if (query !== undefined && (type === "playlist" || type === "playlist_item"))
    throw new ProviderFailure(
      `YouTube lists ${type.replace("_", " ")}s but cannot search them by text`,
    );
  const r = refs(deps);
  const page = {
    maxResults: Math.min((input["limit"] as number | undefined) ?? 25, 50),
    pageToken: input["cursor"] as string | undefined,
  };
  const call = (path: string, q: Record<string, string | number | boolean | undefined>) =>
    deps.client.call<{ items?: any[]; nextPageToken?: string }>(ctx, {
      path: `${V3}/${path}`,
      query: { ...q, ...page },
    });

  let items: Hit[];
  let next: string | undefined;
  if (type === "video" && query !== undefined) {
    const { body } = await call("search", {
      part: "snippet",
      forMine: true,
      type: "video",
      q: query,
    });
    items = (body?.items ?? []).map((i) =>
      hit(r.video(i.id?.videoId), "video", i.snippet?.title, i.snippet?.description),
    );
    next = body?.nextPageToken;
  } else if (type === "video") {
    const channel = await fetchOne(ctx, deps, "channels", deps.channel, "contentDetails");
    const uploads = channel?.["contentDetails"]?.["relatedPlaylists"]?.["uploads"];
    if (typeof uploads !== "string")
      throw new ProviderFailure("the YouTube channel has no uploads");
    const { body } = await call("playlistItems", { part: "snippet", playlistId: uploads });
    items = (body?.items ?? []).map((i) =>
      hit(
        r.video(i.snippet?.resourceId?.videoId),
        "video",
        i.snippet?.title,
        i.snippet?.description,
      ),
    );
    next = body?.nextPageToken;
  } else if (type === "playlist") {
    const { body } = await call("playlists", { part: "snippet", mine: true });
    items = (body?.items ?? []).map((i) =>
      hit(r.playlist(i.id), "playlist", i.snippet?.title, i.snippet?.description),
    );
    next = body?.nextPageToken;
  } else if (type === "playlist_item") {
    const playlist = resolve(deps.channel, filters["playlist"], ["playlist"], "filters.playlist");
    const { body } = await call("playlistItems", { part: "snippet", playlistId: playlist.id });
    items = (body?.items ?? []).map((i) =>
      hit(r.item(playlist.id, i.id), "playlist_item", i.snippet?.title, undefined),
    );
    next = body?.nextPageToken;
  } else {
    const moderation = filters["moderation_status"];
    if (filters["parent"] !== undefined) {
      refuseMembers(
        filters as Json,
        ["video", "moderation_status"],
        "cannot be combined with parent",
      );
      if (query !== undefined) throw new ProviderFailure("YouTube cannot search replies by text");
      const parent = resolve(deps.channel, filters["parent"], ["comment"], "filters.parent");
      const { body } = await call("comments", {
        part: "snippet",
        parentId: parent.id,
        textFormat: "plainText",
      });
      items = (body?.items ?? []).map((c) =>
        hit(
          r.comment(c.id),
          "comment",
          undefined,
          c.snippet?.textOriginal ?? c.snippet?.textDisplay,
        ),
      );
    } else {
      const video = resolve(deps.channel, filters["video"], ["video"], "filters.video");
      if (
        moderation !== undefined &&
        !["published", "held_for_review", "likely_spam"].includes(String(moderation))
      )
        throw new ProviderFailure(
          "filters.moderation_status must be published, held_for_review or likely_spam",
        );
      const { body } = await call("commentThreads", {
        part: "snippet",
        videoId: video.id,
        textFormat: "plainText",
        searchTerms: query,
        moderationStatus:
          moderation === undefined
            ? undefined
            : moderation === "likely_spam"
              ? "likelySpam"
              : MODERATION_TO_YOUTUBE[String(moderation)],
      });
      items = (body?.items ?? []).map((t) => {
        const top = t.snippet?.topLevelComment;
        return hit(
          r.comment(top?.id),
          "comment",
          undefined,
          top?.snippet?.textOriginal ?? top?.snippet?.textDisplay,
        );
      });
    }
    next = undefined;
  }
  return {
    output: { items, ...(next ? { next_cursor: next } : {}) },
    evidence: [ctx.evidence.providerReceipt(["execution"], { type, count: items.length })],
  };
}

// ---------------------------------------------------------------------------------------
// resource.create: playlists and playlist items

interface CreatePlan {
  kind: "playlist" | "playlist_item";
  playlist?: string;
  video?: string;
  snippet: Record<string, unknown>;
  status?: Record<string, unknown>;
}

function planCreate(input: Json, deps: Deps): CreatePlan {
  const type = input["type"];
  const content = input["content"];
  if (typeof content !== "object" || content === null || Array.isArray(content))
    throw new ProviderFailure("the content of a YouTube resource must be an object");
  const fields = { ...(content as Record<string, unknown>) };
  if (type === "playlist") {
    if (input["parent"] !== undefined)
      resolve(deps.channel, input["parent"], ["channel"], "the parent");
    if (fields["title"] === undefined && input["name"] !== undefined)
      fields["title"] = input["name"];
    if (fields["title"] === undefined)
      throw new ProviderFailure("a YouTube playlist needs a title");
    checkPatch(fields, PLAYLIST_FIELDS, "playlist");
    if (Object.values(fields).includes(null))
      throw new ProviderFailure("a new YouTube playlist has nothing to clear");
    const parts = applyPatch(
      { snippet: {}, status: { privacyStatus: deps.defaultPrivacy } },
      fields,
      PLAYLIST_FIELDS,
    );
    return { kind: "playlist", ...parts };
  }
  if (type === "playlist_item") {
    refuseMembers(input, ["name"], "is not used by YouTube playlist items");
    const playlist = resolve(deps.channel, input["parent"], ["playlist"], "the parent");
    for (const name of Object.keys(fields))
      if (name !== "video" && name !== "position")
        throw new ProviderFailure(
          `${name} is not a field of a YouTube playlist item (video, position)`,
        );
    const video = parseRef(fields["video"]);
    if (video?.kind !== "video")
      throw new ProviderFailure("content.video must be a YouTube video reference");
    const position = fields["position"];
    if (position !== undefined && !(Number.isInteger(position) && (position as number) >= 0))
      throw new ProviderFailure("content.position must be a non-negative integer");
    return {
      kind: "playlist_item",
      playlist: playlist.id,
      video: video.id,
      snippet: {
        playlistId: playlist.id,
        resourceId: { kind: "youtube#video", videoId: video.id },
        ...(position !== undefined ? { position } : {}),
      },
    };
  }
  throw new ProviderFailure("the YouTube adapter creates playlist and playlist_item resources");
}

function created(ctx: HandlerContext, deps: Deps, plan: CreatePlan, resource: Record<string, any>) {
  const ref =
    plan.kind === "playlist"
      ? refs(deps).playlist(resource["id"])
      : refs(deps).item(plan.playlist!, resource["id"]);
  const state = plan.kind === "playlist" ? playlistState(resource) : itemState(resource);
  const at = resource["snippet"]?.["publishedAt"];
  return {
    output: {
      resource: {
        ref,
        type: plan.kind,
        version: versionOf(state),
        created_at: typeof at === "string" ? at : ctx.now().toISOString(),
      },
    },
    ref,
    state,
  };
}

export async function create(input: Json, ctx: HandlerContext, deps: Deps) {
  const plan = planCreate(input, deps);
  const { body } = await deps.client.call<Record<string, any>>(ctx, {
    path: `${V3}/${plan.kind === "playlist" ? "playlists" : "playlistItems"}`,
    query: { part: plan.kind === "playlist" ? "snippet,status" : "snippet" },
    json: { snippet: plan.snippet, ...(plan.status ? { status: plan.status } : {}) } as Json,
  });
  if (typeof body?.["id"] !== "string")
    throw new Error("YouTube created the resource without naming it");
  const { output, ref, state } = created(ctx, deps, plan, body);
  return {
    output,
    evidence: [
      receipt(ctx, ref, plan.kind, {
        id: body["id"],
        published_at: body["snippet"]?.["publishedAt"] ?? null,
      }),
      observe(ctx, ["state"], ref, plan.kind, state),
    ],
  };
}

export const reconcileCreate = (input: Json, ctx: HandlerContext, deps: Deps): Promise<Outcome> =>
  reconciling(async () => {
    const plan = planCreate(input, deps);
    const candidates =
      plan.kind === "playlist"
        ? await fetchAll(ctx, deps, `${V3}/playlists`, { part: "snippet,status", mine: true })
        : await fetchAll(ctx, deps, `${V3}/playlistItems`, {
            part: "snippet",
            playlistId: plan.playlist,
          });
    if (!candidates)
      return { status: "inconclusive", reason: "too many YouTube resources to search" };
    const matches = candidates.filter((c) => {
      const s = c["snippet"] ?? {};
      if (!after(s["publishedAt"], ctx)) return false;
      if (plan.kind === "playlist_item") return s["resourceId"]?.["videoId"] === plan.video;
      return (
        s["title"] === plan.snippet["title"] &&
        (s["description"] ?? "") === (plan.snippet["description"] ?? "")
      );
    });
    if (matches.length > 1)
      return {
        status: "inconclusive",
        reason: `several YouTube ${plan.kind.replace("_", " ")}s match`,
      };
    if (matches.length === 1) {
      const { output, ref, state } = created(ctx, deps, plan, matches[0]!);
      return {
        status: "completed",
        output,
        evidence: [observe(ctx, ["execution", "state"], ref, plan.kind, state)],
      };
    }
    const container =
      plan.kind === "playlist"
        ? refOf({ kind: "channel", channel: deps.channel })
        : refs(deps).playlist(plan.playlist!);
    return notVisible(ctx, deps, `the ${plan.kind.replace("_", " ")} is not on YouTube`, () => [
      observe(ctx, ["state"], container, plan.kind === "playlist" ? "channel" : "playlist", {
        searched: candidates.length,
        found: false,
      }),
    ]);
  });

// ---------------------------------------------------------------------------------------
// resource.update: metadata, thumbnails and comment moderation

const ITEM_FIELDS = ["position"];
const COMMENT_FIELDS = ["text", "moderation_status", "ban_author"];

type UpdatePlan =
  | { kind: "video" | "playlist"; ref: Ref & { id: string }; patch: Record<string, unknown> }
  | { kind: "playlist_item"; ref: Extract<Ref, { kind: "playlist_item" }>; position: number }
  | {
      kind: "comment";
      ref: Ref & { id: string };
      text?: string;
      moderation?: string;
      banAuthor?: boolean;
    }
  | { kind: "thumbnail"; ref: Ref & { id: string }; uri: string; mediaType: string };

function planUpdate(input: Json, deps: Deps): UpdatePlan {
  const ref = resolve(deps.channel, input["resource"], [
    "video",
    "playlist",
    "playlist_item",
    "comment",
    "thumbnail",
  ]);
  const patch = input["patch"] as Record<string, unknown> | undefined;
  const content = input["content"];
  switch (ref.kind) {
    case "video":
      if (patch) checkPatch(patch, VIDEO_FIELDS, "video");
      return {
        kind: "video",
        ref,
        patch: patch ?? replacementPatch(content, VIDEO_FIELDS, ["title", "category_id"], "video"),
      };
    case "playlist":
      if (patch) checkPatch(patch, PLAYLIST_FIELDS, "playlist");
      return {
        kind: "playlist",
        ref,
        patch: patch ?? replacementPatch(content, PLAYLIST_FIELDS, ["title"], "playlist"),
      };
    case "playlist_item": {
      const fields = record(patch ?? content);
      for (const name of Object.keys(fields))
        if (!ITEM_FIELDS.includes(name))
          throw new ProviderFailure(
            `${name} is not an editable field of a YouTube playlist item (position)`,
          );
      const position = fields["position"];
      if (!(Number.isInteger(position) && (position as number) >= 0))
        throw new ProviderFailure("position must be a non-negative integer");
      return { kind: "playlist_item", ref, position: position as number };
    }
    case "comment": {
      const fields = typeof content === "string" ? { text: content } : record(patch ?? content);
      if (Object.keys(fields).length === 0)
        throw new ProviderFailure("the update of the comment changes nothing");
      for (const name of Object.keys(fields))
        if (!COMMENT_FIELDS.includes(name))
          throw new ProviderFailure(
            `${name} is not an editable field of a YouTube comment (${COMMENT_FIELDS.join(", ")})`,
          );
      const { text, moderation_status: moderation, ban_author: banAuthor } = fields;
      if (
        text !== undefined &&
        !(typeof text === "string" && text.length > 0 && text.length <= 10_000)
      )
        throw new ProviderFailure("text must be 1–10000 characters");
      if (
        moderation !== undefined &&
        !(typeof moderation === "string" && moderation in MODERATION_TO_YOUTUBE)
      )
        throw new ProviderFailure(
          "moderation_status must be published, held_for_review or rejected",
        );
      if (banAuthor !== undefined && !(typeof banAuthor === "boolean" && moderation === "rejected"))
        throw new ProviderFailure(
          "ban_author is a boolean that applies only with moderation_status rejected",
        );
      return {
        kind: "comment",
        ref,
        ...(text !== undefined ? { text: text as string } : {}),
        ...(moderation !== undefined ? { moderation: moderation as string } : {}),
        ...(banAuthor !== undefined ? { banAuthor: banAuthor as boolean } : {}),
      };
    }
    case "thumbnail": {
      if (patch)
        throw new ProviderFailure("a YouTube thumbnail is replaced with content, not patched");
      const fields = record(content);
      for (const name of Object.keys(fields))
        if (name !== "uri" && name !== "media_type")
          throw new ProviderFailure(
            `${name} is not a field of a YouTube thumbnail (uri, media_type)`,
          );
      if (typeof fields["uri"] !== "string" || !/^[a-z][a-z0-9+.-]*:\S+$/.test(fields["uri"]))
        throw new ProviderFailure("the thumbnail needs a uri");
      if (fields["media_type"] !== "image/jpeg" && fields["media_type"] !== "image/png")
        throw new ProviderFailure("a YouTube thumbnail is image/jpeg or image/png");
      return { kind: "thumbnail", ref, uri: fields["uri"], mediaType: fields["media_type"] };
    }
  }
}

async function readAll(
  body: Uint8Array | ReadableStream<Uint8Array>,
  limit: number,
): Promise<Uint8Array> {
  if (body instanceof Uint8Array) return body;
  const bytes = new Uint8Array(await new Response(body).arrayBuffer());
  if (bytes.length > limit) throw new ProviderFailure("a YouTube thumbnail is at most 2 MB");
  return bytes;
}

function updated(ctx: HandlerContext, plan: UpdatePlan, state: Json | undefined) {
  return {
    resource: {
      ref: refOf(plan.ref),
      ...(state ? { version: versionOf(state) } : {}),
      updated_at: ctx.now().toISOString(),
    },
  };
}

export async function update(input: Json, ctx: HandlerContext, deps: Deps) {
  const plan = planUpdate(input, deps);
  const ref = refOf(plan.ref);
  // YouTube cannot read held or rejected comments back, so moderation goes straight to
  // the moderation call unless a version must be checked first.
  const blind =
    plan.kind === "comment" && plan.text === undefined && input["expected_version"] === undefined;
  const current = blind ? {} : await load(ctx, deps, plan.ref, WRITE_PARTS[plan.kind]);
  if (!blind) checkVersion(plan.kind, current, input["expected_version"]);
  let answer: Record<string, any> | undefined;
  let state: Json;
  let observed = true;
  switch (plan.kind) {
    case "video":
    case "playlist": {
      const fields = plan.kind === "video" ? VIDEO_FIELDS : PLAYLIST_FIELDS;
      const writable = plan.kind === "video" ? writableVideo(current) : writablePlaylist(current);
      const parts = applyPatch(writable, plan.patch, fields);
      ({ body: answer } = await deps.client.call(ctx, {
        method: "PUT",
        path: `${V3}/${COLLECTION[plan.kind]}`,
        query: { part: "snippet,status" },
        json: { id: plan.ref.id, ...parts } as Json,
      }));
      state = plan.kind === "video" ? videoState(answer) : playlistState(answer);
      break;
    }
    case "playlist_item":
      ({ body: answer } = await deps.client.call(ctx, {
        method: "PUT",
        path: `${V3}/playlistItems`,
        query: { part: "snippet" },
        json: {
          id: plan.ref.id,
          snippet: {
            playlistId: plan.ref.playlist,
            resourceId: current["snippet"]?.["resourceId"],
            position: plan.position,
          },
        },
      }));
      state = itemState(answer);
      break;
    case "comment": {
      if (plan.text !== undefined)
        ({ body: answer } = await deps.client.call(ctx, {
          method: "PUT",
          path: `${V3}/comments`,
          query: { part: "snippet" },
          json: { id: plan.ref.id, snippet: { textOriginal: plan.text } },
        }));
      if (plan.moderation !== undefined) {
        await deps.client.call(ctx, {
          method: "POST",
          path: `${V3}/comments/setModerationStatus`,
          query: {
            id: plan.ref.id,
            moderationStatus: MODERATION_TO_YOUTUBE[plan.moderation],
            ...(plan.banAuthor !== undefined ? { banAuthor: plan.banAuthor } : {}),
          },
        });
        // Only published comments can be read back, so what YouTube shows is whether the
        // comment is public; that takes a moment to change, and is observed only once it has.
        const expected = plan.moderation === "published";
        observed = false;
        for (let attempt = 0; attempt < READ_BACK_TRIES && !observed; attempt++) {
          try {
            if (attempt > 0) await sleep(READ_BACK_PAUSE_MS, undefined, { signal: ctx.signal });
            answer = await fetchOne(ctx, deps, "comments", plan.ref.id, "snippet");
          } catch {
            break; // The moderation was confirmed; a failed read back only costs the observation.
          }
          observed = !!answer === expected;
        }
        if (!expected) answer = undefined;
      }
      state = answer ? { ...(commentState(answer) as Json), public: true } : { public: false };
      break;
    }
    case "thumbnail": {
      const source = await deps.open(plan.uri, ctx.signal);
      if (source.size > MAX_THUMBNAIL)
        throw new ProviderFailure("a YouTube thumbnail is at most 2 MB");
      const bytes = await readAll(source.body, MAX_THUMBNAIL);
      const { body } = await deps.client.call<{ items?: Record<string, unknown>[] }>(ctx, {
        path: "/upload/youtube/v3/thumbnails/set",
        query: { videoId: plan.ref.id, uploadType: "media" },
        bytes,
        headers: { "content-type": plan.mediaType },
      });
      answer = { snippet: { thumbnails: body?.items?.[0] ?? {} } };
      state = thumbnailState(answer);
      break;
    }
  }
  return {
    output: updated(ctx, plan, observed ? state : undefined),
    evidence: [
      receipt(ctx, ref, plan.ref.kind, { id: plan.ref.id }),
      ...(observed ? [observe(ctx, ["state"], ref, plan.ref.kind, state)] : []),
    ],
  };
}

export const reconcileUpdate = (input: Json, ctx: HandlerContext, deps: Deps): Promise<Outcome> =>
  reconciling(async () => {
    const plan = planUpdate(input, deps);
    const ref = refOf(plan.ref);
    if (plan.kind === "thumbnail")
      return {
        status: "inconclusive",
        reason: "YouTube does not tell which image a thumbnail was made from",
      };
    const current = await fetchOne(
      ctx,
      deps,
      COLLECTION[plan.kind],
      plan.ref.id,
      WRITE_PARTS[plan.kind],
    );
    let state: Json | undefined;
    let done: boolean;
    let pending: string[] = [];
    if ("patch" in plan) {
      const fields = plan.kind === "video" ? VIDEO_FIELDS : PLAYLIST_FIELDS;
      state = current && (plan.kind === "video" ? videoState(current) : playlistState(current));
      pending = Object.entries(plan.patch)
        .filter(
          ([name, value]) =>
            !state ||
            !jsonEqual(
              state[name],
              name === "tags"
                ? sortedTags(value)
                : value === null
                  ? (fields[name]!.cleared ?? null)
                  : value,
            ),
        )
        .map(([name]) => name);
      done = !!state && pending.length === 0;
    } else if (plan.kind === "playlist_item") {
      state = current && itemState(current);
      done = state?.["position"] === plan.position;
    } else {
      // YouTube shows no moderation status: a published comment is public, a held or
      // rejected one is not.
      state = current ? { ...(commentState(current) as Json), public: true } : { public: false };
      done =
        (plan.text === undefined || state["text"] === plan.text) &&
        (plan.moderation === undefined || state["public"] === (plan.moderation === "published"));
    }
    if (done && state)
      return {
        status: "completed",
        output: updated(ctx, plan, state),
        evidence: [observe(ctx, ["execution", "state"], ref, plan.ref.kind, state)],
      };
    const which = pending.length ? ` (${pending.join(", ")})` : "";
    return notVisible(
      ctx,
      deps,
      `the change to the ${NAMES[plan.kind]}${which} is not visible`,
      () => [observe(ctx, ["state"], ref, plan.ref.kind, state ?? { found: false })],
    );
  });

// ---------------------------------------------------------------------------------------
// resource.delete

export async function remove(input: Json, ctx: HandlerContext, deps: Deps) {
  const target = resolve(deps.channel, input["resource"], [
    "video",
    "playlist",
    "playlist_item",
    "comment",
  ]);
  const ref = refOf(target);
  if (input["expected_version"] !== undefined)
    checkVersion(target.kind, await load(ctx, deps, target), input["expected_version"]);
  else if (target.kind !== "comment") await load(ctx, deps, target, "snippet");
  const { status } = await deps.client.call(ctx, {
    method: "DELETE",
    path: `${V3}/${COLLECTION[target.kind]}`,
    query: { id: target.id },
  });
  const evidence = [receipt(ctx, ref, target.kind, { id: target.id, status })];
  // Deletion takes a moment to show on YouTube; observe it only once it does.
  for (let attempt = 0; attempt < READ_BACK_TRIES; attempt++) {
    try {
      if (attempt > 0) await sleep(READ_BACK_PAUSE_MS, undefined, { signal: ctx.signal });
      if (!(await fetchOne(ctx, deps, COLLECTION[target.kind], target.id, "id"))) {
        evidence.push(observe(ctx, ["state"], ref, target.kind, { found: false }));
        break;
      }
    } catch {
      // The deletion was confirmed; a failed read back only costs the observation.
      break;
    }
  }
  return { output: { resource: { ref }, deleted_at: ctx.now().toISOString() }, evidence };
}

export const reconcileDelete = (input: Json, ctx: HandlerContext, deps: Deps): Promise<Outcome> =>
  reconciling(async () => {
    const target = resolve(deps.channel, input["resource"], [
      "video",
      "playlist",
      "playlist_item",
      "comment",
    ]);
    const ref = refOf(target);
    const found = await fetchOne(ctx, deps, COLLECTION[target.kind], target.id, "id");
    if (!found)
      return {
        status: "completed",
        output: { resource: { ref }, deleted_at: ctx.now().toISOString() },
        evidence: [observe(ctx, ["execution", "state"], ref, target.kind, { found: false })],
      };
    return notVisible(ctx, deps, `the ${NAMES[target.kind]} is still on YouTube`, () => [
      observe(ctx, ["state"], ref, target.kind, { found: true }),
    ]);
  });
