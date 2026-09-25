import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyReceipt, type Json } from "@runtime-protocol/sdk";
import { runProviderHarness } from "@runtime-protocol/sdk/conformance";
import { createGitLabProvider } from "../src/index.ts";
import { fakeApi, type FakeAnswer } from "../../../testing/fake-api.ts";
import { AGENT, runtimeFor } from "../../../testing/runtime.ts";

const KEY = { ref: "secret://organization/providers/gitlab", value: "canary-gitlab-token-6b0a" };
const users = {
  "identity://user/ana": 101,
  "identity://user/bruno": 102,
  "identity://user/guest": 999,
};
const PROJECT = "resource://gitlab/acme/support";
const ASSIGNABLE = new Set([101, 102]);

interface Issue {
  id: number;
  iid: number;
  title: string;
  description: string;
  labels: string[];
  due_date: string | null;
  state: string;
  assignees: Array<{ id: number }>;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

/** A GitLab project `acme/support` with issues. */
function gitlab(options: { delayMs?: number; create?: () => FakeAnswer | undefined } = {}) {
  const issues: Issue[] = [];
  const notes: string[] = [];
  let tick = 0;
  const now = () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)).toISOString();
  const find = (iid: string) => issues.find((i) => i.iid === Number(iid));
  const later = (answer: FakeAnswer): FakeAnswer =>
    options.delayMs ? { ...answer, delayMs: options.delayMs } : answer;
  const base = /^\/projects\/acme%2Fsupport\/issues/;
  const api = fakeApi("https://gitlab.com/api/v4", [
    [
      "POST",
      new RegExp(`${base.source}$`),
      (request) => {
        if (request.headers.get("authorization") !== `Bearer ${KEY.value}`)
          return { status: 401, body: { message: "401 Unauthorized" } };
        const custom = options.create?.();
        if (custom?.status) return custom;
        const body = request.body as Json;
        const at = now();
        const issue: Issue = {
          id: 5000 + issues.length,
          iid: issues.length + 1,
          title: String(body["title"]),
          description: String(body["description"] ?? ""),
          labels: body["labels"] ? String(body["labels"]).split(",") : [],
          due_date: (body["due_date"] as string | undefined) ?? null,
          state: "opened",
          assignees: ((body["assignee_ids"] as number[] | undefined) ?? [])
            .filter((id) => ASSIGNABLE.has(id))
            .map((id) => ({ id })),
          created_at: at,
          updated_at: at,
          closed_at: null,
        };
        issues.push(issue);
        return later({ status: 201, body: issue, ...custom });
      },
    ],
    ["GET", new RegExp(`${base.source}$`), () => ({ body: [...issues].reverse() })],
    [
      "GET",
      new RegExp(`${base.source}/(\\d+)$`),
      (_r, m) =>
        find(m[1]!) ? { body: find(m[1]!) } : { status: 404, body: { message: "404 Not found" } },
    ],
    [
      "PUT",
      new RegExp(`${base.source}/(\\d+)$`),
      (request, m) => {
        const issue = find(m[1]!);
        if (!issue) return { status: 404, body: { message: "404 Not found" } };
        const body = request.body as Json;
        if (body["assignee_ids"])
          issue.assignees = (body["assignee_ids"] as number[])
            .filter((id) => ASSIGNABLE.has(id))
            .map((id) => ({ id }));
        if (body["state_event"] === "close") {
          issue.state = "closed";
          issue.closed_at ??= now();
        }
        issue.updated_at = now();
        return later({ body: issue });
      },
    ],
    [
      "POST",
      new RegExp(`${base.source}/(\\d+)/notes$`),
      (request) => {
        notes.push(String((request.body as Json)["body"]));
        return { status: 201, body: { id: notes.length } };
      },
    ],
  ]);
  return { ...api, issues, notes };
}

const seed = (): Issue => ({
  id: 1,
  iid: 1,
  title: "Seed",
  description: "",
  labels: [],
  due_date: null,
  state: "opened",
  assignees: [],
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  closed_at: null,
});

