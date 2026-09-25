# @runtime-protocol/adapter-slack

Implements `communication.send` with the `chat` profile using Slack's
`chat.postMessage`.

```ts
import { createSlackProvider } from "@runtime-protocol/adapter-slack";

const provider = createSlackProvider({
  workspace: "T0123456",
  conversations: { "identity://team/support": "C0123456789" },
});
```

| Capability           | Profiles | Traits                                       | Reconciliation |
| -------------------- | -------- | -------------------------------------------- | -------------- |
| `communication.send` | `chat`   | `delivery_receipt`, `rich_text`, `threading` | supported      |

- **Recipients.** Identity references map to Slack conversation IDs through
  `conversations` (a record or a function). Unmapped recipients and conversations that
  refuse the message are returned in `rejected_recipients`; the send fails only when
  no recipient received it.
- **Content.** `subject` becomes a bold first line; `rich_content` must be markdown
  (sent as `markdown_text`); `thread` must reference a message of the recipients'
  conversation. The message reference is
  `resource://slack/<workspace>/<channel>/<ts>`.
- **Credentials.** A bot token, `Authorization: Bearer` from `ctx.credential()`.
  Accepted owners: `organization` (BYOK), `workload`. Scopes: `chat:write` to send;
  `channels:history` and `groups:history` to reconcile.
- **Evidence.** One `provider_receipt` per delivered message, claiming `execution` and
  `delivery` (Slack answered `ok` with the message timestamp).
- **Uncertain outcomes.** Every message carries the invocation's idempotency key as
  message metadata. A lost answer leaves the execution `unknown`; reconciliation reads
  the conversation history and completes it with a `state_observation` when the
  message is there. The absence of the message proves non-delivery only
  `settleAfterMs` (default five minutes) after the invocation deadline; before that,
  reconciliation is inconclusive.
