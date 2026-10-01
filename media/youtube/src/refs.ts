import { ProviderFailure } from "@runtime-protocol/sdk";

/** A YouTube resource the adapter can address, always within the configured channel. */
export type Ref =
  | { kind: "channel"; channel: string }
  | { kind: "video"; channel: string; id: string }
  | { kind: "thumbnail"; channel: string; id: string }
  | { kind: "playlist"; channel: string; id: string }
  | { kind: "playlist_item"; channel: string; playlist: string; id: string }
  | { kind: "comment"; channel: string; id: string };

export type Kind = Ref["kind"];

const ID = "[A-Za-z0-9_.=-]+";
const PATTERN = new RegExp(
  `^resource://youtube/(${ID})(?:/(videos|playlists|comments)/(${ID})(?:/(thumbnail|items/(${ID})))?)?$`,
);

/** Parses a reference; undefined when it is not a YouTube reference this adapter knows. */
export function parseRef(ref: unknown): Ref | undefined {
  const match = typeof ref === "string" ? PATTERN.exec(ref) : null;
  if (!match) return undefined;
  const [, channel, collection, id, tail, item] = match as unknown as [
    string,
    string,
    string?,
    string?,
    string?,
    string?,
  ];
  if (!collection || !id) return { kind: "channel", channel };
  if (collection === "videos" && !tail) return { kind: "video", channel, id };
  if (collection === "videos" && tail === "thumbnail") return { kind: "thumbnail", channel, id };
  if (collection === "playlists" && !tail) return { kind: "playlist", channel, id };
  if (collection === "playlists" && item)
    return { kind: "playlist_item", channel, playlist: id, id: item };
  if (collection === "comments" && !tail) return { kind: "comment", channel, id };
  return undefined;
}

export function refOf(ref: Ref): string {
  const base = `resource://youtube/${ref.channel}`;
  switch (ref.kind) {
    case "channel":
      return base;
    case "video":
      return `${base}/videos/${ref.id}`;
    case "thumbnail":
      return `${base}/videos/${ref.id}/thumbnail`;
    case "playlist":
      return `${base}/playlists/${ref.id}`;
    case "playlist_item":
      return `${base}/playlists/${ref.playlist}/items/${ref.id}`;
    case "comment":
      return `${base}/comments/${ref.id}`;
  }
}

/**
 * Resolves a reference on the configured channel, of one of the expected kinds. Anything
 * else is refused before a call is made.
 */
export function resolve<K extends Kind>(
  channel: string,
  ref: unknown,
  kinds: readonly K[],
  role = "the resource",
): Extract<Ref, { kind: K }> {
  const parsed = parseRef(ref);
  if (!parsed) throw new ProviderFailure(`${role} is not a YouTube reference`);
  if (parsed.channel !== channel)
    throw new ProviderFailure(`${role} is not on the YouTube channel this adapter manages`);
  if (!(kinds as readonly Kind[]).includes(parsed.kind))
    throw new ProviderFailure(`${role} must be a YouTube ${kinds.join(" or ").replace(/_/g, " ")}`);
  return parsed as Extract<Ref, { kind: K }>;
}
