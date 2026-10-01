import { createHash } from "node:crypto";
import {
  ProviderFailure,
  ProviderUnreachableError,
  type HandlerContext,
  type Json,
} from "@runtime-protocol/sdk";
import type { Client } from "./client.ts";
import { MARKER_PREFIX } from "./views.ts";

/** A file to upload: its exact size and its bytes. */
export interface AttachmentSource {
  size: number;
  body: ReadableStream<Uint8Array> | Uint8Array;
}

export type OpenAttachment = (uri: string, signal: AbortSignal) => Promise<AttachmentSource>;

/** The marker tag that ties a video to the invocation that uploaded it. */
export const markerOf = (key: string) =>
  `${MARKER_PREFIX}${createHash("sha256").update(key).digest("hex").slice(0, 24)}`;

/**
 * Opens `https:` attachments with a plain GET (no YouTube credential is sent). Other
 * schemes are refused: hosts that keep files elsewhere, or that take URIs from untrusted
 * callers, pass their own `openAttachment`.
 */
export function httpsAttachments(fetcher: typeof fetch = fetch): OpenAttachment {
  return async (uri, signal) => {
    const url = new URL(uri);
    if (url.protocol !== "https:")
      throw new ProviderFailure("only https attachments can be fetched by the YouTube adapter");
    let response: Response;
    try {
      response = await fetcher(url, { signal });
    } catch {
      throw new ProviderFailure("the attachment could not be fetched", {
        code: "provider_unavailable",
        retryable: true,
      });
    }
    const length = Number(response.headers.get("content-length"));
    if (!response.ok || !response.body || !Number.isSafeInteger(length) || length <= 0)
      throw new ProviderFailure(
        `the attachment could not be fetched (HTTP ${response.status}, a known length is required)`,
      );
    return { size: length, body: response.body };
  };
}

/** Reads a source in pieces of at most `size` bytes. */
async function* pieces(body: AttachmentSource["body"], size: number): AsyncGenerator<Uint8Array> {
  if (body instanceof Uint8Array) {
    for (let at = 0; at < body.length; at += size) yield body.subarray(at, at + size);
    return;
  }
  const reader = body.getReader();
  let buffer = new Uint8Array(0);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (value) {
        const joined = new Uint8Array(buffer.length + value.length);
        joined.set(buffer);
        joined.set(value, buffer.length);
        buffer = joined;
        while (buffer.length >= size) {
          yield buffer.subarray(0, size);
          buffer = buffer.subarray(size);
        }
      }
      if (done) break;
    }
    if (buffer.length > 0) yield buffer;
  } finally {
    reader.releaseLock();
  }
}

const RETRIES = 3;

/**
 * Uploads a video with YouTube's resumable protocol. No video exists until the last byte
 * arrives, so every failure before the final chunk is a refusal without effect; the
 * final chunk is sent only once the whole file matches the declared size and digest.
 * An interruption of the final chunk is uncertain and left to reconciliation.
 */
export async function uploadVideo(
  ctx: HandlerContext,
  client: Client,
  request: {
    metadata: Json;
    notifySubscribers?: boolean;
    source: AttachmentSource;
    mediaType: string;
    digest?: string;
    chunkSize: number;
  },
): Promise<Record<string, unknown>> {
  const { source, chunkSize } = request;
  const beforeFinal = async <T>(step: () => Promise<T>): Promise<T> => {
    try {
      return await step();
    } catch (error) {
      if (ctx.signal.aborted || error instanceof ProviderFailure) throw error;
      // Nothing can exist yet: unreachable, a 5xx or a lost answer is still no effect.
      throw new ProviderFailure(
        error instanceof ProviderUnreachableError
          ? error.message
          : "the upload to YouTube was interrupted before it completed",
        { code: "provider_unavailable", retryable: true },
      );
    }
  };

  const started = await beforeFinal(() =>
    client.call(ctx, {
      path: "/upload/youtube/v3/videos",
      query: {
        uploadType: "resumable",
        part: "snippet,status",
        ...(request.notifySubscribers !== undefined
          ? { notifySubscribers: request.notifySubscribers }
          : {}),
      },
      json: request.metadata,
      headers: {
        "x-upload-content-length": String(source.size),
        "x-upload-content-type": request.mediaType,
      },
    }),
  );
  const location = started.headers.get("location");
  if (!location) throw new ProviderFailure("YouTube did not open an upload session");
  const session = new URL(location, client.origin);
  if (session.origin !== client.origin)
    throw new ProviderFailure("YouTube opened an upload session on another origin");

  /** How many bytes YouTube holds, from a 308's Range header (`bytes=0-N`). */
  const received = (headers: Headers) => {
    const match = /bytes=0-(\d+)/.exec(headers.get("range") ?? "");
    return match ? Number(match[1]) + 1 : 0;
  };
  const probe = () =>
    client.call(ctx, {
      method: "PUT",
      path: session.href,
      headers: { "content-range": `bytes */${source.size}` },
      accept: [308],
    });

  const hash = createHash("sha256");
  let offset = 0;
  let pending: Uint8Array | undefined;

  /** Sends one non-final chunk, resuming from what YouTube holds after a failure. */
  const sendChunk = async (chunk: Uint8Array, start: number) => {
    let at = start;
    for (let attempt = 0; ; attempt++) {
      const rest = chunk.subarray(at - start);
      try {
        const answer = await client.call(ctx, {
          method: "PUT",
          path: session.href,
          bytes: rest,
          headers: {
            "content-type": request.mediaType,
            "content-range": `bytes ${at}-${at + rest.length - 1}/${source.size}`,
          },
          accept: [308],
        });
        if (answer.status !== 308) throw new Error("YouTube completed the upload early");
        const held = received(answer.headers);
        if (held >= start + chunk.length) return;
        at = Math.max(held, start);
      } catch (error) {
        // Refusals are final; only interruptions are worth resuming.
        if (ctx.signal.aborted || error instanceof ProviderFailure || attempt >= RETRIES)
          throw error;
        const held = received((await probe()).headers);
        if (held < start)
          throw new ProviderFailure("YouTube lost part of the upload", {
            code: "provider_unavailable",
            retryable: true,
          });
        if (held >= start + chunk.length) return;
        at = held;
      }
    }
  };

  await beforeFinal(async () => {
    for await (const piece of pieces(source.body, chunkSize)) {
      if (pending) {
        await sendChunk(pending, offset);
        offset += pending.length;
      }
      hash.update(piece);
      pending = piece.slice();
      if (offset + pending.length > source.size)
        throw new ProviderFailure("the attachment is larger than its declared size");
    }
  });
  if (!pending || offset + pending.length !== source.size)
    throw new ProviderFailure("the attachment is smaller than its declared size");
  if (request.digest && `sha256:${hash.digest("hex")}` !== request.digest)
    throw new ProviderFailure("the attachment does not match its digest; nothing was published");

  // The final chunk: from here on, an interruption may have created the video.
  const last = pending;
  const answer = await client.call<Record<string, unknown>>(ctx, {
    method: "PUT",
    path: session.href,
    bytes: last,
    headers: {
      "content-type": request.mediaType,
      "content-range": `bytes ${offset}-${offset + last.length - 1}/${source.size}`,
    },
  });
  if (typeof answer.body?.["id"] !== "string")
    throw new Error("YouTube completed the upload without naming the video");
  return answer.body;
}
