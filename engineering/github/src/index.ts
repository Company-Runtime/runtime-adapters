import {
  defineProvider,
  fetchJson,
  ProviderFailure,
  type CredentialOwner,
  type HandlerContext,
  type Json,
  type Provider,
  type ReconcileHandler,
} from "@runtime-protocol/sdk";

export interface GitHubProviderOptions {
  /** Provider identifier; defaults to `github`. */
  id?: string;
  /** Repository (`owner/name`) for work created without a `container`. */
  repository?: string;
  /** Maps identity references to GitHub logins. Unmapped identities are refused, never guessed. */
  users?: Record<string, string> | ((identity: string) => string | undefined);
  /** Defaults to https://api.github.com (GitHub Enterprise Server: https://<host>/api/v3). */
  baseUrl?: string;
  /**
   * How long after an invocation's deadline the absence of its effect proves that it did
   * not happen; defaults to five minutes.
   */
  settleAfterMs?: number;
  /** Credential owners accepted; defaults to organization (BYOK), workload and user. */
  credentials?: { required: boolean; accepts: CredentialOwner[] };
  fetch?: typeof fetch;
}

interface Issue {
  id?: number;
  number: number;
  html_url?: string;
  body?: string | null;
  state?: string;
  state_reason?: string | null;
  created_at: string;
  updated_at: string;
  closed_at?: string | null;
  assignees?: Array<{ login: string }>;
  pull_request?: unknown;
}

const API = "the GitHub API";
const HOUR_MS = 3_600_000;
const REPOSITORY = /^resource:\/\/github\/([^/]+)\/([^/]+)$/;
const ISSUE = /^resource:\/\/github\/([^/]+)\/([^/]+)\/issues\/(\d+)$/;

/** The marker that ties an issue to the invocation that created it, for reconciliation. */
const marker = (key: string) =>
  `<!-- runtime-protocol:idempotency-key ${encodeURIComponent(key)} -->`;

/**
 * Implements work.create, work.assign and work.complete with GitHub issues. Creation
 * leaves an idempotency marker in the issue body; assignment and completion are
 * reconciled by reading the issue.
 */
