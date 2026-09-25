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

export interface OpenAIProviderOptions {
  /** Provider identifier; defaults to `openai`. */
  id?: string;
  /** The model for every capability. The operator chooses it; callers never do. */
  model: string;
  /** Per-capability model overrides. */
  models?: Partial<Record<"reasoning.generate" | "reasoning.classify", string>>;
  /** An OpenAI-compatible API; defaults to https://api.openai.com/v1. */
  baseUrl?: string;
  /** Regions where requests are processed, declared for policy. */
  regions?: string[];
  /** Credential owners accepted; defaults to organization (BYOK), runtime (managed) and workload. */
  credentials?: { required: boolean; accepts: CredentialOwner[] };
  fetch?: typeof fetch;
}

interface Completion {
  id?: string;
  model?: string;
  choices?: Array<{
    message?: { content?: string | null; refusal?: string | null };
    finish_reason?: string;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

const API = "the OpenAI API";

/**
 * Implements reasoning.generate and reasoning.classify with the Chat Completions API of
 * OpenAI or any OpenAI-compatible endpoint.
 */
export function createOpenAIProvider(options: OpenAIProviderOptions): Provider {
  const baseUrl = (options.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
  const validator = new AnswerValidator();
  const regions = options.regions ? { regions: options.regions } : {};

  async function complete(
    capability: "reasoning.generate" | "reasoning.classify",
    system: string,
    turns: Turn[],
    schema: Json | undefined,
    ctx: HandlerContext,
  ): Promise<{ text: string; completion: Completion }> {
    const key = await ctx.credential();
    const messages = [...(system ? [{ role: "system", content: system }] : []), ...turns];
    const { body } = await fetchJson<Completion>(`${baseUrl}/chat/completions`, {
      api: API,
      body: {
        model: options.models?.[capability] ?? options.model,
        messages,
        ...(schema
          ? {
              response_format: {
                type: "json_schema",
                json_schema: { name: "answer", schema, strict: false },
              },
            }
          : {}),
      },
      headers: key ? { authorization: `Bearer ${key}` } : {},
      signal: ctx.signal,
      redact: key ? [key] : [],
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
    const choice = body.choices?.[0];
    if (!choice?.message) throw new Error(`${API} answered without a choice`);
    if (choice.message.refusal) throw new ProviderFailure("the model refused to answer");
    if (choice.finish_reason === "length")
      throw new ProviderFailure("the model stopped at its output limit");
    if (choice.finish_reason === "content_filter")
      throw new ProviderFailure("the answer was withheld by a content filter");
    return { text: choice.message.content ?? "", completion: body };
  }

  const receipt = (ctx: HandlerContext, completions: Completion[]): EvidenceItem =>
    ctx.evidence.providerReceipt(["execution"], {
      responses: completions.map((c) => ({
        id: c.id ?? null,
        model: c.model ?? null,
        digest: digest(c),
      })),
    });
  const usage = (completions: Completion[]) => ({
    input_units: completions.reduce((n, c) => n + (c.usage?.prompt_tokens ?? 0), 0),
    output_units: completions.reduce((n, c) => n + (c.usage?.completion_tokens ?? 0), 0),
    unit: "token",
  });
  const parse = (text: string) => {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new ProviderFailure("the model answer is not valid JSON");
    }
  };

  return defineProvider({
    id: options.id ?? "openai",
    name: "OpenAI",
    adapter: { id: "runtime-adapter-openai", version: "0.1.0", system: "openai" },
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
        const schema = input["output_schema"] as Json | undefined;
        const { text, completion } = await complete(
          "reasoning.generate",
          system,
          turns,
          schema,
          ctx,
        );
        const output = generatedOutput(input, schema ? { json: parse(text) } : { text }, validator);
        return {
          output: { ...output, usage: usage([completion]) },
          evidence: [receipt(ctx, [completion])],
        };
      },
      "reasoning.classify": async (input, ctx) => {
        const { system, schema } = classificationPrompt(input);
        const items = (input["inputs"] as unknown[] | undefined) ?? [input["input"]];
        const completions: Completion[] = [];
        const answers = [];
        for (const item of items) {
          const { text, completion } = await complete(
            "reasoning.classify",
            system,
            [{ role: "user", content: itemText(item) }],
            schema,
            ctx,
          );
          completions.push(completion);
          answers.push(classification(input, parse(text), validator));
        }
        const output: Json = input["inputs"]
          ? { results: answers.map((a, index) => ({ index, labels: a.labels })) }
          : { ...answers[0]! };
        return {
          output: { ...output, usage: usage(completions) },
          evidence: [receipt(ctx, completions)],
        };
      },
    },
  });
}
