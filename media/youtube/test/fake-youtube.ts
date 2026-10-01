import { createHash } from "node:crypto";
import { fakeApi, type FakeAnswer, type FakeRequest } from "../../../testing/fake-api.ts";

export const CHANNEL = "UCcreator";
export const UPLOADS = "UUcreator";
export const CHANNEL_REF = `resource://youtube/${CHANNEL}`;
export const ACCESS = "canary-youtube-access-7f3a";
export const KEY = { ref: "secret://organization/providers/youtube", value: ACCESS };
export const GRANT = {
  client_id: "client-123.apps.googleusercontent.com",
  client_secret: "canary-client-secret-91b2",
  refresh_token: "canary-refresh-token-c4d8",
};
export const GRANT_KEY = { ref: KEY.ref, value: JSON.stringify(GRANT) };

/** Seeded state: a video with a viewer's comment, and a playlist holding that video. */
export const SEED = {
  video: "seedVideo01",
  comment: "UgSeedComment",
  playlist: "PLseed",
  item: "PLIseed1",
  spare: "PLIseed2",
};
export const ref = {
  video: (id: string) => `${CHANNEL_REF}/videos/${id}`,
  thumbnail: (id: string) => `${CHANNEL_REF}/videos/${id}/thumbnail`,
  comment: (video: string, id: string) => `${CHANNEL_REF}/videos/${video}/comments/${id}`,
  playlist: (id: string) => `${CHANNEL_REF}/playlists/${id}`,
  item: (playlist: string, id: string) => `${CHANNEL_REF}/playlists/${playlist}/items/${id}`,
};

/** Another channel's video, with a viewer's comment: out of the adapter's reach. */
export const FOREIGN = {
  channel: "UCsomeoneelse",
  video: "otherVideo1",
  comment: "UgOtherComment",
};

/** A 600 KiB clip: three chunks of 256 KiB. */
export const CLIP = Uint8Array.from({ length: 600 * 1024 }, (_, i) => i % 251);
export const CLIP_DIGEST = `sha256:${createHash("sha256").update(CLIP).digest("hex")}`;
export const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

/** What a test may do to one request: answer instead of the API, or change its answer after the effect. */
export interface Override {
  before?: FakeAnswer;
  after?: Partial<FakeAnswer>;
}

const API = "https://www.googleapis.com";
const OAUTH = "https://oauth2.googleapis.com";
const MEDIA = "https://media.example.com";

type Item = Record<string, any>;

const error = (status: number, reason: string, message: string): FakeAnswer => ({
  status,
  body: { error: { code: status, message, errors: [{ reason, message }] } },
});
const notFound = (what: string) => error(404, `${what}NotFound`, `The ${what} was not found.`);

