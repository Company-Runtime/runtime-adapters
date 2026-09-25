import {
  defineProvider,
  fetchJson,
  ProviderFailure,
  type CredentialOwner,
  type EvidenceItem,
  type HandlerContext,
  type Json,
  type Provider,
} from "@runtime-protocol/sdk";

export interface SlackProviderOptions {
  /** Provider identifier; defaults to `slack`. */
  id?: string;
  /**
   * Maps recipient identity references to Slack conversation IDs (channels, direct
   * messages or user IDs). Recipients without a conversation are rejected, never guessed.
   */
  conversations: Record<string, string> | ((recipient: string) => string | undefined);
  /** Slack workspace identifier used in message references; defaults to `workspace`. */
  workspace?: string;
  /** Defaults to https://slack.com/api. */
  baseUrl?: string;
  /**
   * How long after an invocation's deadline the absence of its message proves that it was
   * not delivered; defaults to five minutes.
   */
  settleAfterMs?: number;
  /** Credential owners accepted; defaults to organization (BYOK) and workload. */
  credentials?: { required: boolean; accepts: CredentialOwner[] };
  fetch?: typeof fetch;
}

interface SlackAnswer {
  ok?: boolean;
  error?: string;
  channel?: string;
  ts?: string;
  messages?: Array<{ ts?: string; metadata?: { event_type?: string; event_payload?: Json } }>;
}

const API = "the Slack API";
const EVENT_TYPE = "runtime_protocol_message";
const AUTH_ERRORS = new Set([
  "not_authed",
  "invalid_auth",
  "token_revoked",
  "token_expired",
  "account_inactive",
]);
const HOUR_MS = 3_600_000;

/**
 * Implements communication.send (chat profile) with Slack's chat.postMessage. Every
 * message carries the invocation's idempotency key as message metadata, which is how an
 * uncertain delivery is reconciled from the conversation history.
 */
