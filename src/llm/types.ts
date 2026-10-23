import { z } from "zod";
import type { MenuItem } from "../db/schema";

// Schemas double as the structured-output format sent to Claude. Keep them
// plain (no min/max): range checks happen in code after parsing.

export const ParsedMenuSchema = z.object({
  day: z.string().nullable().describe('Day word the owner wrote, e.g. "Mon", "tomorrow"; null if none'),
  cutoff: z.string().nullable().describe('Cutoff time exactly as written, e.g. "10:30", "11am"; null if none'),
  items: z.array(
    z.object({
      name: z.string().describe("Clean display name, Title Case"),
      price_cents: z.number().int().describe("Price per unit in US cents"),
      aliases: z.array(z.string()).describe("Lowercase alternative names/spellings customers might type"),
    }),
  ),
});
export type ParsedMenu = z.infer<typeof ParsedMenuSchema>;

export const INTENTS = ["order", "edit", "cancel", "question", "handoff", "menu", "other"] as const;
export type Intent = (typeof INTENTS)[number];

export const InterpretationSchema = z.object({
  intent: z.enum(INTENTS),
  lines: z
    .array(
      z.object({
        item_id: z.string(),
        qty: z.number().int(),
        note: z.string().nullable(),
      }),
    )
    .describe("For order/edit: the COMPLETE resulting order, not just the changes"),
  unmatched: z.array(z.string()).describe("Requested things that are not on today's menu or are ambiguous"),
  confidence: z.number().describe("0 to 1"),
  question_topic: z.enum(["cutoff", "menu", "price", "other"]).nullable(),
  clarify_question: z.string().nullable().describe("One short question to ask if unsure, else null"),
});
export type Interpretation = z.infer<typeof InterpretationSchema>;

export type SimpleLine = { item_id: string; name: string; qty: number; note: string | null };

export type InterpretInput = {
  message: string;
  menu: MenuItem[];
  /** Customer's order for this menu, if any (draft or confirmed). */
  currentOrder: SimpleLine[] | null;
  /** Customer's last confirmed order from an earlier menu, remapped to today's items. */
  previousOrder: { lines: SimpleLine[]; unavailable: string[] } | null;
  /** Set when the bot just asked a clarifying question. */
  clarification: { previousMessage: string; question: string } | null;
};

export interface Llm {
  parseMenu(text: string): Promise<ParsedMenu>;
  interpret(input: InterpretInput): Promise<Interpretation>;
}