test("the GitLab adapter meets every provider requirement", async () => {
  const api = gitlab({ delayMs: 20 });
  api.issues.push(seed());
  const provider = createGitLabProvider({ users, fetch: api.fetch });
  const credential = KEY;
  const report = await runProviderHarness(provider, [
    {
      capability: "work.create",
      input: { title: "Refund order 981", container: PROJECT },
      credential,
      abortAfterMs: 5,
    },
    {
      capability: "work.assign",
      input: { work: `${PROJECT}/issues/1`, assignee: "identity://user/ana" },
      credential,
      abortAfterMs: 5,
    },
    {
      capability: "work.complete",
      input: { work: `${PROJECT}/issues/1`, resolution: "Refunded." },
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
  const api = gitlab();
  const { runtime, events } = runtimeFor(
    createGitLabProvider({ users, project: "acme/support", fetch: api.fetch }),
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
      due: "2026-01-05T12:00:00Z",
      assignee: "identity://user/bruno",
    },
  });
  assert.equal(created.execution.state, "completed", JSON.stringify(created.error));
  const work = (created.execution.output as { work: { ref: string } }).work.ref;
  assert.equal(work, `${PROJECT}/issues/1`);
  const issue = api.issues[0]!;
  assert.deepEqual(issue.labels, ["billing", "priority::high"]);
  assert.equal(issue.due_date, "2026-01-05");
  assert.deepEqual(issue.assignees, [{ id: 102 }]);
  assert.match(issue.description, /<!-- runtime-protocol:idempotency-key ticket-981 -->$/);

  const assigned = await runtime.execute({
    capability: "work.assign",
    actor: AGENT,
    input: { work, assignee: "identity://user/ana" },
  });
  assert.equal(assigned.execution.state, "completed", JSON.stringify(assigned.error));
  assert.deepEqual(
    issue.assignees,
    [{ id: 102 }, { id: 101 }],
    "assignment adds, it never replaces",
  );

  const completed = await runtime.execute({
    capability: "work.complete",
    actor: AGENT,
    input: { work, resolution: "Refunded." },
  });
  assert.equal(completed.execution.state, "completed", JSON.stringify(completed.error));
  assert.equal(issue.state, "closed");
  assert.ok(completed.receipt && verifyReceipt(completed.receipt));
  assert.deepEqual(
    events.events.map((e) => e.type),
    ["work.created", "work.assigned", "work.completed"],
  );
  assert.ok(!JSON.stringify([created, assigned, completed]).includes(KEY.value));
});

test("a lost answer on creation is reconciled from the idempotency marker", async () => {
  let drop = true;
  const api = gitlab({ create: () => (drop ? { drop: true } : undefined) });
  const { runtime } = runtimeFor(
    createGitLabProvider({ users, fetch: api.fetch }),
    ["work.create"],
    KEY,
  );
  const first = await runtime.execute({
    capability: "work.create",
    actor: AGENT,
    input: { title: "Refund order 981", container: PROJECT },
  });
  assert.equal(first.execution.state, "unknown");
  drop = false;
  const settled = await runtime.reconcile(first.execution.execution_id);
  assert.equal(settled.execution.state, "completed", JSON.stringify(settled.error));
  assert.equal(api.issues.length, 1, "exactly one issue");
});

test("an assignment GitLab ignores fails, and foreign references are refused", async () => {
  const api = gitlab();
  api.issues.push(seed());
  const { runtime } = runtimeFor(
    createGitLabProvider({ users, fetch: api.fetch }),
    ["work.assign"],
    KEY,
  );
  const outsider = await runtime.execute({
    capability: "work.assign",
    actor: AGENT,
    input: { work: `${PROJECT}/issues/1`, assignee: "identity://user/guest" },
  });
  assert.equal(outsider.execution.state, "failed");
  assert.match(outsider.error?.message ?? "", /cannot be assigned/);
  const wrongContainer = await runtime.execute({
    capability: "work.assign",
    actor: AGENT,
    input: { work: "resource://github/acme/support/issues/1", assignee: "identity://user/ana" },
  });
  assert.equal(wrongContainer.execution.state, "failed");
});
