import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyReceipt, type Json } from "@runtime-protocol/sdk";
import { runProviderHarness } from "@runtime-protocol/sdk/conformance";
import { createOpenAIProvider } from "../src/index.ts";
import { fakeApi, type FakeRequest } from "../../../testing/fake-api.ts";
import { AGENT, runtimeFor } from "../../../testing/runtime.ts";

const KEY = { ref: "secret://organization/providers/openai", value: "canary-openai-key-3a7f" };
const LABELS = [
  { id: "billing", description: "Payments and invoices" },
  { id: "access", description: "Logins and passwords" },
];

/** Answers like the Chat Completions API, deterministically. */
function openai(
  answer?: (request: FakeRequest) => { content?: string | null; refusal?: string; finish?: string },
) {
  return fakeApi("https://api.openai.com/v1", [
    [
      "POST",
      "/chat/completions",
      (request) => {
        const body = request.body as {
          messages: Array<{ content: string }>;
          response_format?: { json_schema: { schema: Json } };
        };
        const last = body.messages.at(-1)!.content;
        const schema = body.response_format?.json_schema.schema;
        const custom = answer?.(request);
        const content =
          custom?.content !== undefined
            ? custom.content
            : schema && "labels" in (schema["properties"] as Json)
              ? JSON.stringify({
                  labels: [{ id: /password/i.test(last) ? "access" : "billing", confidence: 0.9 }],
                })
              : schema
                ? JSON.stringify({ answer: "Open Settings, then Security." })
                : "Open Settings, then Security.";
        return {
          body: {
            id: `chatcmpl-${request.url.pathname.length}`,
            model: "gpt-test",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content, refusal: custom?.refusal ?? null },
                finish_reason: custom?.finish ?? "stop",
              },
            ],
            usage: { prompt_tokens: 12, completion_tokens: 7 },
          },
        };
      },
    ],
  ]);
}

test("the OpenAI adapter meets every provider requirement", async () => {
  const api = openai();
  const provider = createOpenAIProvider({ model: "gpt-test", fetch: api.fetch });
  const credential = KEY;
  const report = await runProviderHarness(provider, [
    {
      capability: "reasoning.generate",
      input: { instructions: "How do I reset my password?" },
      credential,
    },
    {
      capability: "reasoning.generate",
      profile: "conversational",
      input: {
        instructions: "Help the customer.",
        messages: [{ role: "user", content: "I forgot my password." }],
      },
      credential,
    },
    {
      capability: "reasoning.generate",
      traits: ["structured_output"],
      input: {
        instructions: "Answer the question.",
        output_schema: {
          type: "object",
          required: ["answer"],
          properties: { answer: { type: "string" } },
        },
      },
      credential,
    },
    {
      capability: "reasoning.classify",
      input: { input: "I was charged twice", labels: LABELS },
      credential,
    },
    {
      capability: "reasoning.classify",
      traits: ["batch"],
      input: { inputs: ["charged twice", "reset password"], labels: LABELS },
      credential,
    },
  ]);
  assert.deepEqual(
    report.requirements.filter((r) => !r.passed),
    [],
  );
  // Invalid inputs never reached the API.
  assert.ok(
    api.calls.every((call) => !JSON.stringify(call.body).includes("__conformance_invalid__")),
  );
});

