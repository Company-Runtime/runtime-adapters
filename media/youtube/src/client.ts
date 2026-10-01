import {
  isUnreachable,
  ProviderFailure,
  ProviderUnreachableError,
  redactSecrets,
  type HandlerContext,
  type Json,
} from "@runtime-protocol/sdk";

export const API = "the YouTube API";
const MAX_DETAIL = 200;
/** Refusals that say "not now" rather than "never": quotas and rate limits. */
const LIMITS = new Set([
  "quotaExceeded",
  "rateLimitExceeded",
  "userRateLimitExceeded",
  "dailyLimitExceeded",
  "uploadRateLimitExceeded",
]);

export interface Call {
  method?: string;
  /** A path under the API origin (`/youtube/v3/videos`) or an absolute URL on that origin. */
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  json?: Json;
  bytes?: Uint8Array;
  headers?: Record<string, string>;
  /** Statuses outside 2xx that are answers rather than failures (308, or 404 when probing). */
  accept?: number[];
}

export interface Answer<T> {
  status: number;
  headers: Headers;
  body: T;
}

export interface Client {
  call<T = any>(ctx: HandlerContext, call: Call): Promise<Answer<T>>;
  /** The values to keep out of every message: the credential and anything derived from it. */
  secrets(ctx: HandlerContext): Promise<string[]>;
  origin: string;
}

interface Session {
  token?: string;
  secrets: string[];
}

interface Grant {
  client_id: string;
  client_secret: string;
  refresh_token: string;
}

function grantOf(value: string): Grant | undefined {
  if (!value.trimStart().startsWith("{")) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new ProviderFailure("the YouTube credential is neither a token nor an OAuth grant", {
      code: "credential_unavailable",
    });
  }
  const grant = parsed as Partial<Grant>;
  if (
    typeof grant.client_id !== "string" ||
    typeof grant.client_secret !== "string" ||
    typeof grant.refresh_token !== "string"
  )
    throw new ProviderFailure(
      "the YouTube OAuth grant needs client_id, client_secret and refresh_token",
      { code: "credential_unavailable" },
    );
  return grant as Grant;
}

function detailOf(body: unknown): { reason?: string; message?: string } {
  if (typeof body !== "object" || body === null) return {};
  const error = (body as Record<string, unknown>)["error"];
  if (typeof error === "string") {
    const description = (body as Record<string, unknown>)["error_description"];
    return { reason: error, message: typeof description === "string" ? description : error };
  }
  if (typeof error !== "object" || error === null) return {};
  const record = error as { message?: unknown; errors?: Array<{ reason?: unknown }> };
  const reason = record.errors?.[0]?.reason;
  return {
    ...(typeof reason === "string" ? { reason } : {}),
    ...(typeof record.message === "string" ? { message: record.message } : {}),
  };
}

/**
 * Calls the YouTube Data API and classifies failures like the SDK's `fetchJson`, with what
 * uploads need on top: binary bodies, 308 answers and response headers.
 *
 * - never sent: `ProviderUnreachableError` (`provider_unavailable`);
 * - refused (4xx): `ProviderFailure` — 401 is `credential_unavailable`, quotas, rate limits,
 *   408 and 429 are retryable `provider_unavailable`, anything else `execution_failed`;
 * - 5xx, an unexpected status, an unreadable answer or an interruption after sending: a
 *   plain `Error`, reported as `unknown`.
 *
 * The credential is either an access token or a JSON OAuth grant
 * (`client_id`, `client_secret`, `refresh_token`) exchanged once per invocation.
 */