export function createSlackProvider(options: SlackProviderOptions): Provider {
  const baseUrl = (options.baseUrl ?? "https://slack.com/api").replace(/\/+$/, "");
  const workspace = options.workspace ?? "workspace";
  const settleAfterMs = options.settleAfterMs ?? 300_000;
  const lookup =
    typeof options.conversations === "function"
      ? options.conversations
      : (recipient: string) => (options.conversations as Record<string, string>)[recipient];
  const messageRef = (channel: string, ts: string) =>
    `resource://slack/${workspace}/${channel}/${ts}`;

  const call = async (ctx: HandlerContext, method: string, init: { body?: Json; query?: Json }) => {
    const key = await ctx.credential();
    const { body } = await fetchJson<SlackAnswer>(`${baseUrl}/${method}`, {
      api: API,
      ...(init.body ? { body: init.body } : {}),
      ...(init.query ? { query: init.query as Record<string, string> } : {}),
      headers: key ? { authorization: `Bearer ${key}` } : {},
      signal: ctx.signal,
      redact: key ? [key] : [],
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
    return body;
  };

  /** Recipients with their conversation, and those that have none. */
  const route = (input: Json) => {
    const routed: Array<{ recipient: string; channel: string }> = [];
    const rejected: Array<{ recipient: string; reason: string }> = [];
    for (const recipient of input["recipients"] as string[]) {
      const channel = lookup(recipient);
      if (channel) routed.push({ recipient, channel });
      else
        rejected.push({
          recipient,
          reason: "no Slack conversation is configured for this recipient",
        });
    }
    return { routed, rejected };
  };

  const delivered = (
    ctx: HandlerContext,
    channel: string,
    ts: string,
    kind: "receipt" | "observation",
  ): EvidenceItem =>
    kind === "receipt"
      ? ctx.evidence.providerReceipt(
          ["execution", "delivery"],
          { channel, ts },
          { subject: { ref: messageRef(channel, ts), type: "message" } },
        )
      : ctx.evidence.stateObservation(
          ["execution", "delivery"],
          { ref: messageRef(channel, ts), type: "message" },
          { channel, ts },
        );

  return defineProvider({
    id: options.id ?? "slack",
    name: "Slack",
    adapter: { id: "runtime-adapter-slack", version: "0.1.0", system: "slack" },
    capabilities: [
      {
        capability: "communication.send",
        profiles: ["chat"],
        traits: ["delivery_receipt", "rich_text", "threading"],
        evidence: { claims: ["execution", "delivery"] },
        reconciliation: "supported",
      },
    ],
    credentials: options.credentials ?? { required: true, accepts: ["organization", "workload"] },
    handlers: {
      "communication.send": async (input, ctx) => {
        const rich = input["rich_content"] as { format: string; body: string } | undefined;
        if (rich && rich.format !== "markdown")
          throw new ProviderFailure("Slack accepts rich content only as markdown");
        const { routed, rejected } = route(input);
        let threadTs: string | undefined;
        if (typeof input["thread"] === "string") {
          const match = /^resource:\/\/slack\/[^/]+\/([^/]+)\/([0-9.]+)$/.exec(input["thread"]);
          if (!match || routed.some((r) => r.channel !== match[1]))
            throw new ProviderFailure(
              "the thread is not a Slack message in the recipients' conversation",
            );
          threadTs = match[2];
        }
        const subject = typeof input["subject"] === "string" ? input["subject"] : undefined;
        const body = rich ? rich.body : ((input["content"] as string | undefined) ?? "");
        const text = subject ? `${rich ? `**${subject}**` : `*${subject}*`}\n${body}` : body;
        const accepted: Array<{ recipient: string; channel: string; ts: string }> = [];
        for (const { recipient, channel } of routed) {
          let answer: SlackAnswer;
          try {
            answer = await call(ctx, "chat.postMessage", {
              body: {
                channel,
                ...(rich ? { markdown_text: text } : { text }),
                ...(threadTs ? { thread_ts: threadTs } : {}),
                unfurl_links: false,
                unfurl_media: false,
                metadata: {
                  event_type: EVENT_TYPE,
                  event_payload: {
                    idempotency_key: ctx.idempotencyKey ?? ctx.invocation.invocation_id,
                    ...(input["data"] ? { data: input["data"] as Json } : {}),
                  },
                },
              },
            });
          } catch (error) {
            // Refused before anything was sent: record the recipient; after an effect, never claim failure.
            if (error instanceof ProviderFailure && accepted.length > 0) {
              rejected.push({ recipient, reason: error.message });
              continue;
            }
            throw error;
          }
          if (answer.ok && answer.ts) {
            accepted.push({ recipient, channel: answer.channel ?? channel, ts: answer.ts });
            continue;
          }
          const reason = answer.error ?? "not posted";
          if (AUTH_ERRORS.has(reason) && accepted.length === 0)
            throw new ProviderFailure(`Slack refused the credential (${reason})`, {
              code: "credential_unavailable",
            });
          rejected.push({ recipient, reason: `Slack refused the message (${reason})` });
        }
        if (accepted.length === 0)
          throw new ProviderFailure(
            `no recipient could be reached on Slack: ${rejected.map((r) => r.reason).join("; ")}`.slice(
              0,
              500,
            ),
          );
        return {
          output: {
            message: { ref: messageRef(accepted[0]!.channel, accepted[0]!.ts) },
            accepted_recipients: accepted.map((a) => a.recipient),
            ...(rejected.length > 0 ? { rejected_recipients: rejected } : {}),
          },
          evidence: accepted.map((a) => delivered(ctx, a.channel, a.ts, "receipt")),
        };
      },
    },
    reconcile: {
      "communication.send": async (input, ctx) => {
        const key = ctx.idempotencyKey ?? ctx.invocation.invocation_id;
        const { routed, rejected } = route(input);
        const deadline = Date.parse(ctx.invocation.deadline);
        const found: Array<{ recipient: string; channel: string; ts: string }> = [];
        for (const { recipient, channel } of routed) {
          let history: SlackAnswer;
          try {
            history = await call(ctx, "conversations.history", {
              query: {
                channel,
                oldest: ((deadline - HOUR_MS) / 1000).toFixed(6),
                include_all_metadata: "true",
                limit: "200",
              },
            });
          } catch {
            return { status: "inconclusive", reason: "the Slack history could not be read" };
          }
          if (!history.ok)
            return {
              status: "inconclusive",
              reason: `the Slack history could not be read (${history.error ?? "error"})`,
            };
          const message = history.messages?.find(
            (m) =>
              m.metadata?.event_type === EVENT_TYPE &&
              m.metadata.event_payload?.["idempotency_key"] === key,
          );
          if (message?.ts) found.push({ recipient, channel, ts: message.ts });
          else rejected.push({ recipient, reason: "the message is not in the conversation" });
        }
        if (found.length > 0)
          return {
            status: "completed",
            output: {
              message: { ref: messageRef(found[0]!.channel, found[0]!.ts) },
              accepted_recipients: found.map((f) => f.recipient),
              ...(rejected.length > 0 ? { rejected_recipients: rejected } : {}),
            },
            evidence: found.map((f) => delivered(ctx, f.channel, f.ts, "observation")),
          };
        if (ctx.now().getTime() < deadline + settleAfterMs)
          return { status: "inconclusive", reason: "the message is not visible yet" };
        return {
          status: "failed",
          final: true,
          reason: "no conversation holds a message with the idempotency key",
          evidence: routed.map(({ channel }) =>
            ctx.evidence.stateObservation(
              ["state"],
              { ref: `resource://slack/${workspace}/${channel}`, type: "conversation" },
              { searched_for: "idempotency_key", found: false },
            ),
          ),
        };
      },
    },
  });
}
