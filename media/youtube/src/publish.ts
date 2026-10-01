import { ProviderFailure, type HandlerContext, type Json } from "@runtime-protocol/sdk";
import { parseRef, refOf, resolve } from "./refs.ts";
import {
  after,
  fetchAll,
  fetchOne,
  keyOf,
  notVisible,
  observe,
  receipt,
  reconciling,
  record,
  refuseMembers,
  type Deps,
  type Outcome,
} from "./shared.ts";
import { load } from "./resources.ts";
import { markerOf, uploadVideo } from "./upload.ts";
import { applyPatch, checkUploadData, commentState, VIDEO_FIELDS, videoState } from "./views.ts";

/**
 * A publication to the channel is a video upload (broadcast); one on a video or in a
 * comment thread is a comment (chat).
 */
function modeOf(input: Json, ctx: HandlerContext): "upload" | "comment" {
  const kind = parseRef(input["audience"])?.kind;
  const profile = ctx.profile ?? (kind === "channel" ? "broadcast" : "chat");
  if (profile === "broadcast") return "upload";
  if (profile === "chat") return "comment";
  throw new ProviderFailure(
    `YouTube publishes with the broadcast and chat profiles, not ${profile}`,
  );
}

// ---------------------------------------------------------------------------------------
// Uploads

interface UploadPlan {
  metadata: Json;
  notifySubscribers?: boolean;
  uri: string;
  mediaType: string;
  size?: number;
  digest?: string;
}

function planUpload(input: Json, ctx: HandlerContext, deps: Deps): UploadPlan {
  resolve(deps.channel, input["audience"], ["channel"], "the audience of an upload");
  refuseMembers(input, ["thread"], "has no meaning for a YouTube upload");
  refuseMembers(input, ["rich_content"], "is not supported: a YouTube description is plain text");
  const attachments = (input["attachments"] as Array<Record<string, unknown>> | undefined) ?? [];
  if (attachments.length !== 1)
    throw new ProviderFailure("a YouTube upload takes exactly one video attachment");
  const file = attachments[0]!;
  const mediaType = String(file["media_type"]);
  if (!mediaType.startsWith("video/"))
    throw new ProviderFailure("the attachment of a YouTube upload must be a video");
  const data = checkUploadData(input["data"]);
  const { notify_subscribers: notify, ...settings } = data;
  const fields: Record<string, unknown> = {
    title: input["title"],
    description: input["content"] ?? "",
    category_id: deps.defaultCategory,
    privacy_status: deps.defaultPrivacy,
    ...settings,
  };
  if (typeof fields["title"] !== "string")
    throw new ProviderFailure("a YouTube upload needs a title");
  for (const name of ["title", "description"])
    if (!VIDEO_FIELDS[name]!.check(fields[name]))
      throw new ProviderFailure(
        `the ${name} of a YouTube video must be ${VIDEO_FIELDS[name]!.expected}`,
      );
  const parts = applyPatch({ snippet: {}, status: {} }, fields, VIDEO_FIELDS);
  parts.snippet["tags"] = [
    ...((parts.snippet["tags"] as string[] | undefined) ?? []),
    markerOf(keyOf(ctx)),
  ];
  return {
    metadata: parts as Json,
    ...(notify !== undefined ? { notifySubscribers: notify as boolean } : {}),
    uri: String(file["uri"]),
    mediaType,
    ...(typeof file["size"] === "number" ? { size: file["size"] } : {}),
    ...(typeof file["digest"] === "string" ? { digest: file["digest"] } : {}),
  };
}

const videoRef = (deps: Deps, id: string) => refOf({ kind: "video", channel: deps.channel, id });

function published(ctx: HandlerContext, ref: string, at: unknown) {
  return {
    publication: { ref, published_at: typeof at === "string" ? at : ctx.now().toISOString() },
  };
}

async function upload(input: Json, ctx: HandlerContext, deps: Deps) {
  const plan = planUpload(input, ctx, deps);
  const source = await deps.open(plan.uri, ctx.signal);
  if (plan.size !== undefined && plan.size !== source.size)
    throw new ProviderFailure("the attachment does not have its declared size");
  const video = await uploadVideo(ctx, deps.client, {
    metadata: plan.metadata,
    ...(plan.notifySubscribers !== undefined ? { notifySubscribers: plan.notifySubscribers } : {}),
    source,
    mediaType: plan.mediaType,
    ...(plan.digest ? { digest: plan.digest } : {}),
    chunkSize: deps.chunkSize,
  });
  const ref = videoRef(deps, video["id"] as string);
  const status = record(video["status"]);
  return {
    output: published(ctx, ref, record(video["snippet"])["publishedAt"]),
    evidence: [
      receipt(ctx, ref, "video", {
        id: video["id"] as string,
        upload_status: status["uploadStatus"] ?? null,
        bytes: source.size,
      }),
      observe(ctx, ["state"], ref, "video", {
        ...(videoState(video) as Record<string, unknown>),
        upload_status: status["uploadStatus"] ?? null,
      }),
    ],
  };
}

