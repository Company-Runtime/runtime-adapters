import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import { digest, ProviderFailure, type Json } from "@runtime-protocol/sdk";

/** A chat turn in the shape shared by reasoning.generate and vendor chat APIs. */
export interface Turn {
  role: "system" | "user" | "assistant";
  content: string;
}

interface Label {
  id: string;
  description?: string;
}

const text = (item: unknown) => (typeof item === "string" ? item : JSON.stringify(item));

/**
 * reasoning.generate input → system text and conversation. Instructions, language and
 * length limits lead; grounding context follows; the conversation (conversational
 * profile) or the instructions alone form the turns.
 */
export function generationPrompt(input: Json): { system: string; turns: Turn[] } {
  const instructions = input["instructions"] as string;
  const conversation = (input["messages"] as Turn[] | undefined) ?? [];
  const context = (input["context"] as unknown[] | undefined) ?? [];
  const system: string[] = [];
  if (conversation.length > 0) system.push(instructions);
  if (typeof input["language"] === "string")
    system.push(`Answer in the language ${input["language"]}.`);
  if (typeof input["max_output_chars"] === "number")
    system.push(`Answer in at most ${input["max_output_chars"]} characters.`);
  if (context.length > 0) system.push(`Context:\n${context.map(text).join("\n\n")}`);
  for (const turn of conversation) if (turn.role === "system") system.push(turn.content);
  const turns = conversation.filter((turn) => turn.role !== "system");
  return {
    system: system.join("\n\n"),
    turns: turns.length > 0 ? turns : [{ role: "user", content: instructions }],
  };
}

/** Validates model answers against caller-supplied JSON Schemas (the structured_output trait). */
export class AnswerValidator {
  readonly #ajv = new Ajv2020({ strict: false, allErrors: false });
  readonly #cache = new Map<string, ValidateFunction>();

  check(schema: Json, value: unknown): boolean {
    const key = digest(schema);
    let validate = this.#cache.get(key);
    if (!validate) {
      const { $schema: _schema, $id: _id, ...rest } = schema;
      validate = this.#ajv.compile(rest);
      this.#cache.set(key, validate);
    }
    return validate(value) === true;
  }
}

/** The generated content: structured when an output schema was requested, text otherwise. */
export function generatedOutput(
  input: Json,
  answer: { text?: string; json?: unknown },
  validator: AnswerValidator,
): Json {
  const schema = input["output_schema"] as Json | undefined;
  if (schema) {
    let value = answer.json;
    if (value === undefined && answer.text !== undefined) {
      try {
        value = JSON.parse(answer.text);
      } catch {
        throw new ProviderFailure("the model answer is not valid JSON");
      }
    }
    if (!validator.check(schema, value))
      throw new ProviderFailure("the model answer does not match the requested output schema");
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? { content: value, media_type: "application/json" }
      : { content: { value }, media_type: "application/json" };
  }
  const content = answer.text ?? "";
  if (!content.trim()) throw new ProviderFailure("the model returned no content");
  const limit = input["max_output_chars"];
  if (typeof limit === "number" && content.length > limit)
    throw new ProviderFailure("the model answer exceeds max_output_chars");
  return { content, media_type: "text/plain" };
}

/** Instructions and the answer schema for classifying one item. */
export function classificationPrompt(input: Json): { system: string; schema: Json } {
  const labels = input["labels"] as Label[];
  const multi = input["multi_label"] === true;
  const rationale = input["rationale"] === true;
  const system = [
    `Classify the input. Choose ${multi ? "every label that applies" : "exactly one label"} from this list:`,
    ...labels.map((l) => `- ${l.id}${l.description ? `: ${l.description}` : ""}`),
    "Give each chosen label a confidence between 0 and 1.",
    rationale ? "Explain the choice briefly in `rationale`." : "",
  ]
    .filter(Boolean)
    .join("\n");
  const schema: Json = {
    type: "object",
    additionalProperties: false,
    required: rationale ? ["labels", "rationale"] : ["labels"],
    properties: {
      labels: {
        type: "array",
        minItems: 1,
        ...(multi ? {} : { maxItems: 1 }),
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "confidence"],
          properties: {
            id: { enum: labels.map((l) => l.id) },
            confidence: { type: "number", minimum: 0, maximum: 1 },
          },
        },
      },
      ...(rationale ? { rationale: { type: "string" } } : {}),
    },
  };
  return { system, schema };
}

/** Checks one classification answer against the requested labels. */
export function classification(
  input: Json,
  answer: unknown,
  validator: AnswerValidator,
): { labels: Array<{ id: string; confidence: number }>; rationale?: string } {
  const { schema } = classificationPrompt(input);
  if (!validator.check(schema, answer))
    throw new ProviderFailure("the model answer is not a valid choice among the requested labels");
  const value = answer as { labels: Array<{ id: string; confidence: number }>; rationale?: string };
  return {
    labels: value.labels,
    ...(value.rationale !== undefined ? { rationale: value.rationale.slice(0, 10_000) } : {}),
  };
}

export const itemText = text;
