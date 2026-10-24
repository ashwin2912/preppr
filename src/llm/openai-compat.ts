import { z } from "zod";
import { log } from "../lib/log";
import { buildInterpretPrompt, INTERPRET_SYSTEM, MENU_SYSTEM } from "./prompts";
import {
  InterpretationSchema,
  ParsedMenuSchema,
  type InterpretInput,
  type Interpretation,
  type Llm,
  type ParsedMenu,
} from "./types";

type Msg = { role: "system" | "user" | "assistant"; content: string };

/**
 * Any OpenAI-compatible chat completions API: OpenRouter, the Hugging Face
 * router, Groq, Together, a local Ollama. Meant for testing with free models.
 * Many of them have no structured outputs, so the JSON Schema goes in the
 * prompt and the reply is validated with zod, with one corrective retry.
 */
export class OpenAiCompatLlm implements Llm {
  constructor(
    private baseUrl: string,
    private apiKey: string,
    private model: string,
  ) {}

  private async chat(messages: Msg[]): Promise<string> {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`${this.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ model: this.model, messages, temperature: 0, max_tokens: 2000 }),
        signal: AbortSignal.timeout(60_000),
      });
      // Free tiers rate-limit hard (OpenRouter: ~20 requests/minute).
      if ((res.status === 429 || res.status >= 500) && attempt < 3) {
        const wait = Math.min(Number(res.headers.get("retry-after")) * 1000 || 3000 * 2 ** attempt, 30_000);
        log.warn("llm retry", { status: res.status, wait });
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      const body = await res.text();
      if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${body.slice(0, 300)}`);
      const json = JSON.parse(body) as { error?: unknown; choices?: { message?: { content?: unknown } }[] };
      // OpenRouter can return 200 with an error from the upstream provider.
      if (json.error) throw new Error(`LLM error: ${JSON.stringify(json.error).slice(0, 300)}`);
      const content = json.choices?.[0]?.message?.content;
      if (typeof content !== "string" || !content) throw new Error(`LLM returned no content: ${body.slice(0, 300)}`);
      return content;
    }
  }

  private async structured<T extends z.ZodType>(
    system: string,
    user: string,
    schema: T,
    fill: (raw: unknown) => unknown,
  ): Promise<z.infer<T>> {
    const messages: Msg[] = [
      {
        role: "system",
        content: `${system}\n\nReply with only a JSON object (no prose, no code fences) matching this JSON Schema:\n${JSON.stringify(z.toJSONSchema(schema))}`,
      },
      { role: "user", content: user },
    ];
    let problem = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      const text = await this.chat(messages);
      const raw = extractJson(text);
      const parsed = raw === undefined ? null : schema.safeParse(fill(raw));
      if (parsed?.success) return parsed.data;
      problem = parsed ? z.prettifyError(parsed.error) : "not a JSON object";
      messages.push(
        { role: "assistant", content: text },
        { role: "user", content: `That reply was invalid (${problem}). Send only the corrected JSON object.` },
      );
    }
    throw new Error(`LLM output did not match schema: ${problem}`);
  }

  parseMenu(text: string): Promise<ParsedMenu> {
    return this.structured(MENU_SYSTEM, `<menu>\n${text}\n</menu>`, ParsedMenuSchema, fillMenu);
  }

  interpret(input: InterpretInput): Promise<Interpretation> {
    return this.structured(INTERPRET_SYSTEM, buildInterpretPrompt(input), InterpretationSchema, fillInterpretation);
  }
}

/** First `{` to last `}`, after dropping reasoning blocks and code fences. */
export function extractJson(text: string): unknown {
  const t = text.replace(/<think>[\s\S]*?<\/think>/g, "");
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    return JSON.parse(t.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

// Small models often omit nullable fields or quote numbers. Fill the
// harmless gaps; anything else still fails validation.
type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown) => (typeof v === "string" && v.trim() !== "" ? Number(v) : v);

function fillMenu(raw: unknown): unknown {
  if (!isObj(raw)) return raw;
  const items = Array.isArray(raw.items) ? raw.items : [];
  return {
    day: null,
    cutoff: null,
    ...raw,
    items: items.map((i) => (isObj(i) ? { aliases: [], ...i, price_cents: num(i.price_cents) } : i)),
  };
}

function fillInterpretation(raw: unknown): unknown {
  if (!isObj(raw)) return raw;
  const lines = Array.isArray(raw.lines) ? raw.lines : [];
  return {
    unmatched: [],
    question_topic: null,
    clarify_question: null,
    payment_cents: null,
    payment_method: null,
    ...raw,
    confidence: num(raw.confidence),
    lines: lines.map((l) => (isObj(l) ? { note: null, ...l, item_id: String(l.item_id), qty: num(l.qty) } : l)),
  };
}