/** Finds the upload by its marker tag among the channel's recent uploads. */
const reconcileUpload = (input: Json, ctx: HandlerContext, deps: Deps): Promise<Outcome> =>
  reconciling(async () => {
    planUpload(input, ctx, deps);
    const marker = markerOf(keyOf(ctx));
    const channel = await fetchOne(ctx, deps, "channels", deps.channel, "contentDetails");
    const uploads = channel?.["contentDetails"]?.["relatedPlaylists"]?.["uploads"];
    if (typeof uploads !== "string")
      return { status: "inconclusive", reason: "the uploads of the channel could not be read" };
    // Uploads are listed newest first: read back until they predate the invocation.
    const items = await fetchAll(
      ctx,
      deps,
      "/youtube/v3/playlistItems",
      { part: "snippet,contentDetails", playlistId: uploads },
      { enough: (all) => !after(all.at(-1)?.["snippet"]?.["publishedAt"], ctx) },
    );
    if (!items) return { status: "inconclusive", reason: "too many recent uploads to search" };
    const ids = items
      .filter((i) => after(i["snippet"]?.["publishedAt"], ctx))
      .map((i) => i["contentDetails"]?.["videoId"])
      .filter((id): id is string => typeof id === "string");
    let video: Record<string, any> | undefined;
    for (let at = 0; at < ids.length && !video; at += 50) {
      const { body: videos } = await deps.client.call<{ items?: any[] }>(ctx, {
        path: "/youtube/v3/videos",
        query: { part: "snippet,status", id: ids.slice(at, at + 50).join(",") },
      });
      video = (videos?.items ?? []).find((v) => (v?.snippet?.tags ?? []).includes(marker));
    }
    if (video) {
      const ref = videoRef(deps, video["id"]);
      return {
        status: "completed",
        output: published(ctx, ref, video["snippet"]?.["publishedAt"]),
        evidence: [
          observe(ctx, ["execution", "state"], ref, "video", {
            ...(videoState(video) as Record<string, unknown>),
            upload_status: video["status"]?.["uploadStatus"] ?? null,
          }),
        ],
      };
    }
    return notVisible(ctx, deps, "no recent upload carries the invocation's marker", () => [
      observe(
        ctx,
        ["state"],
        refOf({ kind: "playlist", channel: deps.channel, id: uploads }),
        "playlist",
        {
          searched: ids.length,
          found: false,
        },
      ),
    ]);
  });

// ---------------------------------------------------------------------------------------
// Comments and replies

interface CommentPlan {
  video: string;
  parent?: string;
  text: string;
}

/**
 * A comment is a message in a thread: the video's (`thread` is the video) or a top-level
 * comment's (`thread` is that comment, a reply). The audience is the video either way.
 */
function planComment(input: Json, deps: Deps): CommentPlan {
  const video = resolve(deps.channel, input["audience"], ["video"], "the audience of a comment");
  refuseMembers(input, ["title"], "has no place in a YouTube comment");
  refuseMembers(input, ["attachments"], "cannot be attached to a YouTube comment");
  refuseMembers(
    input,
    ["data", "rich_content"],
    "is not supported: a YouTube comment is plain text",
  );
  const text = input["content"];
  if (!(typeof text === "string" && text.length > 0 && text.length <= 10_000))
    throw new ProviderFailure("a YouTube comment is 1–10000 characters of content");
  if (input["thread"] === undefined)
    throw new ProviderFailure(
      "a YouTube comment needs a thread: the video to comment on, or the comment to reply to",
    );
  const thread = resolve(deps.channel, input["thread"], ["video", "comment"], "the thread");
  if (thread.kind === "video") {
    if (thread.id !== video.id)
      throw new ProviderFailure("the thread of a comment is the video it is posted on");
    return { video: video.id, text };
  }
  if (thread.video !== video.id)
    throw new ProviderFailure("the comment replied to is not on the audience video");
  if (thread.id.includes("."))
    throw new ProviderFailure("YouTube replies go to top-level comments");
  return { video: video.id, parent: thread.id, text };
}

