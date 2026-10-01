import { digest, ProviderFailure, type Json } from "@runtime-protocol/sdk";

/** Tags that tie a video to the invocation that uploaded it; hidden from every view. */
export const MARKER_PREFIX = "rpk-";
export const isMarker = (tag: string) => tag.startsWith(MARKER_PREFIX);
/** Tags as YouTube keeps them: sorted, without markers. */
export const sortedTags = (tags: unknown) =>
  ((tags as string[] | undefined) ?? []).filter((t) => !isMarker(t)).sort();

type Record_ = Record<string, unknown>;
const record = (value: unknown): Record_ =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record_) : {};
const str = (value: unknown) => (typeof value === "string" ? value : undefined);
const num = (value: unknown) =>
  typeof value === "string" && /^\d+$/.test(value)
    ? Number(value)
    : typeof value === "number"
      ? value
      : undefined;
/** Drops undefined members, so views are valid JSON. */
const compact = (value: Record<string, unknown>): Json =>
  Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Json;

// ---------------------------------------------------------------------------------------
// Editable fields: what `resource.update` may patch, mapped to YouTube's snippet and status.

interface Field {
  part: "snippet" | "status";
  key: string;
  check: (value: unknown) => boolean;
  /** What a null in a merge patch means; undefined when the field cannot be cleared. */
  cleared?: unknown;
  expected: string;
}

const text =
  (max: number, min = 0) =>
  (v: unknown) =>
    typeof v === "string" && v.length >= min && v.length <= max && !/[<>]/.test(v);
const oneOf =
  (...values: string[]) =>
  (v: unknown) =>
    typeof v === "string" && values.includes(v);
const bool = (v: unknown) => typeof v === "boolean";
const tags = (v: unknown) =>
  Array.isArray(v) &&
  v.every((t) => typeof t === "string" && t.length > 0 && t.length <= 100 && !isMarker(t)) &&
  v.join(",").length <= 450;
const timestamp = (v: unknown) => typeof v === "string" && !Number.isNaN(Date.parse(v));

const PRIVACY = oneOf("public", "private", "unlisted");

export const VIDEO_FIELDS: Record<string, Field> = {
  title: {
    part: "snippet",
    key: "title",
    check: text(100, 1),
    expected: "1–100 characters without < or >",
  },
  description: {
    part: "snippet",
    key: "description",
    check: text(5000),
    cleared: "",
    expected: "at most 5000 characters without < or >",
  },
  tags: { part: "snippet", key: "tags", check: tags, cleared: [], expected: "a list of tags" },
  category_id: {
    part: "snippet",
    key: "categoryId",
    check: (v) => typeof v === "string" && /^\d+$/.test(v),
    expected: "a numeric category id",
  },
  default_language: {
    part: "snippet",
    key: "defaultLanguage",
    check: text(35, 2),
    cleared: null,
    expected: "a language code",
  },
  privacy_status: {
    part: "status",
    key: "privacyStatus",
    check: PRIVACY,
    expected: "public, private or unlisted",
  },
  publish_at: {
    part: "status",
    key: "publishAt",
    check: timestamp,
    cleared: null,
    expected: "a timestamp",
  },
  made_for_kids: {
    part: "status",
    key: "selfDeclaredMadeForKids",
    check: bool,
    expected: "a boolean",
  },
  embeddable: { part: "status", key: "embeddable", check: bool, expected: "a boolean" },
  license: {
    part: "status",
    key: "license",
    check: oneOf("youtube", "creativeCommon"),
    expected: "youtube or creativeCommon",
  },
  public_stats_viewable: {
    part: "status",
    key: "publicStatsViewable",
    check: bool,
    expected: "a boolean",
  },
};

export const PLAYLIST_FIELDS: Record<string, Field> = {
  title: {
    part: "snippet",
    key: "title",
    check: text(150, 1),
    expected: "1–150 characters without < or >",
  },
  description: {
    part: "snippet",
    key: "description",
    check: text(5000),
    cleared: "",
    expected: "at most 5000 characters without < or >",
  },
  default_language: {
    part: "snippet",
    key: "defaultLanguage",
    check: text(35, 2),
    cleared: null,
    expected: "a language code",
  },
  privacy_status: {
    part: "status",
    key: "privacyStatus",
    check: PRIVACY,
    expected: "public, private or unlisted",
  },
};

