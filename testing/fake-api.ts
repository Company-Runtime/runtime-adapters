/**
 * An in-memory stand-in for a vendor HTTP API, used by adapter tests. Routes answer by
 * method and path; every call is recorded. Nothing here is published.
 */
export interface FakeRequest {
  method: string;
  url: URL;
  headers: Headers;
  body: any;
}

export interface FakeAnswer {
  status?: number;
  body?: unknown;
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
      const text = typeof init.body === "string" ? init.body : undefined;
      const request: FakeRequest = {
        method: (init.method ?? "GET").toUpperCase(),
        url,
        headers: new Headers(init.headers),
        body: text ? JSON.parse(text) : undefined,
      };
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
        return Response.json(answer.body ?? {}, { status: answer.status ?? 200 });
      }
      return Response.json({ message: "Not Found" }, { status: 404 });
    },
  };
  return api;
}
