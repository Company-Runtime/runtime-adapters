import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyReceipt, type Json } from "@runtime-protocol/sdk";
import { runProviderHarness } from "@runtime-protocol/sdk/conformance";
import { createAnthropicProvider } from "../src/index.ts";
import { fakeApi } from "../../../testing/fake-api.ts";
import { AGENT, runtimeFor } from "../../../testing/runtime.ts";

const KEY = {
  ref: "secret://organization/providers/anthropic",
  value: "canary-anthropic-key-5c2d",
};
const LABELS = [
  { id: "billing", description: "Payments and invoices" },
  { id: "access", description: "Logins and passwords" },
];

interface MessagesBody {
  system?: string;
  messages: Array<{ role: string; content: string }>;
  tools?: Array<{ input_schema: Json }>;
  tool_choice?: { name: string };
}

/** Answers like the Messages API, deterministically. */
function anthropic(options: { stop?: string } = {}) {
  return fakeApi("https://api.anthropic.com", [
    [
      "POST",
      "/v1/messages",
      (request) => {
        const body = request.body as MessagesBody;
        const last = body.messages.at(-1)!.content;
        const schema = body.tools?.[0]?.input_schema;
        const content = !schema
          ? [{ type: "text", text: "Open Settings, then Security." }]
          : [
              {
                type: "tool_use",
                id: "toolu_1",
                name: body.tool_choice!.name,
                input:
                  "labels" in (schema["properties"] as Json)
                    ? {
                        labels: [
                          { id: /password/i.test(last) ? "access" : "billing", confidence: 0.8 },
                        ],
                      }
                    : schema["required"]?.toString() === "value"
                      ? { value: ["a", "b"] }
                      : { answer: "Open Settings, then Security." },
              },
            ];
        return {
          body: {
            id: "msg_1",
            type: "message",
            role: "assistant",
            model: "claude-test",
            content,
            stop_reason: options.stop ?? (schema ? "tool_use" : "end_turn"),
            usage: { input_tokens: 20, output_tokens: 9 },
          },
        };
      },
    ],
  ]);
}

test("the Anthropic adapter meets every provider requirement", async () => {
  const provider = createAnthropicProvider({ model: "claude-test", fetch: anthropic().fetch });
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
        messages: [
          { role: "system", content: "Be brief." },
          { role: "user", content: "I forgot my password." },
        ],
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
      input: { input: "I was charged twice", labels: LABELS, rationale: false },
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
});

test("reasoning.generate maps instructions, system turns and keys to the Messages API", async () => {
  const api = anthropic();
  const { runtime } = runtimeFor(
    createAnthropicProvider({ model: "claude-test", fetch: api.fetch }),
    ["reasoning.generate"],
    KEY,
  );
  const outcome = await runtime.execute({
    capability: "reasoning.generate",
    profile: "conversational",
    actor: AGENT,
    input: {
      instructions: "Help the customer.",
      messages: [
        { role: "system", content: "Be brief." },
        { role: "user", content: "I forgot my password." },
      ],
    },
  });
  assert.equal(outcome.execution.state, "completed", JSON.stringify(outcome.error));
  assert.equal((outcome.execution.output as Json)["content"], "Open Settings, then Security.");
  assert.ok(outcome.receipt && verifyReceipt(outcome.receipt));
  const call = api.calls[0]!;
  assert.equal(call.headers.get("x-api-key"), KEY.value);
  assert.equal(call.headers.get("anthropic-version"), "2023-06-01");
  assert.equal(call.body.system, "Help the customer.\n\nBe brief.");
  assert.deepEqual(call.body.messages, [{ role: "user", content: "I forgot my password." }]);
  assert.ok(!JSON.stringify(outcome).includes(KEY.value));
});

test("structured answers come from a forced tool call, also for non-object schemas", async () => {
  const api = anthropic();
  const { runtime } = runtimeFor(
    createAnthropicProvider({ model: "claude-test", fetch: api.fetch }),
    ["reasoning.generate"],
    KEY,
  );
  const outcome = await runtime.execute({
    capability: "reasoning.generate",
    actor: AGENT,
    traits: ["structured_output"],
    input: {
      instructions: "List two letters.",
      output_schema: { type: "array", items: { type: "string" } },
    },
  });
  assert.equal(outcome.execution.state, "completed", JSON.stringify(outcome.error));
  assert.deepEqual((outcome.execution.output as Json)["content"], { value: ["a", "b"] });
  assert.equal(api.calls[0]!.body.tool_choice.type, "tool");
});

test("stop reasons that prove an incomplete answer fail", async () => {
  for (const stop of ["max_tokens", "refusal"]) {
    const { runtime } = runtimeFor(
      createAnthropicProvider({ model: "claude-test", fetch: anthropic({ stop }).fetch }),
      ["reasoning.generate"],
      KEY,
    );
    const outcome = await runtime.execute({
      capability: "reasoning.generate",
      actor: AGENT,
      input: { instructions: "Hi" },
    });
    assert.equal(outcome.execution.state, "failed", stop);
    assert.equal(outcome.error?.code, "execution_failed", stop);
  }
});
