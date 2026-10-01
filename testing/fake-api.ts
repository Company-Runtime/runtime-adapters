/**
 * An in-memory stand-in for a vendor HTTP API, used by adapter tests. Routes answer by
 * method and path; every call is recorded. Nothing here is published.
 */
export interface FakeRequest {
  method: string;
  url: URL;
  headers: Headers;
  /** JSON bodies parsed, form bodies as a record, any other text as is. */
  body: any;
  /** Binary bodies (bytes, buffers, blobs and streams), read in full. */
  bytes?: Uint8Array;
}

export interface FakeAnswer {
  status?: number;
  body?: unknown;
  headers?: HeadersInit;
  /** Answer with this body as is instead of JSON; null answers with no body at all. */
  raw?: string | Uint8Array | null;
  /** Answer only after this delay (the request has been received). */
  delayMs?: number;
  /** Drop the connection after the request was received: the caller never learns the outcome. */
  drop?: boolean;
}

export type Route = [
  method: string,
  path: string | RegExp,
  handle: (request: FakeRequest, match: RegExpMatchArray) => FakeAnswer | Promise<FakeAnswer>,
];

export interface FakeApi {
  fetch: typeof fetch;
  calls: FakeRequest[];
  /** Makes the API unreachable: requests fail before they are sent. */
  down: boolean;
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

function parseText(text: string, headers: Headers): unknown {
  if (headers.get("content-type")?.includes("application/x-www-form-urlencoded"))
    return Object.fromEntries(new URLSearchParams(text));
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function fakeApi(base: string, routes: Route[]): FakeApi {
  const api: FakeApi = {
    calls: [],
    down: false,
    fetch: async (input, init = {}) => {
      if (api.down)
        throw new TypeError("fetch failed", {
          cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
        });
      const url = new URL(input instanceof Request ? input.url : String(input));
      const signal = init.signal ?? undefined;
      if (signal?.aborted) throw abortError(signal);
      const headers = new Headers(init.headers);
      const request: FakeRequest = {
        method: (init.method ?? "GET").toUpperCase(),
        url,
        headers,
        body: undefined,
      };
      if (typeof init.body === "string") request.body = parseText(init.body, headers);
      else if (init.body instanceof URLSearchParams) request.body = Object.fromEntries(init.body);
      else if (init.body != null)
        request.bytes = new Uint8Array(await new Response(init.body).arrayBuffer());
      api.calls.push(request);
      if (!url.href.startsWith(base))
        return Response.json({ message: "unknown host" }, { status: 404 });
      const path = url.pathname.slice(new URL(base).pathname.replace(/\/$/, "").length);
      for (const [method, pattern, handle] of routes) {
        if (method !== request.method) continue;
        const match =
          typeof pattern === "string"
            ? path === pattern
              ? ([path] as RegExpMatchArray)
              : null
            : path.match(pattern);
        if (!match) continue;
        const answer = await handle(request, match);
        if (answer.delayMs) {
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, answer.delayMs);
            signal?.addEventListener("abort", () => {
              clearTimeout(timer);
              reject(abortError(signal));
            });
          });
        }
        if (answer.drop)
          throw new TypeError("fetch failed", {
            cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }),
          });
        const init = {
          status: answer.status ?? 200,
          ...(answer.headers ? { headers: answer.headers } : {}),
        };
        if (answer.raw !== undefined) return new Response(answer.raw as BodyInit | null, init);
        return Response.json(answer.body ?? {}, init);
      }
      return Response.json({ message: "Not Found" }, { status: 404 });
    },
  };
  return api;
}
