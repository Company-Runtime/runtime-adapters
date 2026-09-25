# @runtime-protocol/adapter-openai

Implements `reasoning.generate` and `reasoning.classify` with the Chat Completions API
of OpenAI or any OpenAI-compatible endpoint (set `baseUrl`).

```ts
import { createOpenAIProvider } from "@runtime-protocol/adapter-openai";

const provider = createOpenAIProvider({ model: "<model>", regions: ["us"] });
```

The operator chooses the model; callers never do.

| Capability           | Profiles         | Traits              |
| -------------------- | ---------------- | ------------------- |
| `reasoning.generate` | `conversational` | `structured_output` |
| `reasoning.classify` | —                | `batch`             |

- **Input mapping.** `instructions`, `language`, `max_output_chars` and `context`
  become the system message; the conversation (or the instructions alone) forms the
  user turns. `output_schema` becomes a JSON Schema response format, and the answer is
  validated against it before completion. Classification asks for labels from the
  requested set with confidences and rejects any other answer.
- **Credentials.** `Authorization: Bearer` from `ctx.credential()`. Accepted owners:
  `organization` (BYOK), `runtime` (managed), `workload`. For keyless local endpoints
  pass `credentials: { required: false, accepts: [] }`.
- **Evidence.** A `provider_receipt` (`execution`) with the response IDs, models and
  RFC 8785 digests of the responses. Usage is reported in tokens.
- **Failures.** Refusals, content filters, truncated answers, invalid JSON and labels
  outside the set fail with `execution_failed`; 401 is `credential_unavailable`; 429 is
  retryable `provider_unavailable`; an unreachable endpoint is `provider_unavailable`.
  Both capabilities are non-mutating, so an uncertain call fails and may be retried.
- **Not declared.** `tool_use` and `streaming`: requests that need them are rejected by
  the runtime before this adapter runs.
