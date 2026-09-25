import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createRuntime,
  GrantAuthority,
  InMemoryCredentialBroker,
  verifyReceipt,
  type CapabilityRequest,
  type Provider,
} from "@runtime-protocol/sdk";
import { createAnthropicProvider } from "../ai/anthropic/src/index.ts";
import { createOpenAIProvider } from "../ai/openai/src/index.ts";
import { createGitHubProvider } from "../engineering/github/src/index.ts";
import { createGitLabProvider } from "../engineering/gitlab/src/index.ts";
import { fakeApi } from "../testing/fake-api.ts";
import { AGENT } from "../testing/runtime.ts";

const keys = {
  "secret://organization/providers/openai": "canary-openai-sub-0001",
  "secret://organization/providers/anthropic": "canary-anthropic-sub-0002",
  "secret://organization/providers/github": "canary-github-sub-0003",
  "secret://organization/providers/gitlab": "canary-gitlab-sub-0004",
};

function runtimeWith(providers: Provider[]) {
  return createRuntime({
    providers,
    authority: new GrantAuthority([
      {
        id: "agent",
        authority: "authority://company/operations",
        subjects: [AGENT],
        capabilities: ["reasoning.generate", "work.create"],
      },
    ]),
    credentials: {
      bindings: providers.map((p) => ({
        provider: p.manifest.provider.id,
        ref: `secret://organization/providers/${p.manifest.provider.id}`,
      })),
      broker: new InMemoryCredentialBroker(keys),
    },
  });
}

const openai = fakeApi("https://api.openai.com/v1", [
  [
    "POST",
    "/chat/completions",
    () => ({
      body: {
        id: "chatcmpl-1",
        model: "gpt-test",
        choices: [{ message: { content: "Open Settings, then Security." }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 6 },
      },
    }),
  ],
]);
const anthropic = fakeApi("https://api.anthropic.com", [
  [
    "POST",
    "/v1/messages",
    () => ({
      body: {
        id: "msg_1",
        model: "claude-test",
        content: [{ type: "text", text: "Go to Settings → Security." }],
        stop_reason: "end_turn",
        usage: { input_tokens: 11, output_tokens: 5 },
      },
    }),
  ],
]);
const created = (ref: number) => ({
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  state: "open",
  assignees: [],
  ...{ number: ref, iid: ref },
});
const github = fakeApi("https://api.github.com", [
  ["POST", "/repos/acme/support/issues", () => ({ status: 201, body: created(7) })],
]);
const gitlab = fakeApi("https://gitlab.com/api/v4", [
  ["POST", "/projects/acme%2Fsupport/issues", () => ({ status: 201, body: created(3) })],
]);

/** One intent per capability. None names a provider, a vendor, a model or a key. */
const generate: CapabilityRequest = {
  protocol: "runtime/0.1",
  request_id: "req_generate",
  capability: { id: "reasoning.generate", version: "^0.1" },
  actor: { ref: AGENT, type: "agent" },
  input: { instructions: "Tell the customer how to reset their password." },
};
const createWork: CapabilityRequest = {
  protocol: "runtime/0.1",
  request_id: "req_work",
  capability: { id: "work.create", version: "^0.1" },
  actor: { ref: AGENT, type: "agent" },
  input: { title: "Refund order 981", priority: "high" },
  evidence: { require: ["execution", "state"] },
};

test("reasoning.generate: OpenAI and Anthropic serve the same intent", async () => {
  for (const provider of [
    createOpenAIProvider({ model: "gpt-test", fetch: openai.fetch }),
    createAnthropicProvider({ model: "claude-test", fetch: anthropic.fetch }),
  ]) {
    const runtime = runtimeWith([provider]);
    const outcome = await runtime.execute(generate);
    assert.equal(outcome.execution.state, "completed", JSON.stringify(outcome.error));
    assert.equal(outcome.execution.provider?.id, provider.manifest.provider.id);
    assert.ok(outcome.receipt && verifyReceipt(outcome.receipt));
    assert.equal(outcome.receipt.receipt.credential_owner, "organization");
    const capability = runtime.registry.capability("reasoning.generate")!;
    assert.deepEqual(
      runtime.registry.schemas.validate(
        runtime.registry.outputSchemaId(capability),
        outcome.execution.output,
      ),
      [],
    );
  }
});

test("work.create: GitHub and GitLab serve the same intent, and one replaces the other", async () => {
  const providers = [
    createGitHubProvider({ repository: "acme/support", fetch: github.fetch }),
    createGitLabProvider({ project: "acme/support", fetch: gitlab.fetch }),
  ];
  const refs: string[] = [];
  for (const provider of providers) {
    const outcome = await runtimeWith([provider]).execute(createWork);
    assert.equal(outcome.execution.state, "completed", JSON.stringify(outcome.error));
    refs.push((outcome.execution.output as { work: { ref: string } }).work.ref);
  }
  assert.deepEqual(refs, [
    "resource://github/acme/support/issues/7",
    "resource://gitlab/acme/support/issues/3",
  ]);

  // Both available: resolution is deterministic; when one becomes unavailable, the other serves.
  const runtime = runtimeWith(providers);
  assert.equal((await runtime.execute(createWork)).execution.provider?.id, "github");
  runtime.setProviderAvailability("github", false);
  const failover = await runtime.execute({ ...createWork, request_id: "req_work_2" });
  assert.equal(failover.execution.state, "completed");
  assert.equal(failover.execution.provider?.id, "gitlab");
});
