import {
  defineProvider,
  digest,
  fetchJson,
  ProviderFailure,
  type CredentialOwner,
  type EvidenceItem,
  type HandlerContext,
  type Json,
  type Provider,
} from "@runtime-protocol/sdk";
import {
  AnswerValidator,
  classification,
  classificationPrompt,
  generatedOutput,
  generationPrompt,
  itemText,
  type Turn,
} from "./reasoning.ts";

export interface AnthropicProviderOptions {
  /** Provider identifier; defaults to `anthropic`. */
  id?: string;
  /** The model for every capability. The operator chooses it; callers never do. */
  model: string;
  /** Per-capability model overrides. */
  models?: Partial<Record<"reasoning.generate" | "reasoning.classify", string>>;
  /** Upper bound of generated tokens per call; defaults to 4096. */
  maxTokens?: number;
  /** Defaults to https://api.anthropic.com. */
  baseUrl?: string;
  /** Regions where requests are processed, declared for policy. */
  regions?: string[];
  /** Credential owners accepted; defaults to organization (BYOK), runtime (managed) and workload. */
  credentials?: { required: boolean; accepts: CredentialOwner[] };
  fetch?: typeof fetch;
}

interface Message {
  id?: string;
  model?: string;
  content?: Array<{ type: string; text?: string; name?: string; input?: unknown }>;
  stop_reason?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}

const API = "the Anthropic API";
const ANSWER_TOOL = "answer";

/**
 * Wraps a JSON Schema so that it can be a tool input schema, which must describe an
 * object; `unwrap` reverses it.
 */
function toolSchema(schema: Json): { schema: Json; unwrap: (value: unknown) => unknown } {
  if (schema["type"] === "object") return { schema, unwrap: (value) => value };
  return {
    schema: { type: "object", required: ["value"], properties: { value: schema } },
    unwrap: (value) => (value as { value?: unknown } | undefined)?.value,
  };
}

/**
 * Implements reasoning.generate and reasoning.classify with the Anthropic Messages API.
 * Structured answers use a forced tool call whose input schema is the requested schema.
 */
export function createAnthropicProvider(options: AnthropicProviderOptions): Provider {
  const baseUrl = (options.baseUrl ?? "https://api.anthropic.com").replace(/\/+$/, "");
  const validator = new AnswerValidator();
  const regions = options.regions ? { regions: options.regions } : {};

  async function send(
    capability: "reasoning.generate" | "reasoning.classify",
    system: string,
    turns: Turn[],
    schema: Json | undefined,
    ctx: HandlerContext,
  ): Promise<{ text?: string; json?: unknown; message: Message }> {
    const key = await ctx.credential();
    const tool = schema ? toolSchema(schema) : undefined;
    const { body } = await fetchJson<Message>(`${baseUrl}/v1/messages`, {
      api: API,
      body: {
        model: options.models?.[capability] ?? options.model,
        max_tokens: options.maxTokens ?? 4096,
        ...(system ? { system } : {}),
        messages: turns.map((turn) => ({ role: turn.role, content: turn.content })),
        ...(tool
          ? {
              tools: [
                { name: ANSWER_TOOL, description: "Return the answer.", input_schema: tool.schema },
              ],
              tool_choice: { type: "tool", name: ANSWER_TOOL },
            }
          : {}),
      },
      headers: { ...(key ? { "x-api-key": key } : {}), "anthropic-version": "2023-06-01" },
      signal: ctx.signal,
      redact: key ? [key] : [],
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
    if (!Array.isArray(body.content)) throw new Error(`${API} answered without content`);
    if (body.stop_reason === "refusal") throw new ProviderFailure("the model refused to answer");
    if (body.stop_reason === "max_tokens")
      throw new ProviderFailure("the model stopped at its output limit");
    if (tool) {
      const call = body.content.find((b) => b.type === "tool_use" && b.name === ANSWER_TOOL);
      if (!call) throw new ProviderFailure("the model did not return a structured answer");
      return { json: tool.unwrap(call.input), message: body };
    }
    const text = body.content
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("");
    return { text, message: body };
  }

  const receipt = (ctx: HandlerContext, messages: Message[]): EvidenceItem =>
    ctx.evidence.providerReceipt(["execution"], {
      responses: messages.map((m) => ({
        id: m.id ?? null,
        model: m.model ?? null,
        digest: digest(m),
      })),
    });
  const usage = (messages: Message[]) => ({
    input_units: messages.reduce((n, m) => n + (m.usage?.input_tokens ?? 0), 0),
    output_units: messages.reduce((n, m) => n + (m.usage?.output_tokens ?? 0), 0),
    unit: "token",
  });

  return defineProvider({
    id: options.id ?? "anthropic",
    name: "Anthropic",
    adapter: { id: "runtime-adapter-anthropic", version: "0.1.0", system: "anthropic" },
    capabilities: [
      {
        capability: "reasoning.generate",
        profiles: ["conversational"],
        traits: ["structured_output"],
        ...regions,
      },
      { capability: "reasoning.classify", traits: ["batch"], ...regions },
    ],
    credentials: options.credentials ?? {
      required: true,
      accepts: ["organization", "runtime", "workload"],
    },
    handlers: {
      "reasoning.generate": async (input, ctx) => {
        const { system, turns } = generationPrompt(input);
        const answer = await send(
          "reasoning.generate",
          system,
          turns,
          input["output_schema"] as Json | undefined,
          ctx,
        );
        const output = generatedOutput(input, answer, validator);
        return {
          output: { ...output, usage: usage([answer.message]) },
          evidence: [receipt(ctx, [answer.message])],
        };
      },
      "reasoning.classify": async (input, ctx) => {
        const { system, schema } = classificationPrompt(input);
        const items = (input["inputs"] as unknown[] | undefined) ?? [input["input"]];
        const messages: Message[] = [];
        const answers = [];
        for (const item of items) {
          const answer = await send(
            "reasoning.classify",
            system,
            [{ role: "user", content: itemText(item) }],
            schema,
            ctx,
          );
          messages.push(answer.message);
          answers.push(classification(input, answer.json, validator));
        }
        const output: Json = input["inputs"]
          ? { results: answers.map((a, index) => ({ index, labels: a.labels })) }
          : { ...answers[0]! };
        return {
          output: { ...output, usage: usage(messages) },
          evidence: [receipt(ctx, messages)],
        };
      },
    },
  });
}