test("reasoning.generate through a runtime: operator model, BYOK key, evidence and receipt", async () => {
  const api = openai();
  const { runtime } = runtimeFor(
    createOpenAIProvider({ model: "gpt-test", fetch: api.fetch }),
    ["reasoning.generate"],
    KEY,
  );
  const outcome = await runtime.execute({
    capability: "reasoning.generate",
    actor: AGENT,
    input: {
      instructions: "How do I reset my password?",
      context: ["Passwords are reset under Settings → Security."],
      language: "en",
    },
  });
  assert.equal(outcome.execution.state, "completed", JSON.stringify(outcome.error));
  assert.deepEqual(outcome.execution.output, {
    content: "Open Settings, then Security.",
    media_type: "text/plain",
    usage: { input_units: 12, output_units: 7, unit: "token" },
  });
  assert.ok(outcome.receipt && verifyReceipt(outcome.receipt));
  assert.equal(outcome.receipt.receipt.credential_owner, "organization");
  const call = api.calls[0]!;
  assert.equal(call.headers.get("authorization"), `Bearer ${KEY.value}`);
  assert.equal(call.body.model, "gpt-test");
  assert.equal(call.body.messages[0].role, "system");
  assert.match(call.body.messages[0].content, /Settings → Security/);
  const [evidence] = await runtime.listEvidence(outcome.execution.execution_id);
  assert.deepEqual(evidence?.claims, ["execution"]);
  assert.ok(!JSON.stringify([outcome, evidence]).includes(KEY.value));
});

test("reasoning.classify rejects answers outside the requested labels", async () => {
  const api = openai(() => ({
    content: JSON.stringify({ labels: [{ id: "refund", confidence: 1 }] }),
  }));
  const { runtime } = runtimeFor(
    createOpenAIProvider({ model: "gpt-test", fetch: api.fetch }),
    ["reasoning.classify"],
    KEY,
  );
  const outcome = await runtime.execute({
    capability: "reasoning.classify",
    actor: AGENT,
    input: { input: "refund me", labels: LABELS },
  });
  assert.equal(outcome.execution.state, "failed");
  assert.match(outcome.error?.message ?? "", /requested labels/);
});

test("vendor failures map to protocol outcomes", async () => {
  const cases: Array<[string, ReturnType<typeof openai>, string]> = [];
  const unauthorized = fakeApi("https://api.openai.com/v1", [
    [
      "POST",
      "/chat/completions",
      () => ({
        status: 401,
        body: { error: { message: `Incorrect API key provided: ${KEY.value}` } },
      }),
    ],
  ]);
  const overloaded = fakeApi("https://api.openai.com/v1", [
    ["POST", "/chat/completions", () => ({ status: 503, body: {} })],
  ]);
  const down = openai();
  down.down = true;
  cases.push(
    ["unauthorized", unauthorized, "credential_unavailable"],
    ["overloaded", overloaded, "execution_failed"],
    ["down", down, "provider_unavailable"],
  );
  for (const [label, api, code] of cases) {
    const { runtime } = runtimeFor(
      createOpenAIProvider({ model: "gpt-test", fetch: api.fetch }),
      ["reasoning.generate"],
      KEY,
    );
    const outcome = await runtime.execute({
      capability: "reasoning.generate",
      actor: AGENT,
      input: { instructions: "Hi" },
    });
    assert.equal(outcome.execution.state, "failed", label);
    assert.equal(outcome.error?.code, code, label);
    assert.ok(!JSON.stringify(outcome).includes(KEY.value), `${label}: the key is never echoed`);
  }
  const refusal = openai(() => ({ content: null, refusal: "I can't help with that." }));
  const { runtime } = runtimeFor(
    createOpenAIProvider({ model: "gpt-test", fetch: refusal.fetch }),
    ["reasoning.generate"],
    KEY,
  );
  const refused = await runtime.execute({
    capability: "reasoning.generate",
    actor: AGENT,
    input: { instructions: "Hi" },
  });
  assert.equal(refused.execution.state, "failed");
  assert.match(refused.error?.message ?? "", /refused/);
});

test("capabilities outside the declared traits never reach the vendor", async () => {
  const api = openai();
  const { runtime } = runtimeFor(
    createOpenAIProvider({ model: "gpt-test", fetch: api.fetch }),
    ["reasoning.generate"],
    KEY,
  );
  const outcome = await runtime.execute({
    capability: "reasoning.generate",
    actor: AGENT,
    input: { instructions: "Plan the rollout.", tools: [{ capability: "work.create" }] },
  });
  assert.equal(outcome.execution.state, "rejected");
  assert.equal(outcome.error?.code, "missing_trait");
  assert.equal(api.calls.length, 0);
});
