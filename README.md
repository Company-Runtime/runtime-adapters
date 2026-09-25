# Runtime Adapters

Official adapters that implement [Runtime Protocol](https://github.com/Company-Runtime/runtime-protocol)
`runtime/0.1` capabilities on concrete systems, built with the
[Runtime SDK](https://github.com/Company-Runtime/runtime-sdk).

> **Status: experimental.** Adapters track the unreleased `runtime/0.1` protocol and
> the SDK commit pinned in each `package.json`.

An adapter is a **boundary translator**:

```text
Runtime semantics (CapabilityRequest → Invocation)
        ↓
Adapter boundary (this repository)
        ↓
Vendor API · MCP server · local system
```

Callers never name an adapter. They request an intent — `communication.send`,
`work.create` — and the runtime's resolver selects an eligible provider
deterministically. Swapping Slack for another chat system, GitHub for GitLab or one
model vendor for another changes configuration, not callers.

## Adapters

| Package                               | Directory             | Capabilities                                  | Notes                                                   |
| ------------------------------------- | --------------------- | --------------------------------------------- | ------------------------------------------------------- |
| `@runtime-protocol/adapter-openai`    | `ai/openai`           | `reasoning.generate`, `reasoning.classify`    | Any OpenAI-compatible Chat Completions endpoint         |
| `@runtime-protocol/adapter-anthropic` | `ai/anthropic`        | `reasoning.generate`, `reasoning.classify`    | Messages API; structured answers through a forced tool  |
| `@runtime-protocol/adapter-slack`     | `communication/slack` | `communication.send` (`chat`)                 | Reconciles uncertain deliveries from message metadata   |
| `@runtime-protocol/adapter-github`    | `engineering/github`  | `work.create`, `work.assign`, `work.complete` | Issues; reconciles from an idempotency marker and state |
| `@runtime-protocol/adapter-gitlab`    | `engineering/gitlab`  | `work.create`, `work.assign`, `work.complete` | Issues; reconciles from an idempotency marker and state |

Each adapter's README lists its profiles, traits, credentials, evidence and failure
mapping.

Adapters do **not** have to live here. Anyone may maintain an adapter in their own
repository — `acme/runtime-erp-adapter` — as long as it implements the protocol and
passes the provider conformance requirements. This repository holds only the adapters
the project maintains.

## The five rules

Every adapter — here or elsewhere — must follow these rules to be admitted by a runtime:

1. **Handle secrets transparently.** Consume only `CredentialRef`s
   (`secret://<owner>/<path>`), materialized by the runtime's broker at dispatch
   through `ctx.credential()`. Never store, log, hard-code or return a key. Error
   messages from vendors are redacted before they leave the adapter.
2. **Prove, not assert.** Return evidence for every claim — a `provider_receipt` for
   what the vendor answered, a `state_observation` for state read back. `completed`
   without evidence is not completion.
3. **Be honest about uncertainty.** A request that never left is
   `provider_unavailable`; a refusal is `failed`; a timeout, a dropped connection or a
   server error after sending is `unknown`. Mutating capabilities declare
   `idempotency` or implement reconciliation, so an `unknown` outcome is established
   without repeating the effect.
4. **Respect the schemas.** Input is validated against the capability input schema
   before any call (by `defineProvider`); output matches the output schema exactly.
5. **Keep the core pure.** Proprietary behaviour goes under `vendor.<vendor>.*` or
   `community.<author>.*`, never into core identifiers. Vendor detail in evidence goes
   in `data`, never in the vocabulary.

In this repository the rules are enforced by tests: every adapter runs the SDK
provider harness (`PC-001`–`PC-010`) against a simulated vendor API, and
[`test/substitution.test.ts`](test/substitution.test.ts) runs the same intents
through interchangeable adapters.

## Using an adapter

```ts
import { createRuntime, EnvCredentialBroker, GrantAuthority } from "@runtime-protocol/sdk";
import { createSlackProvider } from "@runtime-protocol/adapter-slack";

const runtime = createRuntime({
  providers: [createSlackProvider({ conversations: { "identity://team/support": "C0123456789" } })],
  authority: new GrantAuthority([
    {
      id: "support",
      authority: "authority://company/support-manager",
      subjects: ["identity://agent/support-agent"],
      capabilities: ["communication.send"],
    },
  ]),
  // The token stays in RUNTIME_SECRET_ORGANIZATION_PROVIDERS_SLACK; bindings hold references.
  credentials: {
    bindings: [{ provider: "slack", ref: "secret://organization/providers/slack" }],
    broker: new EnvCredentialBroker(),
  },
});

await runtime.execute({
  capability: "communication.send",
  profile: "chat",
  actor: "identity://agent/support-agent",
  input: { recipients: ["identity://team/support"], content: "Version 42 is live." },
});
```

Adapters run wherever the runtime runs them: in process (as above), behind the
`http/0.1` provider API in a sidecar or container (`createProviderHttpHandler` from
`@runtime-protocol/sdk/http`), or as tools of an MCP server.

### Installing

Until the packages are published, install an adapter and the SDK from Git at a commit,
and allow their build scripts (pnpm 10):

```bash
pnpm add "github:Company-Runtime/runtime-sdk#<commit>" "github:Company-Runtime/runtime-adapters#<commit>&path:/communication/slack"
```

```json
{
  "pnpm": {
    "onlyBuiltDependencies": ["@runtime-protocol/sdk", "@runtime-protocol/adapter-slack"]
  }
}
```

## Development

```bash
pnpm install     # installs the pinned SDK from Git and builds every package
pnpm run ci      # format, types, build, tests
```

Tests never call real vendors: [`testing/fake-api.ts`](testing/fake-api.ts) simulates
each API, including lost answers and unreachable hosts. See
[CONTRIBUTING.md](CONTRIBUTING.md) to add an adapter.

## License

[Apache License 2.0](LICENSE).