const commentRef = (deps: Deps, video: string, id: string) =>
  refOf({ kind: "comment", channel: deps.channel, video, id });

async function comment(input: Json, ctx: HandlerContext, deps: Deps) {
  const plan = planComment(input, deps);
  // YouTube lets anyone comment anywhere: post only where the channel owns the video, and
  // reply only to a comment that is on it.
  if (plan.parent)
    await load(ctx, deps, {
      kind: "comment",
      channel: deps.channel,
      video: plan.video,
      id: plan.parent,
    });
  else await load(ctx, deps, { kind: "video", channel: deps.channel, id: plan.video }, "snippet");
  let posted: Record<string, any>;
  if (plan.parent) {
    ({ body: posted } = await deps.client.call(ctx, {
      path: "/youtube/v3/comments",
      query: { part: "snippet" },
      json: { snippet: { parentId: plan.parent, textOriginal: plan.text } },
    }));
  } else {
    const { body } = await deps.client.call<Record<string, any>>(ctx, {
      path: "/youtube/v3/commentThreads",
      query: { part: "snippet" },
      json: {
        snippet: { videoId: plan.video, topLevelComment: { snippet: { textOriginal: plan.text } } },
      },
    });
    posted = record(body?.["snippet"]?.["topLevelComment"]);
  }
  if (typeof posted?.["id"] !== "string")
    throw new Error("YouTube posted the comment without naming it");
  const ref = commentRef(deps, plan.video, posted["id"]);
  const at = posted["snippet"]?.["publishedAt"];
  return {
    output: published(ctx, ref, at),
    evidence: [
      receipt(ctx, ref, "comment", { id: posted["id"], published_at: at ?? null }),
      observe(ctx, ["state"], ref, "comment", commentState(posted)),
    ],
  };
}

/** Finds the channel's own comment with the same text, posted since the invocation could. */
const reconcileComment = (input: Json, ctx: HandlerContext, deps: Deps): Promise<Outcome> =>
  reconciling(async () => {
    const plan = planComment(input, deps);
    const older = (items: Record<string, any>[]) => {
      const last = items.at(-1);
      const at = (last?.["snippet"]?.["topLevelComment"] ?? last)?.["snippet"]?.["publishedAt"];
      return typeof at === "string" && !after(at, ctx);
    };
    const comments = plan.parent
      ? await fetchAll(ctx, deps, "/youtube/v3/comments", {
          part: "snippet",
          parentId: plan.parent,
          textFormat: "plainText",
        })
      : (
          await fetchAll(
            ctx,
            deps,
            "/youtube/v3/commentThreads",
            { part: "snippet", videoId: plan.video, order: "time", textFormat: "plainText" },
            { enough: older },
          )
        )?.map((t) => record(t["snippet"]?.["topLevelComment"]));
    if (!comments) return { status: "inconclusive", reason: "too many comments to search" };
    const matches = comments.filter((c) => {
      const s = c["snippet"] ?? {};
      return (
        s["authorChannelId"]?.["value"] === deps.channel &&
        (s["textOriginal"] ?? s["textDisplay"]) === plan.text &&
        after(s["publishedAt"], ctx)
      );
    });
    if (matches.length > 1)
      return { status: "inconclusive", reason: "several identical comments match" };
    if (matches.length === 1) {
      const found = matches[0]!;
      const ref = commentRef(deps, plan.video, found["id"]);
      return {
        status: "completed",
        output: published(ctx, ref, found["snippet"]?.["publishedAt"]),
        evidence: [observe(ctx, ["execution", "state"], ref, "comment", commentState(found))],
      };
    }
    const where = plan.parent
      ? commentRef(deps, plan.video, plan.parent)
      : videoRef(deps, plan.video);
    return notVisible(ctx, deps, "the comment is not on YouTube", () => [
      observe(ctx, ["state"], where, plan.parent ? "comment" : "video", {
        searched: comments.length,
        found: false,
      }),
    ]);
  });

export const publish = (input: Json, ctx: HandlerContext, deps: Deps) =>
  modeOf(input, ctx) === "upload" ? upload(input, ctx, deps) : comment(input, ctx, deps);

export const reconcilePublish = (input: Json, ctx: HandlerContext, deps: Deps): Promise<Outcome> =>
  reconciling(() =>
    modeOf(input, ctx) === "upload"
      ? reconcileUpload(input, ctx, deps)
      : reconcileComment(input, ctx, deps),
  );
