import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyReceipt, type Json } from "@runtime-protocol/sdk";
import { runProviderHarness } from "@runtime-protocol/sdk/conformance";
import { createGitHubProvider } from "../src/index.ts";
import { fakeApi, type FakeAnswer } from "../../../testing/fake-api.ts";
import { AGENT, runtimeFor } from "../../../testing/runtime.ts";

const KEY = { ref: "secret://organization/providers/github", value: "canary-github-token-1d9c" };
const users = {
  "identity://user/ana": "ana-dev",
  "identity://user/bruno": "bruno-ops",
  "identity://user/guest": "outside-collaborator",
};
const REPO = "resource://github/acme/support";
const ASSIGNABLE = new Set(["ana-dev", "bruno-ops"]);

interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  labels: string[];
  state: string;
  state_reason: string | null;
  assignees: Array<{ login: string }>;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

/** A GitHub repository `acme/support` with issues. */
function github(options: { delayMs?: number; create?: () => FakeAnswer | undefined } = {}) {
  const issues: Issue[] = [];
  const comments: string[] = [];
  let tick = 0;
  const now = () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)).toISOString();
  const find = (n: string) => issues.find((i) => i.number === Number(n));
  const auth = (headers: Headers) => headers.get("authorization") === `Bearer ${KEY.value}`;
  const later = (answer: FakeAnswer): FakeAnswer =>
    options.delayMs ? { ...answer, delayMs: options.delayMs } : answer;
  const api = fakeApi("https://api.github.com", [
    [
      "POST",
      /^\/repos\/acme\/support\/issues$/,
      (request) => {
        if (!auth(request.headers)) return { status: 401, body: { message: "Bad credentials" } };
        const custom = options.create?.();
        if (custom?.status) return custom;
        const body = request.body as Json;
        const at = now();
        const issue: Issue = {
          id: 9000 + issues.length,
          number: issues.length + 1,
          title: String(body["title"]),
          body: String(body["body"] ?? ""),
          labels: (body["labels"] as string[]) ?? [],
          state: "open",
          state_reason: null,
          assignees: ((body["assignees"] as string[] | undefined) ?? [])
            .filter((l) => ASSIGNABLE.has(l))
            .map((login) => ({ login })),
          created_at: at,
          updated_at: at,
          closed_at: null,
        };
        issues.push(issue);
        return later({ status: 201, body: issue, ...custom });
      },
    ],
    ["GET", /^\/repos\/acme\/support\/issues$/, () => ({ body: [...issues].reverse() })],
    [
      "GET",
      /^\/repos\/acme\/support\/issues\/(\d+)$/,
      (_r, m) =>
        find(m[1]!) ? { body: find(m[1]!) } : { status: 404, body: { message: "Not Found" } },
    ],
    [
      "POST",
      /^\/repos\/acme\/support\/issues\/(\d+)\/assignees$/,
      (request, m) => {
        const issue = find(m[1]!);
        if (!issue) return { status: 404, body: { message: "Not Found" } };
        for (const login of (request.body as { assignees: string[] }).assignees)
          if (ASSIGNABLE.has(login) && !issue.assignees.some((a) => a.login === login))
            issue.assignees.push({ login });
        issue.updated_at = now();
        return later({ status: 201, body: issue });
      },
    ],
    [
      "POST",
      /^\/repos\/acme\/support\/issues\/(\d+)\/comments$/,
      (request) => {
        comments.push(String((request.body as Json)["body"]));
        return { status: 201, body: { id: comments.length } };
      },
    ],
    [
      "PATCH",
      /^\/repos\/acme\/support\/issues\/(\d+)$/,
      (request, m) => {
        const issue = find(m[1]!);
        if (!issue) return { status: 404, body: { message: "Not Found" } };
        const body = request.body as Json;
        issue.state = String(body["state"]);
        issue.state_reason = String(body["state_reason"]);
        issue.closed_at ??= now();
        issue.updated_at = issue.closed_at;
        return later({ body: issue });
      },
    ],
  ]);
  return { ...api, issues, comments };
}

test("the GitHub adapter meets every provider requirement", async () => {
  const api = github({ delayMs: 20 });
  api.issues.push({
    id: 1,
    number: 1,
    title: "Seed",
    body: "",
    labels: [],
    state: "open",
    state_reason: null,
    assignees: [],
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    closed_at: null,
  });
  const provider = createGitHubProvider({ users, fetch: api.fetch });
  const credential = KEY;
  const report = await runProviderHarness(provider, [
    {
      capability: "work.create",
      input: { title: "Refund order 981", container: REPO },
      credential,
      abortAfterMs: 5,
    },
    {
      capability: "work.assign",
      input: { work: `${REPO}/issues/1`, assignee: "identity://user/ana" },
      credential,
      abortAfterMs: 5,
    },
    {
      capability: "work.complete",
      input: { work: `${REPO}/issues/1`, resolution: "Refunded." },
      credential,
      abortAfterMs: 5,
    },
  ]);
  assert.deepEqual(
    report.requirements.filter((r) => !r.passed),
    [],
  );
});