export function createGitHubProvider(options: GitHubProviderOptions = {}): Provider {
  const baseUrl = (options.baseUrl ?? "https://api.github.com").replace(/\/+$/, "");
  const settleAfterMs = options.settleAfterMs ?? 300_000;
  const users = options.users ?? {};
  const loginOf = (identity: string) => {
    const login = typeof users === "function" ? users(identity) : users[identity];
    if (!login) throw new ProviderFailure("the identity has no GitHub login configured");
    return login;
  };
  const issueRef = (owner: string, repo: string, n: number) =>
    `resource://github/${owner}/${repo}/issues/${n}`;
  const parseIssue = (ref: unknown) => {
    const match = typeof ref === "string" ? ISSUE.exec(ref) : null;
    if (!match) throw new ProviderFailure("the work is not a GitHub issue reference");
    return { owner: match[1]!, repo: match[2]!, number: Number(match[3]) };
  };
  const repositoryOf = (container: unknown) => {
    if (container !== undefined) {
      const match = typeof container === "string" ? REPOSITORY.exec(container) : null;
      if (!match) throw new ProviderFailure("the container is not a GitHub repository reference");
      return { owner: match[1]!, repo: match[2]! };
    }
    const [owner, repo] = (options.repository ?? "").split("/");
    if (!owner || !repo)
      throw new ProviderFailure(
        "no repository: set a container or the adapter's default repository",
      );
    return { owner, repo };
  };

  const github = async <T>(
    ctx: HandlerContext,
    path: string,
    init: { method?: string; body?: Json; query?: Record<string, string> } = {},
  ) => {
    const key = await ctx.credential();
    const { body } = await fetchJson<T>(`${baseUrl}${path}`, {
      api: API,
      ...init,
      headers: {
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "runtime-adapter-github",
        ...(key ? { authorization: `Bearer ${key}` } : {}),
      },
      signal: ctx.signal,
      redact: key ? [key] : [],
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
    return body;
  };
  const observe = (ctx: HandlerContext, ref: string, issue: Issue, claims: string[]) =>
    ctx.evidence.stateObservation(
      claims,
      { ref, type: "issue" },
      {
        number: issue.number,
        state: issue.state ?? null,
        assignees: (issue.assignees ?? []).map((a) => a.login),
        updated_at: issue.updated_at,
      },
    );

  /** Reconciliation by reading one issue: `settled(issue)` tells whether the effect is there. */
  const byIssue =
    (settled: (issue: Issue, input: Json) => Json | undefined): ReconcileHandler =>
    async (input, ctx) => {
      const { owner, repo, number } = parseIssue(input["work"]);
      let issue: Issue;
      try {
        issue = await github<Issue>(ctx, `/repos/${owner}/${repo}/issues/${number}`);
      } catch {
        return { status: "inconclusive", reason: "the issue could not be read" };
      }
      const ref = issueRef(owner, repo, number);
      const output = settled(issue, input);
      if (output)
        return {
          status: "completed",
          output,
          evidence: [observe(ctx, ref, issue, ["execution", "state"])],
        };
      if (ctx.now().getTime() < Date.parse(ctx.invocation.deadline) + settleAfterMs)
        return { status: "inconclusive", reason: "the change is not visible yet" };
      return {
        status: "failed",
        final: true,
        reason: "the issue does not show the change",
        evidence: [observe(ctx, ref, issue, ["state"])],
      };
    };

  return defineProvider({
    id: options.id ?? "github",
    name: "GitHub",
    adapter: { id: "runtime-adapter-github", version: "0.1.0", system: "github" },
    capabilities: ["work.create", "work.assign", "work.complete"].map((capability) => ({
      capability,
      evidence: { claims: ["execution", "state"] },
      reconciliation: "supported" as const,
    })),
    credentials: options.credentials ?? {
      required: true,
      accepts: ["organization", "workload", "user"],
    },
    handlers: {
      "work.create": async (input, ctx) => {
        const { owner, repo } = repositoryOf(input["container"]);
        const assignee =
          typeof input["assignee"] === "string" ? loginOf(input["assignee"]) : undefined;
        const key = ctx.idempotencyKey ?? ctx.invocation.invocation_id;
        const body = [
          input["description"],
          input["due"] ? `Due: ${String(input["due"])}` : undefined,
          input["parent"] ? `Part of ${String(input["parent"])}` : undefined,
          marker(key),
        ]
          .filter((part) => typeof part === "string" && part.length > 0)
          .join("\n\n");
        const issue = await github<Issue>(ctx, `/repos/${owner}/${repo}/issues`, {
          body: {
            title: input["title"] as string,
            body,
            labels: [
              ...((input["labels"] as string[] | undefined) ?? []),
              ...(input["priority"] ? [`priority: ${String(input["priority"])}`] : []),
            ],
            ...(assignee ? { assignees: [assignee] } : {}),
          },
        });
        const ref = issueRef(owner, repo, issue.number);
        return {
          output: { work: { ref, created_at: issue.created_at } },
          evidence: [
            ctx.evidence.providerReceipt(["execution"], {
              issue_id: issue.id ?? null,
              number: issue.number,
              url: issue.html_url ?? null,
            }),
            observe(ctx, ref, issue, ["state"]),
          ],
        };
      },
      "work.assign": async (input, ctx) => {
        const { owner, repo, number } = parseIssue(input["work"]);
        const login = loginOf(input["assignee"] as string);
        const issue = await github<Issue>(
          ctx,
          `/repos/${owner}/${repo}/issues/${number}/assignees`,
          { body: { assignees: [login] } },
        );
        // GitHub silently ignores users who cannot be assigned: then nothing changed.
        if (!(issue.assignees ?? []).some((a) => a.login.toLowerCase() === login.toLowerCase()))
          throw new ProviderFailure(
            "GitHub did not assign the user; they cannot be assigned to this issue",
          );
        const ref = issueRef(owner, repo, number);
        return {
          output: {
            work: { ref },
            assignee: input["assignee"] as string,
            assigned_at: issue.updated_at,
          },
          evidence: [observe(ctx, ref, issue, ["execution", "state"])],
        };
      },
      "work.complete": async (input, ctx) => {
        const { owner, repo, number } = parseIssue(input["work"]);
        const notes = [
          typeof input["resolution"] === "string" ? input["resolution"] : undefined,
          ...((input["evidence"] as string[] | undefined) ?? []).map((ref) => `Evidence: ${ref}`),
        ].filter(Boolean);
        if (notes.length > 0)
          await github(ctx, `/repos/${owner}/${repo}/issues/${number}/comments`, {
            body: {
              body: [...notes, marker(ctx.idempotencyKey ?? ctx.invocation.invocation_id)].join(
                "\n\n",
              ),
            },
          });
        const issue = await github<Issue>(ctx, `/repos/${owner}/${repo}/issues/${number}`, {
          method: "PATCH",
          body: { state: "closed", state_reason: "completed" },
        });
        const ref = issueRef(owner, repo, number);
        return {
          output: { work: { ref }, completed_at: issue.closed_at ?? issue.updated_at },
          evidence: [observe(ctx, ref, issue, ["execution", "state"])],
        };
      },
    },
    reconcile: {
      "work.create": async (input, ctx) => {
        const { owner, repo } = repositoryOf(input["container"]);
        const needle = marker(ctx.idempotencyKey ?? ctx.invocation.invocation_id);
        const deadline = Date.parse(ctx.invocation.deadline);
        let issues: Issue[];
        try {
          issues = await github<Issue[]>(ctx, `/repos/${owner}/${repo}/issues`, {
            query: {
              state: "all",
              since: new Date(deadline - HOUR_MS).toISOString(),
              per_page: "100",
              sort: "created",
              direction: "desc",
            },
          });
        } catch {
          return { status: "inconclusive", reason: "the repository issues could not be read" };
        }
        const issue = issues.find((i) => !i.pull_request && (i.body ?? "").includes(needle));
        if (issue) {
          const ref = issueRef(owner, repo, issue.number);
          return {
            status: "completed",
            output: { work: { ref, created_at: issue.created_at } },
            evidence: [observe(ctx, ref, issue, ["execution", "state"])],
          };
        }
        if (ctx.now().getTime() < deadline + settleAfterMs)
          return { status: "inconclusive", reason: "the issue is not visible yet" };
        return {
          status: "failed",
          final: true,
          reason: "no issue carries the idempotency marker",
          evidence: [
            ctx.evidence.stateObservation(
              ["state"],
              { ref: `resource://github/${owner}/${repo}`, type: "repository" },
              { searched: issues.length, found: false },
            ),
          ],
        };
      },
      "work.assign": byIssue((issue, input) => {
        const login = loginOf(input["assignee"] as string).toLowerCase();
        return (issue.assignees ?? []).some((a) => a.login.toLowerCase() === login)
          ? {
              work: { ref: input["work"] as string },
              assignee: input["assignee"] as string,
              assigned_at: issue.updated_at,
            }
          : undefined;
      }),
      "work.complete": byIssue((issue, input) =>
        issue.state === "closed"
          ? {
              work: { ref: input["work"] as string },
              completed_at: issue.closed_at ?? issue.updated_at,
            }
          : undefined,
      ),
    },
  });
}