export function createClient(options: {
  baseUrl: string;
  tokenUrl: string;
  /** The channel the credential must manage; checked once per invocation. */
  channel: string;
  fetch?: typeof fetch;
}): Client {
  const origin = new URL(options.baseUrl).origin;
  const fetcher = options.fetch ?? fetch;
  // One session per invocation: the context object is created for each invocation.
  const sessions = new WeakMap<HandlerContext, Promise<Session>>();

  const send = async (
    ctx: HandlerContext,
    url: URL,
    init: RequestInit,
    api: string,
  ): Promise<Response> => {
    try {
      return await fetcher(url, { ...init, signal: ctx.signal, redirect: "manual" });
    } catch (error) {
      if (!ctx.signal.aborted && isUnreachable(error))
        throw new ProviderUnreachableError(`${api} could not be reached`);
      throw new Error(`the call to ${api} was interrupted after it was sent`);
    }
  };

  const read = async (
    response: Response,
    api: string,
  ): Promise<{ body: unknown; json: boolean }> => {
    let text: string;
    try {
      text = await response.text();
    } catch {
      throw new Error(`the response of ${api} could not be read`);
    }
    if (!text.trim()) return { body: null, json: true };
    try {
      return { body: JSON.parse(text), json: true };
    } catch {
      return { body: null, json: false };
    }
  };

  const refuse = (status: number, body: unknown, api: string, secrets: string[]): never => {
    const { reason, message } = detailOf(body);
    const detail = message?.trim().slice(0, MAX_DETAIL);
    const text = redactSecrets(
      `${api} answered HTTP ${status}${detail ? `: ${detail}` : ""}`,
      secrets,
    );
    if (status >= 400 && status < 500) {
      if (status === 401) throw new ProviderFailure(text, { code: "credential_unavailable" });
      if (status === 408 || status === 429 || (reason && LIMITS.has(reason)))
        throw new ProviderFailure(text, { code: "provider_unavailable", retryable: true });
      throw new ProviderFailure(text);
    }
    throw new Error(text);
  };

  const exchange = async (ctx: HandlerContext, value: string, grant: Grant): Promise<Session> => {
    const secrets = [value, grant.client_secret, grant.refresh_token];
    const api = "the Google OAuth endpoint";
    const response = await send(
      ctx,
      new URL(options.tokenUrl),
      {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
        },
        body: new URLSearchParams({ grant_type: "refresh_token", ...grant }).toString(),
      },
      api,
    );
    const { body } = await read(response, api);
    const token = (body as { access_token?: unknown } | null)?.access_token;
    if (response.ok && typeof token === "string") return { token, secrets: [...secrets, token] };
    const { reason } = detailOf(body);
    if (response.status === 400 || response.status === 401)
      throw new ProviderFailure(
        `Google refused the OAuth grant${reason ? ` (${redactSecrets(reason, secrets)})` : ""}`,
        { code: "credential_unavailable" },
      );
    // Nothing has reached YouTube yet, whatever happened to the exchange.
    throw new ProviderFailure(`${api} answered HTTP ${response.status}`, { retryable: true });
  };

  const authorize = async (ctx: HandlerContext): Promise<Session> => {
    const value = await ctx.credential();
    if (!value) return { secrets: [] };
    const grant = grantOf(value);
    if (!grant) return { token: value, secrets: [value] };
    try {
      return await exchange(ctx, value, grant);
    } catch (error) {
      if (error instanceof ProviderUnreachableError || error instanceof ProviderFailure)
        throw error;
      if (ctx.signal.aborted) throw error;
      throw new ProviderFailure("the YouTube OAuth grant could not be exchanged", {
        retryable: true,
      });
    }
  };

  /**
   * The invocation's session: a token for a credential that manages the configured
   * channel. Effects through another channel's credential would land on that channel while
   * references and reconciliation name this one.
   */
  const session = (ctx: HandlerContext): Promise<Session> => {
    let current = sessions.get(ctx);
    if (!current) {
      current = (async () => {
        const authorized = await authorize(ctx);
        let mine: Answer<{ items?: Array<{ id?: unknown }> } | null>;
        try {
          mine = await request(ctx, authorized, {
            path: "/youtube/v3/channels",
            query: { part: "id", mine: true },
          });
        } catch (error) {
          if (ctx.signal.aborted || error instanceof ProviderFailure) throw error;
          if (error instanceof ProviderUnreachableError) throw error;
          // A read that went wrong had no effect.
          throw new ProviderFailure("the channel of the YouTube credential could not be read", {
            retryable: true,
          });
        }
        if (mine.body?.items?.[0]?.id !== options.channel)
          throw new ProviderFailure(
            "the YouTube credential does not manage the configured channel",
            {
              code: "credential_unavailable",
            },
          );
        return authorized;
      })();
      sessions.set(ctx, current);
    }
    return current;
  };

  const request = async <T>(
    ctx: HandlerContext,
    { token, secrets }: Session,
    call: Call,
  ): Promise<Answer<T>> => {
    const url = new URL(call.path, origin);
    if (url.origin !== origin) throw new ProviderFailure(`${API} pointed outside its origin`);
    for (const [key, value] of Object.entries(call.query ?? {}))
      if (value !== undefined) url.searchParams.set(key, String(value));
    const headers: Record<string, string> = {
      accept: "application/json",
      ...(call.json !== undefined ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...call.headers,
    };
    const body =
      call.json !== undefined
        ? JSON.stringify(call.json)
        : call.bytes !== undefined
          ? (call.bytes as BodyInit)
          : undefined;
    const response = await send(
      ctx,
      url,
      {
        method: call.method ?? (body !== undefined ? "POST" : "GET"),
        headers,
        ...(body !== undefined ? { body } : {}),
      },
      API,
    );
    const answer = await read(response, API);
    const status = response.status;
    if ((status >= 200 && status < 300) || call.accept?.includes(status)) {
      if (!answer.json)
        throw new Error(`${API} answered HTTP ${status} with a body that is not JSON`);
      return { status, headers: response.headers, body: answer.body as T };
    }
    return refuse(status, answer.json ? answer.body : null, API, secrets);
  };

  return {
    origin,
    secrets: async (ctx) => (await session(ctx)).secrets,
    call: async <T>(ctx: HandlerContext, call: Call) => request<T>(ctx, await session(ctx), call),
  };
}
