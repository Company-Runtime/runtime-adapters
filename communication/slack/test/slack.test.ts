import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyReceipt, type Json } from "@runtime-protocol/sdk";
import { runProviderHarness } from "@runtime-protocol/sdk/conformance";
import { createSlackProvider } from "../src/index.ts";
import { fakeApi, type FakeAnswer } from "../../../testing/fake-api.ts";
import { AGENT, runtimeFor } from "../../../testing/runtime.ts";

const KEY = { ref: "secret://organization/providers/slack", value: "canary-slack-token-8e4b" };
const SUPPORT = "identity://team/support";
const ONCALL = "identity://team/oncall";
const conversations = { [SUPPORT]: "C0SUPPORT", [ONCALL]: "C0ONCALL" };

/** A Slack workspace: channels keep their messages, with metadata. */
function slack(options: { delayMs?: number; post?: (body: Json) => FakeAnswer | undefined } = {}) {
  const channels = new Map<string, Array<{ ts: string; text?: string; metadata?: Json }>>();
  let clock = 1_700_000_000;
  const api = fakeApi("https://slack.com/api", [
    [
      "POST",
      "/chat.postMessage",
      (request) => {
        if (request.headers.get("authorization") !== `Bearer ${KEY.value}`)
          return { body: { ok: false, error: "invalid_auth" } };
        const body = request.body as Json;
        const custom = options.post?.(body);
        // An error answer means Slack did not post; a dropped connection happens after posting.
        if (custom?.status && custom.status >= 400) return custom;
        const channel = String(body["channel"]);
        if (channel === "C0ARCHIVED") return { body: { ok: false, error: "is_archived" } };
        const ts = `${clock++}.000100`;
        channels.set(channel, [
          ...(channels.get(channel) ?? []),
          {
            ts,
            text: String(body["text"] ?? body["markdown_text"]),
            metadata: body["metadata"] as Json,
          },
        ]);
        return {
          body: { ok: true, channel, ts },
          ...(options.delayMs ? { delayMs: options.delayMs } : {}),
          ...custom,
        };
      },
    ],
    [
      "GET",
      "/conversations.history",
      (request) => ({
        body: {
          ok: true,
          messages: [
            ...(channels.get(request.url.searchParams.get("channel") ?? "") ?? []),
          ].reverse(),
        },
      }),
    ],
  ]);
  return { ...api, channels };
}

const sample = {
  capability: "communication.send",
  profile: "chat",
  traits: ["delivery_receipt"],
  input: { recipients: [SUPPORT], subject: "Deploy", content: "Version 42 is live." },
  credential: KEY,
};

test("the Slack adapter meets every provider requirement", async () => {
  const api = slack({ delayMs: 20 });
  const provider = createSlackProvider({ conversations, fetch: api.fetch });
  const report = await runProviderHarness(provider, [{ ...sample, abortAfterMs: 5 }]);
  assert.deepEqual(
    report.requirements.filter((r) => !r.passed),
    [],
  );
});

test("communication.send posts once per conversation with the idempotency key as metadata", async () => {
  const api = slack();
  const { runtime, events } = runtimeFor(
    createSlackProvider({ conversations, workspace: "T0ACME", fetch: api.fetch }),
    ["communication.send"],
    KEY,
  );
  const outcome = await runtime.execute({
    capability: "communication.send",
    profile: "chat",
    traits: ["delivery_receipt"],
    actor: AGENT,
    idempotency_key: "deploy-42",
    input: {
      recipients: [SUPPORT, ONCALL, "identity://team/unknown"],
      content: "Version 42 is live.",
    },
    evidence: ["execution", "delivery"],
  });
  assert.equal(outcome.execution.state, "completed", JSON.stringify(outcome.error));
  const output = outcome.execution.output as Json;
  assert.match(
    String((output["message"] as Json)["ref"]),
    /^resource:\/\/slack\/T0ACME\/C0SUPPORT\/\d+\.\d+$/,
  );
  assert.deepEqual(output["accepted_recipients"], [SUPPORT, ONCALL]);
  assert.deepEqual(output["rejected_recipients"], [
    {
      recipient: "identity://team/unknown",
      reason: "no Slack conversation is configured for this recipient",
    },
  ]);
  assert.equal(api.calls.length, 2);
  assert.deepEqual(api.calls[0]!.body.metadata, {
    event_type: "runtime_protocol_message",
    event_payload: { idempotency_key: "deploy-42" },
  });
  assert.ok(outcome.receipt && verifyReceipt(outcome.receipt));
  assert.equal(events.ofType("communication.sent").length, 1);
  const evidence = await runtime.listEvidence(outcome.execution.execution_id);
  assert.equal(evidence.length, 2);
  assert.ok(evidence.every((e) => e.claims.includes("delivery")));
  assert.ok(!JSON.stringify([outcome, evidence, events.events]).includes(KEY.value));
});

