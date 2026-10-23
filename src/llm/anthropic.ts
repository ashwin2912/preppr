import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";
import { buildInterpretPrompt, INTERPRET_SYSTEM, MENU_SYSTEM } from "./prompts";
import {
  InterpretationSchema,
  ParsedMenuSchema,
  type InterpretInput,
  type Interpretation,
  type Llm,
  type ParsedMenu,
} from "./types";

export class AnthropicLlm implements Llm {
  private client: Anthropic;
  constructor(
    apiKey: string | undefined,
    private model: string,
  ) {
    this.client = new Anthropic({ apiKey, timeout: 30_000, maxRetries: 2 });
  }

  private async structured<T extends z.ZodType>(system: string, user: string, schema: T): Promise<z.infer<T>> {
    const res = await this.client.messages.parse({
      model: this.model,
      max_tokens: 4000,
      system,
      messages: [{ role: "user", content: user }],
      output_config: { effort: "low", format: zodOutputFormat(schema) },
    });
    if (res.stop_reason === "refusal") throw new Error("LLM refused");
    if (!res.parsed_output) throw new Error(`LLM returned no parsable output (stop_reason=${res.stop_reason})`);
    return res.parsed_output as z.infer<T>;
  }

  parseMenu(text: string): Promise<ParsedMenu> {
    return this.structured(MENU_SYSTEM, `<menu>\n${text}\n</menu>`, ParsedMenuSchema);
  }

  interpret(input: InterpretInput): Promise<Interpretation> {
    return this.structured(INTERPRET_SYSTEM, buildInterpretPrompt(input), InterpretationSchema);
  }
}
