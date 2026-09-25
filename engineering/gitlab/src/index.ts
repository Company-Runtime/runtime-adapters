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

export interface GitLabProviderOptions {
  /** Provider identifier; defaults to `gitlab`. */
  id?: string;
  /** Project path (`group/project`, nested groups allowed) for work created without a `container`. */
  project?: string;
  /** Maps identity references to GitLab user IDs. Unmapped identities are refused, never guessed. */
  users?: Record<string, number> | ((identity: string) => number | undefined);
  /** Defaults to https://gitlab.com/api/v4 (self-managed: https://<host>/api/v4). */
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
  iid: number;
  web_url?: string;
  description?: string | null;
  state?: string;
  created_at: string;
  updated_at: string;
  closed_at?: string | null;
  assignees?: Array<{ id: number }>;
}

const API = "the GitLab API";
const HOUR_MS = 3_600_000;
const PROJECT = /^resource:\/\/gitlab\/(.+)$/;
const ISSUE = /^resource:\/\/gitlab\/(.+)\/issues\/(\d+)$/;

/** The marker that ties an issue to the invocation that created it, for reconciliation. */
const marker = (key: string) =>
  `<!-- runtime-protocol:idempotency-key ${encodeURIComponent(key)} -->`;

/**
 * Implements work.create, work.assign and work.complete with GitLab issues. Creation
 * leaves an idempotency marker in the description; assignment and completion are
 * reconciled by reading the issue.
 */
