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

export const ParsedProductsSchema = z.object({
  products: z.array(
    z.object({
      name: z.string().describe("Dish name as the owner wrote it, Title Case, without sizes or prices"),
      sizes: z
        .array(
          z.object({
            label: z.string().describe('Size or unit exactly as written, e.g. "8oz", "16oz", "S", "Large", "Half"; "each" if the dish has no sizes'),
            price_cents: z.number().int().describe("Price for this size in US cents, only from a price the owner wrote"),
          }),
        )
        .describe("One entry per size; a dish without sizes has one entry"),
      aliases: z.array(z.string()).describe("Lowercase alternative names/spellings customers might type"),
    }),
  ),
});
export type ParsedProducts = z.infer<typeof ParsedProductsSchema>;

export const OWNER_ACTIONS = [
  "add_products",
  "edit_product",
  "remove_product",
  "set_menu",
  "edit_menu",
  "copy_menu",
  "set_cutoff",
  "show_products",
  "show_menu",
  "how",
  "what",
  "orders",
  "message",
  "help",
  "other",
] as const;
export type OwnerActionName = (typeof OWNER_ACTIONS)[number];

const DishPick = z.object({
  n: z.number().int().describe("The dish's number from <products>"),
  sizes: z.array(z.string()).describe("Size labels exactly as in <products>; empty = every size of the dish"),
});

export const OwnerActionSchema = z.object({
  action: z.enum(OWNER_ACTIONS),
  products: ParsedProductsSchema.shape.products.describe(
    "add_products: the new dishes. edit_product: each changed dish with its COMPLETE resulting size list. Else empty",
  ),
  product_ns: z.array(z.number().int()).describe("edit_product / remove_product: the dish numbers from <products>, same order as products; else empty"),
  day: z.string().nullable().describe('The menu day the owner means ("today", "tomorrow", "Tue"); null if not said'),
  dishes: z.array(DishPick).describe("set_menu: the COMPLETE menu. edit_menu / copy_menu: dishes or sizes to add. Else empty"),
  remove_dishes: z.array(DishPick).describe("edit_menu / copy_menu: dishes or sizes to take off. Else empty"),
  copy_from: z.string().nullable().describe('copy_menu: which earlier menu ("yesterday", "Mon", "last"); else null'),
  cutoff: z.string().nullable().describe('Cutoff time exactly as written ("11", "10:30am"); null if not said'),
  unknown: z.array(z.string()).describe("Dishes the owner named that are not in <products>, as written"),
  reply: z.string().nullable().describe("action other: one short question or answer for the owner; else null"),
});
export type OwnerAction = z.infer<typeof OwnerActionSchema>;

export type OwnerInterpretInput = {
  message: string;
  /** Today in the kitchen's time zone, e.g. "Mon 2026-10-19". */
  today: string;
  /** Active products in list order; `n` is the 1-based number the owner sees. */
  products: { n: number; name: string; sizes: string }[];
  /** The menu she is working on (draft) or today's menu, if any. */
  openMenu: { date: string; status: string; dishes: string } | null;
  /** Latest published menu before the open one. */
  lastMenu: { date: string; dishes: string } | null;
};

export const INTENTS = ["order", "edit", "cancel", "question", "handoff", "menu", "payment", "other"] as const;
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
  question_topic: z.enum(["cutoff", "menu", "price", "balance", "other"]).nullable(),
  clarify_question: z.string().nullable().describe("One short question to ask if unsure, else null"),
  payment_cents: z.number().int().nullable().describe("For payment: amount the customer says they sent, in US cents; null if not stated"),
  payment_method: z.enum(["zelle", "venmo", "cash", "card", "other"]).nullable().describe("For payment: how they paid; null if not stated"),
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
  /** Owner's product-list text ("Dal 8oz 6, 16oz 10") -> products with sizes; prices are checked against the text in code. */
  parseProducts(text: string): Promise<ParsedProducts>;
  interpret(input: InterpretInput): Promise<Interpretation>;
  /** Owner's plain chat about dishes and menus -> one action; ids and labels only, checked in code. */
  interpretOwner(input: OwnerInterpretInput): Promise<OwnerAction>;
}

/** The model call failed (down, timeout, unparsable output). */
export class ParserUnavailable extends Error {
  constructor(readonly cause: unknown) {
    super(`parser unavailable: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "ParserUnavailable";
  }
}