/** A YouTube channel with the Data API, resumable uploads, Google OAuth and a media host. */
export function youtube(
  options: {
    delayMs?: number;
    override?: (request: FakeRequest) => Override | undefined;
    /** The channel the access token manages; defaults to CHANNEL. */
    mine?: string;
  } = {},
) {
  const videos = new Map<string, Item>();
  const uploads: string[] = [];
  const comments = new Map<string, Item>();
  const playlists = new Map<string, Item>();
  const items = new Map<string, Item>();
  const sessions = new Map<string, { metadata: Item; size: number; received: number }>();
  const thumbnails = new Map<string, Uint8Array>();
  let counter = 0;
  const next = (prefix: string) => `${prefix}${String(++counter).padStart(6, "0")}`;
  const now = () => new Date().toISOString();
  const query = (r: FakeRequest, name: string) => r.url.searchParams.get(name) ?? undefined;

  const respond =
    (effect: (r: FakeRequest, m: RegExpMatchArray) => FakeAnswer) =>
    (r: FakeRequest, m: RegExpMatchArray): FakeAnswer => {
      if (r.headers.get("authorization") !== `Bearer ${ACCESS}`)
        return error(401, "authError", "Request had invalid authentication credentials.");
      const override = options.override?.(r);
      if (override?.before) return override.before;
      return {
        ...effect(r, m),
        ...(options.delayMs ? { delayMs: options.delayMs } : {}),
        ...override?.after,
      };
    };
  const page = (r: FakeRequest, all: Item[]): FakeAnswer => {
    const max = Number(query(r, "maxResults") ?? 5);
    const start = Number(query(r, "pageToken") ?? 0);
    const end = start + max;
    return {
      body: {
        items: all.slice(start, end),
        ...(end < all.length ? { nextPageToken: String(end) } : {}),
      },
    };
  };
  const byIds = (r: FakeRequest, from: Map<string, Item>) =>
    (query(r, "id") ?? "")
      .split(",")
      .map((id) => from.get(id))
      .filter((i): i is Item => !!i);
  const thread = (c: Item) => ({
    id: c["id"],
    snippet: {
      videoId: c["snippet"]["videoId"],
      topLevelComment: c,
      totalReplyCount: [...comments.values()].filter((r) => r["snippet"]["parentId"] === c["id"])
        .length,
    },
  });
  const comment = (fields: Item, author = CHANNEL): Item => ({
    id: fields["id"],
    snippet: {
      authorDisplayName: author === CHANNEL ? "Creator" : "Viewer",
      authorChannelId: { value: author },
      likeCount: 0,
      publishedAt: now(),
      updatedAt: now(),
      moderationStatus: "published",
      ...fields["snippet"],
      textDisplay: fields["snippet"]["textOriginal"],
    },
  });
  const uploadItems = () =>
    uploads.map((videoId) => ({
      id: `UP${videoId}`,
      snippet: {
        playlistId: UPLOADS,
        title: videos.get(videoId)!["snippet"]["title"],
        description: videos.get(videoId)!["snippet"]["description"],
        publishedAt: videos.get(videoId)!["snippet"]["publishedAt"],
        resourceId: { kind: "youtube#video", videoId },
      },
      contentDetails: { videoId },
    }));
  const playlistItems = (playlistId: string) =>
    [...items.values()]
      .filter((i) => i["snippet"]["playlistId"] === playlistId)
      .sort((a, b) => a["snippet"]["position"] - b["snippet"]["position"]);
  const renumber = (playlistId: string) =>
    playlistItems(playlistId).forEach((i, position) => (i["snippet"]["position"] = position));

  // Seed.
  videos.set(SEED.video, {
    id: SEED.video,
    snippet: {
      channelId: CHANNEL,
      title: "Seed video",
      description: "The first video.",
      tags: ["seed"],
      categoryId: "22",
      publishedAt: "2026-01-01T00:00:00Z",
      thumbnails: {
        default: {
          url: `https://i.ytimg.com/vi/${SEED.video}/default.jpg`,
          width: 120,
          height: 90,
        },
      },
    },
    status: {
      privacyStatus: "public",
      uploadStatus: "processed",
      embeddable: true,
      license: "youtube",
    },
    statistics: { viewCount: "1500", likeCount: "90", commentCount: "1", favoriteCount: "0" },
    contentDetails: { duration: "PT4M13S" },
  });
  uploads.push(SEED.video);
  videos.set(FOREIGN.video, {
    id: FOREIGN.video,
    snippet: {
      channelId: FOREIGN.channel,
      title: "Someone else's video",
      description: "",
      categoryId: "22",
      publishedAt: "2026-01-01T00:00:00Z",
    },
    status: { privacyStatus: "public", uploadStatus: "processed" },
  });
  comments.set(
    FOREIGN.comment,
    comment(
      {
        id: FOREIGN.comment,
        snippet: {
          videoId: FOREIGN.video,
          textOriginal: "Hi",
          publishedAt: "2026-01-02T00:00:00Z",
        },
      },
      "UCviewer",
    ),
  );
  comments.set(
    SEED.comment,
    comment(
      {
        id: SEED.comment,
        snippet: {
          videoId: SEED.video,
          textOriginal: "Great video!",
          publishedAt: "2026-01-02T00:00:00Z",
        },
      },
      "UCviewer",
    ),
  );
  playlists.set(SEED.playlist, {
    id: SEED.playlist,
    snippet: {
      channelId: CHANNEL,
      title: "Seeds",
      description: "",
      publishedAt: "2026-01-01T00:00:00Z",
    },
    status: { privacyStatus: "public" },
  });
  for (const [id, position] of [
    [SEED.item, 0],
    [SEED.spare, 1],
  ] as const)
    items.set(id, {
      id,
      snippet: {
        playlistId: SEED.playlist,
        title: "Seed video",
        position,
        publishedAt: "2026-01-01T00:00:00Z",
        resourceId: { kind: "youtube#video", videoId: SEED.video },
      },
      contentDetails: { videoId: SEED.video },
    });

  const api = fakeApi(API, [
    [
      "GET",
      "/youtube/v3/channels",
      respond((r) => ({
        body: {
          items:
            query(r, "mine") === "true"
              ? [{ id: options.mine ?? CHANNEL }]
              : query(r, "id") === CHANNEL
                ? [
                    {
                      id: CHANNEL,
                      snippet: {
                        title: "Creator",
                        description: "Videos.",
                        customUrl: "@creator",
                        publishedAt: "2020-01-01T00:00:00Z",
                      },
                      statistics: {
                        subscriberCount: "1200",
                        viewCount: "50000",
                        videoCount: String(videos.size),
                      },
                      contentDetails: { relatedPlaylists: { uploads: UPLOADS } },
                    },
                  ]
                : [],
        },
      })),
    ],
    ["GET", "/youtube/v3/videos", respond((r) => ({ body: { items: byIds(r, videos) } }))],
    [
      "PUT",
      "/youtube/v3/videos",
      respond((r) => {
        const video = videos.get(r.body.id);
        if (!video) return notFound("video");
        const { snippet, status } = r.body;
        if (!snippet?.title || !snippet?.categoryId)
          return error(400, "invalidVideoMetadata", "The request metadata is invalid.");
        video["snippet"] = {
          channelId: CHANNEL,
          publishedAt: video["snippet"]["publishedAt"],
          thumbnails: video["snippet"]["thumbnails"],
          ...snippet,
          tags: [...(snippet.tags ?? [])].sort(),
        };
        video["status"] = { uploadStatus: video["status"]["uploadStatus"], ...status };
        return { body: video };
      }),
    ],
    [
      "DELETE",
      "/youtube/v3/videos",
      respond((r) => {
        const id = query(r, "id")!;
        if (!videos.delete(id)) return notFound("video");
        uploads.splice(uploads.indexOf(id), 1);
        return { status: 204, raw: null };
      }),
    ],
    [
      "POST",
      "/upload/youtube/v3/videos",
      respond((r) => {
        if (query(r, "uploadType") !== "resumable")
          return error(400, "badRequest", "Resumable only.");
        const size = Number(r.headers.get("x-upload-content-length"));
        const id = next("session");
        sessions.set(id, { metadata: r.body, size, received: 0 });
        return {
          raw: null,
          headers: {
            location: `${API}/upload/youtube/v3/videos?uploadType=resumable&upload_id=${id}`,
          },
        };
      }),
    ],
    [
      "PUT",
      "/upload/youtube/v3/videos",
      respond((r) => {
        const session = sessions.get(query(r, "upload_id") ?? "");
        if (!session) return notFound("uploadSession");
        const held = () =>
          session.received > 0 ? { headers: { range: `bytes=0-${session.received - 1}` } } : {};
        const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(r.headers.get("content-range") ?? "");
        if (!range) return { status: 308, raw: null, ...held() };
        const [start, end] = [Number(range[1]), Number(range[2])];
        if (start !== session.received || end - start + 1 !== r.bytes?.length)
          return { status: 308, raw: null, ...held() };
        session.received = end + 1;
        if (session.received < session.size) return { status: 308, raw: null, ...held() };
        const id = next("vid");
        videos.set(id, {
          id,
          snippet: {
            ...session.metadata["snippet"],
            // YouTube keeps tags sorted.
            tags: [...(session.metadata["snippet"]["tags"] ?? [])].sort(),
            channelId: CHANNEL,
            publishedAt: now(),
            thumbnails: {
              default: { url: `https://i.ytimg.com/vi/${id}/default.jpg`, width: 120, height: 90 },
            },
          },
          status: { ...session.metadata["status"], uploadStatus: "uploaded" },
          statistics: { viewCount: "0", likeCount: "0", commentCount: "0", favoriteCount: "0" },
          contentDetails: { duration: "PT0S" },
        });
        uploads.unshift(id);
        sessions.delete(query(r, "upload_id")!);
        return { body: videos.get(id) };
      }),
    ],
    [
      "POST",
      "/upload/youtube/v3/thumbnails/set",
      respond((r) => {
        const video = videos.get(query(r, "videoId") ?? "");
        if (!video) return notFound("video");
        thumbnails.set(video["id"], r.bytes ?? new Uint8Array());
        const version = thumbnails.size;
        video["snippet"]["thumbnails"] = {
          default: {
            url: `https://i.ytimg.com/vi/${video["id"]}/custom${version}.jpg`,
            width: 120,
            height: 90,
          },
          high: {
            url: `https://i.ytimg.com/vi/${video["id"]}/custom${version}-hq.jpg`,
            width: 480,
            height: 360,
          },
        };
        return { body: { items: [video["snippet"]["thumbnails"]] } };
      }),
    ],
    [
      "GET",
      "/youtube/v3/playlistItems",
      respond((r) => {
        const playlistId = query(r, "playlistId");
        if (playlistId === UPLOADS) return page(r, uploadItems());
        if (playlistId)
          return playlists.has(playlistId)
            ? page(r, playlistItems(playlistId))
            : notFound("playlist");
        return { body: { items: byIds(r, items) } };
      }),
    ],
    [
      "POST",
      "/youtube/v3/playlistItems",
      respond((r) => {
        const { playlistId, resourceId, position } = r.body.snippet;
        if (!playlists.has(playlistId)) return notFound("playlist");
        if (!videos.has(resourceId?.videoId)) return notFound("video");
        const id = next("PLI");
        const count = playlistItems(playlistId).length;
        items.set(id, {
          id,
          snippet: {
            playlistId,
            resourceId,
            title: videos.get(resourceId.videoId)!["snippet"]["title"],
            position: position ?? count,
            publishedAt: now(),
          },
          contentDetails: { videoId: resourceId.videoId },
        });
        if (position !== undefined)
          for (const other of playlistItems(playlistId))
            if (other["id"] !== id && other["snippet"]["position"] >= position)
              other["snippet"]["position"]++;
        renumber(playlistId);
        return { body: items.get(id) };
      }),
    ],
    [
      "PUT",
      "/youtube/v3/playlistItems",
      respond((r) => {
        const item = items.get(r.body.id);
        if (!item) return notFound("playlistItem");
        const playlistId = item["snippet"]["playlistId"];
        const ordered = playlistItems(playlistId).filter((i) => i !== item);
        ordered.splice(r.body.snippet.position, 0, item);
        ordered.forEach((i, position) => (i["snippet"]["position"] = position));
        return { body: item };
      }),
    ],
    [
      "DELETE",
      "/youtube/v3/playlistItems",
      respond((r) => {
        const item = items.get(query(r, "id")!);
        if (!item) return notFound("playlistItem");
        items.delete(item["id"]);
        renumber(item["snippet"]["playlistId"]);
        return { status: 204, raw: null };
      }),
    ],
    [
      "GET",
      "/youtube/v3/playlists",
      respond((r) => {
        const withCount = (p: Item) => ({
          ...p,
          contentDetails: { itemCount: playlistItems(p["id"]).length },
        });
        if (query(r, "mine") === "true") return page(r, [...playlists.values()].map(withCount));
        return { body: { items: byIds(r, playlists).map(withCount) } };
      }),
    ],
    [
      "POST",
      "/youtube/v3/playlists",
      respond((r) => {
        const id = next("PL");
        playlists.set(id, {
          id,
          snippet: { channelId: CHANNEL, description: "", ...r.body.snippet, publishedAt: now() },
          status: { privacyStatus: "public", ...r.body.status },
        });
        return { body: playlists.get(id) };
      }),
    ],
    [
      "PUT",
      "/youtube/v3/playlists",
      respond((r) => {
        const playlist = playlists.get(r.body.id);
        if (!playlist) return notFound("playlist");
        playlist["snippet"] = {
          channelId: CHANNEL,
          publishedAt: playlist["snippet"]["publishedAt"],
          ...r.body.snippet,
        };
        playlist["status"] = { ...r.body.status };
        return { body: playlist };
      }),
    ],
    [
      "DELETE",
      "/youtube/v3/playlists",
      respond((r) =>
        playlists.delete(query(r, "id")!) ? { status: 204, raw: null } : notFound("playlist"),
      ),
    ],
    [
      "GET",
      "/youtube/v3/commentThreads",
      respond((r) => {
        if (query(r, "id"))
          return {
            body: {
              items: byIds(r, comments)
                .filter((c) => !c["snippet"]["parentId"])
                .filter((c) => c["snippet"]["moderationStatus"] === "published")
                .map(thread),
            },
          };
        const videoId = query(r, "videoId");
        if (!videos.has(videoId ?? "")) return notFound("video");
        const moderation = query(r, "moderationStatus") ?? "published";
        const terms = query(r, "searchTerms");
        const top = [...comments.values()]
          .filter((c) => c["snippet"]["videoId"] === videoId && !c["snippet"]["parentId"])
          .filter((c) => c["snippet"]["moderationStatus"] === moderation)
          .filter((c) => !terms || c["snippet"]["textOriginal"].includes(terms))
          .sort((a, b) => b["snippet"]["publishedAt"].localeCompare(a["snippet"]["publishedAt"]));
        return page(r, top.map(thread));
      }),
    ],
    [
      "POST",
      "/youtube/v3/commentThreads",
      respond((r) => {
        const { videoId, topLevelComment } = r.body.snippet;
        if (!videos.has(videoId)) return notFound("video");
        const created = comment({
          id: next("Ug"),
          snippet: { videoId, ...topLevelComment.snippet },
        });
        comments.set(created["id"], created);
        return { body: thread(created) };
      }),
    ],
    [
      "GET",
      "/youtube/v3/comments",
      respond((r) => {
        const parentId = query(r, "parentId");
        // Like YouTube: only published comments, and without their moderation status.
        const visible = (all: Item[]) =>
          all
            .filter((c) => c["snippet"]["moderationStatus"] === "published")
            .map((c) => {
              const { moderationStatus: _, ...snippet } = c["snippet"];
              return { ...c, snippet };
            });
        if (parentId)
          return page(
            r,
            visible([...comments.values()].filter((c) => c["snippet"]["parentId"] === parentId)),
          );
        return { body: { items: visible(byIds(r, comments)) } };
      }),
    ],
    [
      "POST",
      "/youtube/v3/comments",
      respond((r) => {
        const { parentId, textOriginal } = r.body.snippet;
        const parent = comments.get(parentId);
        if (!parent) return notFound("comment");
        const created = comment({
          id: next(`${parentId}.r`),
          snippet: { parentId, textOriginal, videoId: parent["snippet"]["videoId"] },
        });
        comments.set(created["id"], created);
        return { body: created };
      }),
    ],
    [
      "PUT",
      "/youtube/v3/comments",
      respond((r) => {
        const target = comments.get(r.body.id);
        if (!target) return notFound("comment");
        if (target["snippet"]["authorChannelId"]["value"] !== CHANNEL)
          return error(403, "forbidden", "The comment could not be updated.");
        target["snippet"]["textOriginal"] = target["snippet"]["textDisplay"] =
          r.body.snippet.textOriginal;
        target["snippet"]["updatedAt"] = now();
        return { body: target };
      }),
    ],
    [
      "DELETE",
      "/youtube/v3/comments",
      respond((r) =>
        comments.delete(query(r, "id")!) ? { status: 204, raw: null } : notFound("comment"),
      ),
    ],
    [
      "POST",
      "/youtube/v3/comments/setModerationStatus",
      respond((r) => {
        const target = comments.get(query(r, "id") ?? "");
        if (!target) return notFound("comment");
        target["snippet"]["moderationStatus"] = query(r, "moderationStatus");
        return { status: 204, raw: null };
      }),
    ],
    [
      "GET",
      "/youtube/v3/search",
      respond((r) => {
        const q = query(r, "q") ?? "";
        const hits = uploads
          .map((id) => videos.get(id)!)
          .filter((v) => v["snippet"]["title"].includes(q))
          .map((v) => ({ id: { kind: "youtube#video", videoId: v["id"] }, snippet: v["snippet"] }));
        return page(r, hits);
      }),
    ],
  ]);

  const oauth = fakeApi(OAUTH, [
    [
      "POST",
      "/token",
      (r) =>
        r.body?.grant_type === "refresh_token" &&
        r.body.client_id === GRANT.client_id &&
        r.body.client_secret === GRANT.client_secret &&
        r.body.refresh_token === GRANT.refresh_token
          ? { body: { access_token: ACCESS, expires_in: 3599, token_type: "Bearer" } }
          : {
              status: 400,
              body: {
                error: "invalid_grant",
                error_description: "Token has been expired or revoked.",
              },
            },
    ],
  ]);

  const media = fakeApi(MEDIA, [
    ["GET", "/clip.mp4", () => ({ raw: CLIP, headers: { "content-length": String(CLIP.length) } })],
    ["GET", "/thumb.png", () => ({ raw: PNG, headers: { "content-length": String(PNG.length) } })],
    ["GET", "/moved.png", () => ({ status: 302, raw: null, headers: { location: "/thumb.png" } })],
    [
      "GET",
      "/to-http.png",
      () => ({
        status: 302,
        raw: null,
        headers: { location: "http://media.example.com/thumb.png" },
      }),
    ],
    [
      "GET",
      "/to-elsewhere.png",
      () => ({
        status: 302,
        raw: null,
        headers: { location: "https://internal.example.net/x.png" },
      }),
    ],
  ]);

  const hosts: Array<[string, typeof api]> = [
    [OAUTH, oauth],
    [MEDIA, media],
    [API, api],
  ];
  const route: typeof fetch = (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    return (hosts.find(([base]) => url.startsWith(base))?.[1] ?? api).fetch(input, init);
  };

  return {
    ...api,
    /** Every host: the Data API, OAuth and media. */
    fetch: route,
    get down() {
      return api.down;
    },
    set down(value: boolean) {
      api.down = value;
    },
    oauth,
    media,
    videos,
    uploads,
    comments,
    playlists,
    items,
    sessions,
    thumbnails,
  };
}

/** Attachments served from memory, for tests that do not exercise downloads. */
export const memoryAttachments = async (uri: string) => {
  const bytes = uri.endsWith(".png") ? PNG : CLIP;
  return { size: bytes.length, body: bytes };
};
