# @runtime-protocol/adapter-anthropic

Implements `reasoning.generate` and `reasoning.classify` with the Anthropic Messages
API.

```ts
import { createAnthropicProvider } from "@runtime-protocol/adapter-anthropic";

const provider = createAnthropicProvider({ model: "<model>", maxTokens: 4096 });
```

The operator chooses the model; callers never do.

| Capability           | Profiles         | Traits              |
| -------------------- | ---------------- | ------------------- |
| `reasoning.generate` | `conversational` | `structured_output` |
| `reasoning.classify` | —                | `batch`             |

- **Input mapping.** `instructions`, `language`, `max_output_chars`, `context` and any
  `system` turns become the `system` prompt; user and assistant turns are sent as
  messages. Structured answers (`output_schema`, classification) use a forced tool
  call whose input schema is the requested schema; non-object schemas are wrapped as
  `{ "value": … }`. Answers are validated before completion.
- **Credentials.** `x-api-key` from `ctx.credential()`, with `anthropic-version:
2023-06-01`. Accepted owners: `organization` (BYOK), `runtime` (managed), `workload`.
- **Evidence.** A `provider_receipt` (`execution`) with the message IDs, models and
  RFC 8785 digests of the responses. Usage is reported in tokens.
- **Failures.** `stop_reason` `refusal` or `max_tokens`, a missing structured answer
  and invalid answers fail with `execution_failed`; 401 is `credential_unavailable`;
  429 is retryable `provider_unavailable`.
- **Not declared.** `tool_use` and `streaming`.