test("create, assign and complete an issue through a runtime", async () => {
  const api = github();
  const { runtime, events } = runtimeFor(
    createGitHubProvider({ users, repository: "acme/support", fetch: api.fetch }),
    ["work.create", "work.assign", "work.complete"],
    KEY,
  );
  const created = await runtime.execute({
    capability: "work.create",
    actor: AGENT,
    idempotency_key: "ticket-981",
    input: {
      title: "Refund order 981",
      description: "Customer was charged twice.",
      priority: "high",
      labels: ["billing"],
      due: "2026-01-05T00:00:00Z",
    },
    evidence: ["execution", "state"],
  });
  assert.equal(created.execution.state, "completed", JSON.stringify(created.error));
  const work = (created.execution.output as { work: { ref: string } }).work.ref;
  assert.equal(work, `${REPO}/issues/1`);
  const issue = api.issues[0]!;
  assert.deepEqual(issue.labels, ["billing", "priority: high"]);
  assert.match(
    issue.body,
    /^Customer was charged twice\.\n\nDue: 2026-01-05T00:00:00Z\n\n<!-- runtime-protocol:idempotency-key ticket-981 -->$/,
  );
  assert.equal(api.calls[0]!.headers.get("x-github-api-version"), "2022-11-28");

  const assigned = await runtime.execute({
    capability: "work.assign",
    actor: AGENT,
    input: { work, assignee: "identity://user/ana" },
  });
  assert.equal(assigned.execution.state, "completed", JSON.stringify(assigned.error));
  assert.deepEqual(issue.assignees, [{ login: "ana-dev" }]);

  const completed = await runtime.execute({
    capability: "work.complete",
    actor: AGENT,
    input: { work, resolution: "Refunded.", evidence: ["evidence://ev_refund_1"] },
  });
  assert.equal(completed.execution.state, "completed", JSON.stringify(completed.error));
  assert.equal(issue.state, "closed");
  assert.match(
    api.comments[0]!,
    /^Refunded\.\n\nEvidence: evidence:\/\/ev_refund_1\n\n<!-- runtime-protocol/,
  );
  assert.ok(completed.receipt && verifyReceipt(completed.receipt));
  assert.deepEqual(
    events.events.map((e) => e.type),
    ["work.created", "work.assigned", "work.completed"],
  );
  assert.ok(!JSON.stringify([created, assigned, completed, events.events]).includes(KEY.value));
});

test("a lost answer on creation is reconciled from the idempotency marker", async () => {
  let drop = true;
  const api = github({ create: () => (drop ? { drop: true } : undefined) });
  const { runtime } = runtimeFor(
    createGitHubProvider({ users, fetch: api.fetch }),
    ["work.create"],
    KEY,
  );
  const first = await runtime.execute({
    capability: "work.create",
    actor: AGENT,
    input: { title: "Refund order 981", container: REPO },
  });
  assert.equal(first.execution.state, "unknown");
  drop = false;
  const settled = await runtime.reconcile(first.execution.execution_id);
  assert.equal(settled.execution.state, "completed", JSON.stringify(settled.error));
  assert.equal(
    (settled.execution.output as { work: { ref: string } }).work.ref,
    `${REPO}/issues/1`,
  );
  assert.equal(api.issues.length, 1, "exactly one issue");
});

test("refusals never leave an effect behind", async () => {
  const api = github();
  api.issues.push({
    id: 1,
    number: 1,
    title: "Seed",
    body: "",
    labels: [],
    state: "open",
    state_reason: null,
    assignees: [],
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    closed_at: null,
  });
  const { runtime } = runtimeFor(
    createGitHubProvider({ users, fetch: api.fetch }),
    ["work.create", "work.assign"],
    KEY,
  );
  const unmapped = await runtime.execute({
    capability: "work.assign",
    actor: AGENT,
    input: { work: `${REPO}/issues/1`, assignee: "identity://user/nobody" },
  });
  assert.equal(unmapped.execution.state, "failed");
  assert.equal(api.calls.length, 0, "refused before any call");
  const outsider = await runtime.execute({
    capability: "work.assign",
    actor: AGENT,
    input: { work: `${REPO}/issues/1`, assignee: "identity://user/guest" },
  });
  assert.equal(outsider.execution.state, "failed");
  assert.match(outsider.error?.message ?? "", /cannot be assigned/);
  const missing = await runtime.execute({
    capability: "work.assign",
    actor: AGENT,
    input: { work: `${REPO}/issues/77`, assignee: "identity://user/ana" },
  });
  assert.equal(missing.execution.state, "failed");
  assert.match(missing.error?.message ?? "", /HTTP 404/);
  const noRepository = await runtime.execute({
    capability: "work.create",
    actor: AGENT,
    input: { title: "Anywhere" },
  });
  assert.equal(noRepository.execution.state, "failed");

  const wrongKey = runtimeFor(createGitHubProvider({ users, fetch: api.fetch }), ["work.create"], {
    ref: KEY.ref,
    value: "canary-revoked-0000",
  }).runtime;
  const unauthorized = await wrongKey.execute({
    capability: "work.create",
    actor: AGENT,
    input: { title: "x", container: REPO },
  });
  assert.equal(unauthorized.execution.state, "failed");
  assert.equal(unauthorized.error?.code, "credential_unavailable");
});
