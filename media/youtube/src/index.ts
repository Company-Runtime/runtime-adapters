import {
  defineProvider,
  type CredentialOwner,
  type Handler,
  type HandlerContext,
  type Json,
  type Provider,
} from "@runtime-protocol/sdk";
import { API, createClient } from "./client.ts";
import { publish, reconcilePublish } from "./publish.ts";
import {
  create,
  read,
  reconcileCreate,
  reconcileDelete,
  reconcileUpdate,
  remove,
  search,
  update,
} from "./resources.ts";
import type { Deps } from "./shared.ts";
import { httpsAttachments, type OpenAttachment } from "./upload.ts";

export type { AttachmentSource, OpenAttachment } from "./upload.ts";

export interface YouTubeProviderOptions {
  /** Provider identifier; defaults to `youtube`. */
  id?: string;
  /**
   * The channel the credential manages (`UC…`). References to any other channel are
   * refused before a call is made.
   */
  channel: string;
  /** Defaults to https://www.googleapis.com (Data API under /youtube/v3, uploads under /upload). */
  baseUrl?: string;
  /** Where OAuth grants are exchanged; defaults to https://oauth2.googleapis.com/token. */
  tokenUrl?: string;
  /** Opens attachment URIs for uploads and thumbnails; defaults to plain `https:` downloads. */
  openAttachment?: OpenAttachment;
  /** Upload chunk size, a multiple of 256 KiB; defaults to 8 MiB. */
  chunkSize?: number;
  /** Privacy of uploads and playlists that do not set one; defaults to `private`. */
  defaultPrivacy?: "private" | "unlisted" | "public";
  /** Category of uploads that do not set one; defaults to 22 (People & Blogs). */
  defaultCategory?: string;
  /**
   * How long after an invocation's deadline the absence of its effect proves that it did
   * not happen; defaults to fifteen minutes, as uploads take a while to be listed.
   */
  settleAfterMs?: number;
  /** Credential owners accepted; defaults to organization, workload and user. */
  credentials?: { required: boolean; accepts: CredentialOwner[] };
  fetch?: typeof fetch;
}

const CHUNK = 256 * 1024;

/**
 * Implements YouTube creator work with core capabilities: uploads and comments through
 * communication.publish (broadcast and chat), and videos, thumbnails, playlists and
 * comments through resource.read, search, create, update and delete.
 */
export function createYouTubeProvider(options: YouTubeProviderOptions): Provider {
  if (!/^[A-Za-z0-9_-]+$/.test(options.channel ?? ""))
    throw new TypeError("createYouTubeProvider needs the channel id the credential manages");
  const chunkSize = options.chunkSize ?? 32 * CHUNK;
  if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0 || chunkSize % CHUNK !== 0)
    throw new TypeError("chunkSize must be a positive multiple of 256 KiB");
  const deps: Deps = {
    client: createClient({
      baseUrl: (options.baseUrl ?? "https://www.googleapis.com").replace(/\/+$/, ""),
      tokenUrl: options.tokenUrl ?? "https://oauth2.googleapis.com/token",
      ...(options.fetch ? { fetch: options.fetch } : {}),
    }),
    channel: options.channel,
    settleAfterMs: options.settleAfterMs ?? 900_000,
    chunkSize,
    defaultPrivacy: options.defaultPrivacy ?? "private",
    defaultCategory: options.defaultCategory ?? "22",
    open: options.openAttachment ?? httpsAttachments(options.fetch),
  };

  /**
   * Binds a handler to the adapter. Once the invocation is aborted, nothing it reports can
   * be a proven refusal: the outcome is left uncertain.
   */
  const bind =
    (handler: (input: Json, ctx: HandlerContext, deps: Deps) => ReturnType<Handler>): Handler =>
    async (input, ctx) => {
      try {
        return await handler(input, ctx, deps);
      } catch (error) {
        if (ctx.signal.aborted) throw new Error(`the call to ${API} was interrupted`);
        throw error;
      }
    };
  const mutating = {
    evidence: { claims: ["execution", "state"] },
    reconciliation: "supported" as const,
  };

  return defineProvider({
    id: options.id ?? "youtube",
    name: "YouTube",
    adapter: { id: "runtime-adapter-youtube", version: "0.1.0", system: "youtube" },
    capabilities: [
      {
        capability: "communication.publish",
        profiles: ["broadcast", "chat"],
        traits: ["attachments", "threading"],
        ...mutating,
      },
      { capability: "resource.read" },
      { capability: "resource.search" },
      { capability: "resource.create", ...mutating },
      { capability: "resource.update", ...mutating },
      { capability: "resource.delete", ...mutating },
    ],
    credentials: options.credentials ?? {
      required: true,
      accepts: ["organization", "workload", "user"],
    },
    handlers: {
      "communication.publish": bind(publish),
      "resource.read": bind(read),
      "resource.search": bind(search),
      "resource.create": bind(create),
      "resource.update": bind(update),
      "resource.delete": bind(remove),
    },
    reconcile: {
      "communication.publish": (input, ctx) => reconcilePublish(input, ctx, deps),
      "resource.create": (input, ctx) => reconcileCreate(input, ctx, deps),
      "resource.update": (input, ctx) => reconcileUpdate(input, ctx, deps),
      "resource.delete": (input, ctx) => reconcileDelete(input, ctx, deps),
    },
  });
}