/** Validates a merge patch (or the editable members of a replacement) against the fields. */
export function checkPatch(
  patch: Record<string, unknown>,
  fields: Record<string, Field>,
  what: string,
): void {
  const names = Object.keys(patch);
  if (names.length === 0) throw new ProviderFailure(`the patch of the ${what} changes nothing`);
  for (const name of names) {
    const field = fields[name];
    if (!field)
      throw new ProviderFailure(
        `${name} is not an editable field of a YouTube ${what} (${Object.keys(fields).join(", ")})`,
      );
    const value = patch[name];
    if (value === null) {
      if (!("cleared" in field))
        throw new ProviderFailure(`${name} of a YouTube ${what} cannot be cleared`);
    } else if (!field.check(value))
      throw new ProviderFailure(`${name} of a YouTube ${what} must be ${field.expected}`);
  }
}

/** A full replacement as a patch: every editable field it leaves out is cleared. */
export function replacementPatch(
  content: unknown,
  fields: Record<string, Field>,
  required: string[],
  what: string,
): Record<string, unknown> {
  if (typeof content !== "object" || content === null || Array.isArray(content))
    throw new ProviderFailure(`the content of a YouTube ${what} must be an object`);
  const patch: Record<string, unknown> = {};
  for (const [name, field] of Object.entries(fields)) if ("cleared" in field) patch[name] = null;
  Object.assign(patch, content);
  for (const name of required)
    if (patch[name] === null || patch[name] === undefined)
      throw new ProviderFailure(`a YouTube ${what} needs ${name}`);
  checkPatch(patch, fields, what);
  return patch;
}

/**
 * Applies a validated patch to the writable parts of a resource. YouTube replaces whole
 * parts on update, so the current values are carried over.
 */
export function applyPatch(
  parts: { snippet: Record_; status: Record_ },
  patch: Record<string, unknown>,
  fields: Record<string, Field>,
): { snippet: Record_; status: Record_ } {
  const next = { snippet: { ...parts.snippet }, status: { ...parts.status } };
  for (const [name, value] of Object.entries(patch)) {
    const field = fields[name]!;
    const target = next[field.part];
    let resolved = value === null ? field.cleared : value;
    if (name === "tags") {
      // Keep the upload marker: a pending reconciliation may still look for it.
      const markers = ((parts.snippet["tags"] as string[] | undefined) ?? []).filter(isMarker);
      resolved = [...(resolved as string[]), ...markers];
    }
    if (resolved === null) delete target[field.key];
    else target[field.key] = resolved;
  }
  return next;
}

// ---------------------------------------------------------------------------------------
// Views: the content of `resource.read`, and the editable state that versions are made of.

const WRITABLE_SNIPPET = [
  "title",
  "description",
  "tags",
  "categoryId",
  "defaultLanguage",
  "defaultAudioLanguage",
];
const WRITABLE_STATUS = [
  "privacyStatus",
  "publishAt",
  "selfDeclaredMadeForKids",
  "embeddable",
  "license",
  "publicStatsViewable",
  "containsSyntheticMedia",
];
const pick = (from: Record_, keys: string[]) =>
  Object.fromEntries(keys.filter((k) => from[k] !== undefined).map((k) => [k, from[k]]));

/** The writable parts of a video, as `videos.update` must receive them. */
export function writableVideo(video: unknown): { snippet: Record_; status: Record_ } {
  const v = record(video);
  return {
    snippet: pick(record(v["snippet"]), WRITABLE_SNIPPET),
    status: pick(record(v["status"]), WRITABLE_STATUS),
  };
}

export function writablePlaylist(playlist: unknown): { snippet: Record_; status: Record_ } {
  const p = record(playlist);
  return {
    snippet: pick(record(p["snippet"]), ["title", "description", "defaultLanguage"]),
    status: pick(record(p["status"]), ["privacyStatus"]),
  };
}

function editable(
  parts: { snippet: Record_; status: Record_ },
  fields: Record<string, Field>,
): Json {
  const view: Record<string, unknown> = {};
  for (const [name, field] of Object.entries(fields)) {
    let value = parts[field.part][field.key];
    if (name === "tags")
      // YouTube keeps tags sorted; sorting here too keeps views and versions stable.
      value = sortedTags(value);
    if (value === undefined && "cleared" in field) value = field.cleared;
    view[name] = value;
  }
  return compact(view);
}

export const videoState = (video: unknown) => editable(writableVideo(video), VIDEO_FIELDS);
export const playlistState = (playlist: unknown) =>
  editable(writablePlaylist(playlist), PLAYLIST_FIELDS);
export function commentState(comment: unknown): Json {
  const s = record(record(comment)["snippet"]);
  return compact({
    text: str(s["textOriginal"]) ?? str(s["textDisplay"]),
    moderation_status: moderationOf(s),
  });
}
export function itemState(item: unknown): Json {
  const s = record(record(item)["snippet"]);
  return compact({ video: str(record(s["resourceId"])["videoId"]), position: num(s["position"]) });
}
export function thumbnailState(video: unknown): Json {
  const thumbnails = record(record(record(video)["snippet"])["thumbnails"]);
  return Object.fromEntries(
    Object.entries(thumbnails).map(([size, t]) => [
      size,
      compact({
        url: str(record(t)["url"]),
        width: num(record(t)["width"]),
        height: num(record(t)["height"]),
      }),
    ]),
  ) as Json;
}

