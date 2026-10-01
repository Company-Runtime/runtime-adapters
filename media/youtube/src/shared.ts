import {
  ProviderFailure,
  type EvidenceItem,
  type HandlerContext,
  type Json,
  type Reconciliation,
} from "@runtime-protocol/sdk";
import type { Client } from "./client.ts";
import type { OpenAttachment } from "./upload.ts";

/** What every handler needs: the client and the adapter's settings. */
export interface Deps {
  client: Client;
  channel: string;
  settleAfterMs: number;
  chunkSize: number;
  defaultPrivacy: "private" | "unlisted" | "public";
  defaultCategory: string;
  open: OpenAttachment;
}

export type Outcome = Omit<Reconciliation, "protocol" | "invocation_id">;

const HOUR_MS = 3_600_000;

export const keyOf = (ctx: HandlerContext) => ctx.idempotencyKey ?? ctx.invocation.invocation_id;

/**
 * The earliest moment an invocation can have taken effect: deadlines are at most an hour
 * after dispatch.
 */
export const windowStart = (ctx: HandlerContext) => Date.parse(ctx.invocation.deadline) - HOUR_MS;

export const after = (timestamp: unknown, ctx: HandlerContext) =>
  typeof timestamp === "string" && Date.parse(timestamp) >= windowStart(ctx);

/** The effect is not visible: uncertain until the settle window passes, then a proven failure. */
export function notVisible(
  ctx: HandlerContext,
  deps: Deps,
  reason: string,
  evidence: () => EvidenceItem[],
): Outcome {
  if (ctx.now().getTime() < Date.parse(ctx.invocation.deadline) + deps.settleAfterMs)
    return { status: "inconclusive", reason: `${reason} yet` };
  return { status: "failed", final: true, reason, evidence: evidence() };
}

/** Runs a reconciliation; any failure to read YouTube leaves it inconclusive. */
export async function reconciling(read: () => Promise<Outcome>): Promise<Outcome> {
  try {
    return await read();
  } catch {
    return { status: "inconclusive", reason: "YouTube could not be read" };
  }
}

export const observe = (
  ctx: HandlerContext,
  claims: string[],
  ref: string,
  type: string,
  data: Json,
): EvidenceItem => ctx.evidence.stateObservation(claims, { ref, type }, data);

export const receipt = (ctx: HandlerContext, ref: string, type: string, data: Json): EvidenceItem =>
  ctx.evidence.providerReceipt(["execution"], data, { subject: { ref, type } });

export const record = (value: unknown): Record<string, any> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, any>)
    : {};

/** The first item of a `*.list` answer, or undefined when YouTube has none. */
export async function fetchOne(
  ctx: HandlerContext,
  deps: Deps,
  collection: "videos" | "playlists" | "playlistItems" | "comments" | "commentThreads" | "channels",
  id: string,
  part: string,
): Promise<Record<string, any> | undefined> {
  const { body } = await deps.client.call<{ items?: unknown[] }>(ctx, {
    path: `/youtube/v3/${collection}`,
    query: {
      id,
      part,
      ...(collection === "comments" || collection === "commentThreads"
        ? { textFormat: "plainText" }
        : {}),
    },
  });
  const item = body?.items?.[0];
  return item === undefined ? undefined : record(item);
}

/**
 * Every item of a paged `*.list` answer, up to a bound; undefined when there are more.
 * `enough` stops early, for lists in time order that have gone past what matters.
 */
export async function fetchAll(
  ctx: HandlerContext,
  deps: Deps,
  path: string,
  query: Record<string, string | number | boolean | undefined>,
  options: { pages?: number; enough?: (items: Record<string, any>[]) => boolean } = {},
): Promise<Record<string, any>[] | undefined> {
  const pages = options.pages ?? 20;
  const items: Record<string, any>[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < pages; page++) {
    const { body } = await deps.client.call<{ items?: unknown[]; nextPageToken?: string }>(ctx, {
      path,
      query: { ...query, maxResults: 50, pageToken },
    });
    items.push(...(body?.items ?? []).map(record));
    pageToken = body?.nextPageToken;
    if (!pageToken || options.enough?.(items)) return items;
  }
  return undefined;
}

/** Refuses members a YouTube mapping cannot honour, rather than dropping them silently. */
export function refuseMembers(input: Json, members: string[], why: string): void {
  for (const member of members)
    if (input[member] !== undefined) throw new ProviderFailure(`${member} ${why}`);
}