test("a lost Slack answer is unknown, and reconciliation finds the message without re-posting", async () => {
  let drop = true;
  const api = slack({ post: () => (drop ? { drop: true } : undefined) });
  const { runtime } = runtimeFor(
    createSlackProvider({ conversations, fetch: api.fetch }),
    ["communication.send"],
    KEY,
  );
  const request = {
    request_id: "req_deploy_42",
    capability: "communication.send",
    profile: "chat",
    actor: AGENT,
    input: { recipients: [SUPPORT], content: "Version 42 is live." },
  };
  const first = await runtime.execute(request);
  assert.equal(first.execution.state, "unknown");
  assert.equal(
    api.channels.get("C0SUPPORT")?.length,
    1,
    "the message was posted; only the answer was lost",
  );
  drop = false;
  const again = await runtime.execute(request);
  assert.equal(
    again.execution.execution_id,
    first.execution.execution_id,
    "resubmission never re-sends",
  );
  const settled = await runtime.reconcile(first.execution.execution_id);
  assert.equal(settled.execution.state, "completed", JSON.stringify(settled.error));
  assert.equal(api.channels.get("C0SUPPORT")?.length, 1);
  assert.equal(api.calls.filter((c) => c.url.pathname.endsWith("chat.postMessage")).length, 1);
});

test("reconciliation proves non-delivery only after the settle window", async () => {
  const api = slack({ post: () => ({ status: 502, body: { ok: false } }) });
  const pending = runtimeFor(
    createSlackProvider({ conversations, fetch: api.fetch }),
    ["communication.send"],
    KEY,
  ).runtime;
  const request = {
    capability: "communication.send",
    profile: "chat",
    actor: AGENT,
    input: { recipients: [SUPPORT], content: "Hello" },
  };
  const unknown = await pending.execute(request);
  assert.equal(unknown.execution.state, "unknown");
  // Inside the settle window the absence of the message proves nothing yet.
  assert.equal(
    (await pending.reconcile(unknown.execution.execution_id)).execution.state,
    "unknown",
  );

  const settled = runtimeFor(
    createSlackProvider({ conversations, settleAfterMs: -60_000, fetch: api.fetch }),
    ["communication.send"],
    KEY,
  ).runtime;
  const second = await settled.execute(request);
  assert.equal(second.execution.state, "unknown");
  const final = await settled.reconcile(second.execution.execution_id);
  assert.equal(final.execution.state, "failed");
  assert.equal(final.error?.detail, "reconciled_not_applied");
});

test("refusals: archived conversations, bad credentials and unsupported formats", async () => {
  const api = slack();
  const archived = runtimeFor(
    createSlackProvider({ conversations: { [SUPPORT]: "C0ARCHIVED" }, fetch: api.fetch }),
    ["communication.send"],
    KEY,
  ).runtime;
  const refused = await archived.execute({
    capability: "communication.send",
    profile: "chat",
    actor: AGENT,
    input: { recipients: [SUPPORT], content: "Hi" },
  });
  assert.equal(refused.execution.state, "failed", JSON.stringify(refused.error));
  assert.match(refused.error?.message ?? "", /is_archived/);

  const wrongKey = runtimeFor(
    createSlackProvider({ conversations, fetch: api.fetch }),
    ["communication.send"],
    { ref: KEY.ref, value: "canary-revoked-token-0000" },
  ).runtime;
  const unauthorized = await wrongKey.execute({
    capability: "communication.send",
    profile: "chat",
    actor: AGENT,
    input: { recipients: [SUPPORT], content: "Hi" },
  });
  assert.equal(unauthorized.execution.state, "failed");
  assert.equal(unauthorized.error?.code, "credential_unavailable");

  const before = api.calls.length;
  const html = await wrongKey.execute({
    capability: "communication.send",
    profile: "chat",
    actor: AGENT,
    traits: ["rich_text"],
    input: {
      recipients: [SUPPORT],
      content: "Hi",
      rich_content: { format: "html", body: "<b>Hi</b>" },
    },
  });
  assert.equal(html.execution.state, "failed", JSON.stringify(html.error));
  assert.equal(api.calls.length, before, "nothing was sent");
});