export function createGitLabProvider(options: GitLabProviderOptions = {}): Provider {
  const baseUrl = (options.baseUrl ?? "https://gitlab.com/api/v4").replace(/\/+$/, "");
  const settleAfterMs = options.settleAfterMs ?? 300_000;
  const users = options.users ?? {};
  const userOf = (identity: string) => {
    const id = typeof users === "function" ? users(identity) : users[identity];
    if (id === undefined) throw new ProviderFailure("the identity has no GitLab user configured");
    return id;
  };
  const issueRef = (project: string, iid: number) => `resource://gitlab/${project}/issues/${iid}`;
  const projectPath = (project: string) => `/projects/${encodeURIComponent(project)}`;
  const parseIssue = (ref: unknown) => {
    const match = typeof ref === "string" ? ISSUE.exec(ref) : null;
    if (!match) throw new ProviderFailure("the work is not a GitLab issue reference");
    return { project: match[1]!, iid: Number(match[2]) };
  };
  const projectOf = (container: unknown) => {
    if (container !== undefined) {
      const match = typeof container === "string" ? PROJECT.exec(container) : null;
      if (!match || ISSUE.test(container as string))
        throw new ProviderFailure("the container is not a GitLab project reference");
      return match[1]!;
    }
    if (!options.project)
      throw new ProviderFailure("no project: set a container or the adapter's default project");
    return options.project;
  };

  const gitlab = async <T>(
    ctx: HandlerContext,
    path: string,
    init: { method?: string; body?: Json; query?: Record<string, string> } = {},
  ) => {
    const key = await ctx.credential();
    const { body } = await fetchJson<T>(`${baseUrl}${path}`, {
      api: API,
      ...init,
      headers: key ? { authorization: `Bearer ${key}` } : {},
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
        iid: issue.iid,
        state: issue.state ?? null,
        assignee_ids: (issue.assignees ?? []).map((a) => a.id),
        updated_at: issue.updated_at,
      },
    );

  /** Reconciliation by reading one issue: `settled(issue)` tells whether the effect is there. */
  const byIssue =
    (settled: (issue: Issue, input: Json) => Json | undefined): ReconcileHandler =>
    async (input, ctx) => {
      const { project, iid } = parseIssue(input["work"]);
      let issue: Issue;
      try {
        issue = await gitlab<Issue>(ctx, `${projectPath(project)}/issues/${iid}`);
      } catch {
        return { status: "inconclusive", reason: "the issue could not be read" };
      }
      const ref = issueRef(project, iid);
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
    id: options.id ?? "gitlab",
    name: "GitLab",
    adapter: { id: "runtime-adapter-gitlab", version: "0.1.0", system: "gitlab" },
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
        const project = projectOf(input["container"]);
        const assignee =
          typeof input["assignee"] === "string" ? userOf(input["assignee"]) : undefined;
        const key = ctx.idempotencyKey ?? ctx.invocation.invocation_id;
        const description = [
          input["description"],
          input["parent"] ? `Part of ${String(input["parent"])}` : undefined,
          marker(key),
        ]
          .filter((part) => typeof part === "string" && part.length > 0)
          .join("\n\n");
        const labels = [
          ...((input["labels"] as string[] | undefined) ?? []),
          ...(input["priority"] ? [`priority::${String(input["priority"])}`] : []),
        ];
        const issue = await gitlab<Issue>(ctx, `${projectPath(project)}/issues`, {
          body: {
            title: input["title"] as string,
            description,
            ...(labels.length > 0 ? { labels: labels.join(",") } : {}),
            ...(assignee !== undefined ? { assignee_ids: [assignee] } : {}),
            ...(typeof input["due"] === "string" ? { due_date: input["due"].slice(0, 10) } : {}),
          },
        });
        const ref = issueRef(project, issue.iid);
        return {
          output: { work: { ref, created_at: issue.created_at } },
          evidence: [
            ctx.evidence.providerReceipt(["execution"], {
              issue_id: issue.id ?? null,
              iid: issue.iid,
              url: issue.web_url ?? null,
            }),
            observe(ctx, ref, issue, ["state"]),
          ],
        };
      },
      "work.assign": async (input, ctx) => {
        const { project, iid } = parseIssue(input["work"]);
        const user = userOf(input["assignee"] as string);
        const path = `${projectPath(project)}/issues/${iid}`;
        const current = await gitlab<Issue>(ctx, path);
        const ids = [...new Set([...(current.assignees ?? []).map((a) => a.id), user])];
        const issue = await gitlab<Issue>(ctx, path, {
          method: "PUT",
          body: { assignee_ids: ids },
        });
        if (!(issue.assignees ?? []).some((a) => a.id === user))
          throw new ProviderFailure(
            "GitLab did not assign the user; they cannot be assigned to this issue",
          );
        const ref = issueRef(project, iid);
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
        const { project, iid } = parseIssue(input["work"]);
        const path = `${projectPath(project)}/issues/${iid}`;
        const notes = [
          typeof input["resolution"] === "string" ? input["resolution"] : undefined,
          ...((input["evidence"] as string[] | undefined) ?? []).map((ref) => `Evidence: ${ref}`),
        ].filter(Boolean);
        if (notes.length > 0)
          await gitlab(ctx, `${path}/notes`, {
            body: {
              body: [...notes, marker(ctx.idempotencyKey ?? ctx.invocation.invocation_id)].join(
                "\n\n",
              ),
            },
          });
        const issue = await gitlab<Issue>(ctx, path, {
          method: "PUT",
          body: { state_event: "close" },
        });
        const ref = issueRef(project, iid);
        return {
          output: { work: { ref }, completed_at: issue.closed_at ?? issue.updated_at },
          evidence: [observe(ctx, ref, issue, ["execution", "state"])],
        };
      },
    },
    reconcile: {
      "work.create": async (input, ctx) => {
        const project = projectOf(input["container"]);
        const needle = marker(ctx.idempotencyKey ?? ctx.invocation.invocation_id);
        const deadline = Date.parse(ctx.invocation.deadline);
        let issues: Issue[];
        try {
          issues = await gitlab<Issue[]>(ctx, `${projectPath(project)}/issues`, {
            query: {
              created_after: new Date(deadline - HOUR_MS).toISOString(),
              per_page: "100",
              order_by: "created_at",
              sort: "desc",
            },
          });
        } catch {
          return { status: "inconclusive", reason: "the project issues could not be read" };
        }
        const issue = issues.find((i) => (i.description ?? "").includes(needle));
        if (issue) {
          const ref = issueRef(project, issue.iid);
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
              { ref: `resource://gitlab/${project}`, type: "project" },
              { searched: issues.length, found: false },
            ),
          ],
        };
      },
      "work.assign": byIssue((issue, input) => {
        const user = userOf(input["assignee"] as string);
        return (issue.assignees ?? []).some((a) => a.id === user)
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