/** The version of a resource: a digest of its editable state, stable across reads. */
export const versionOf = (state: Json) => digest(state);

const MODERATION: Record<string, string> = {
  published: "published",
  heldForReview: "held_for_review",
  likelySpam: "likely_spam",
  rejected: "rejected",
};
export const MODERATION_TO_YOUTUBE: Record<string, string> = {
  published: "published",
  held_for_review: "heldForReview",
  rejected: "rejected",
};
function moderationOf(snippet: Record_): string | undefined {
  const status = str(snippet["moderationStatus"]);
  return status ? (MODERATION[status] ?? status) : undefined;
}

export function videoView(video: unknown, ref: (id: string) => string): Json {
  const v = record(video);
  const s = record(v["snippet"]);
  const st = record(v["status"]);
  const stats = record(v["statistics"]);
  return compact({
    id: str(v["id"]),
    ...(videoState(video) as Record<string, unknown>),
    published_at: str(s["publishedAt"]),
    upload_status: str(st["uploadStatus"]),
    made_for_kids_effective: typeof st["madeForKids"] === "boolean" ? st["madeForKids"] : undefined,
    duration: str(record(v["contentDetails"])["duration"]),
    statistics: compact({
      views: num(stats["viewCount"]),
      likes: num(stats["likeCount"]),
      comments: num(stats["commentCount"]),
      favorites: num(stats["favoriteCount"]),
    }),
    thumbnail: ref(String(v["id"])),
  });
}

export function playlistView(playlist: unknown): Json {
  const p = record(playlist);
  return compact({
    id: str(p["id"]),
    ...(playlistState(playlist) as Record<string, unknown>),
    published_at: str(record(p["snippet"])["publishedAt"]),
    item_count: num(record(p["contentDetails"])["itemCount"]),
  });
}

export function itemView(item: unknown, videoRef: (id: string) => string): Json {
  const i = record(item);
  const s = record(i["snippet"]);
  const videoId = str(record(s["resourceId"])["videoId"]);
  return compact({
    id: str(i["id"]),
    video: videoId ? videoRef(videoId) : undefined,
    title: str(s["title"]),
    position: num(s["position"]),
    added_at: str(s["publishedAt"]),
  });
}

export function commentView(comment: unknown, commentRef: (id: string) => string): Json {
  const c = record(comment);
  const s = record(c["snippet"]);
  const parent = str(s["parentId"]);
  return compact({
    id: str(c["id"]),
    ...(commentState(comment) as Record<string, unknown>),
    author: compact({
      name: str(s["authorDisplayName"]),
      channel: str(record(s["authorChannelId"])["value"]),
    }),
    video: str(s["videoId"]),
    parent: parent ? commentRef(parent) : undefined,
    likes: num(s["likeCount"]),
    published_at: str(s["publishedAt"]),
    updated_at: str(s["updatedAt"]),
  });
}

export function channelView(channel: unknown, playlistRef: (id: string) => string): Json {
  const c = record(channel);
  const s = record(c["snippet"]);
  const stats = record(c["statistics"]);
  const uploads = str(record(record(c["contentDetails"])["relatedPlaylists"])["uploads"]);
  return compact({
    id: str(c["id"]),
    title: str(s["title"]),
    description: str(s["description"]),
    custom_url: str(s["customUrl"]),
    published_at: str(s["publishedAt"]),
    statistics: compact({
      subscribers: num(stats["subscriberCount"]),
      views: num(stats["viewCount"]),
      videos: num(stats["videoCount"]),
    }),
    uploads: uploads ? playlistRef(uploads) : undefined,
  });
}

// ---------------------------------------------------------------------------------------
// Upload metadata: the `data` of a broadcast publication.

const UPLOAD_DATA: Record<string, Field> = {
  ...Object.fromEntries(
    Object.entries(VIDEO_FIELDS).filter(([name]) => !["title", "description"].includes(name)),
  ),
  notify_subscribers: { part: "status", key: "", check: bool, expected: "a boolean" },
};

export function checkUploadData(data: unknown): Record<string, unknown> {
  if (data === undefined) return {};
  const fields = record(data);
  for (const [name, value] of Object.entries(fields)) {
    const field = UPLOAD_DATA[name];
    if (!field)
      throw new ProviderFailure(
        `data.${name} is not a YouTube upload setting (${Object.keys(UPLOAD_DATA).join(", ")})`,
      );
    if (!field.check(value)) throw new ProviderFailure(`data.${name} must be ${field.expected}`);
  }
  return fields;
}
