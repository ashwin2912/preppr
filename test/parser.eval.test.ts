/**
 * Real-model parser suite. Costs a few cents per run, so it only runs via
 * `pnpm test:parser`. Uses the model picked by llmFromEnv (.env is read).
 */
import { describe, expect, it } from "vitest";
import { priceLines } from "../src/domain/order";
import { loadDotEnv } from "../src/lib/env";
import { llmFromEnv } from "../src/llm";
import { CONFIDENCE_MIN } from "../src/flows/customer";
import type { InterpretInput } from "../src/llm/types";
import fixtures from "./fixtures/orders.json";

type Expect = {
  intent?: string;
  intentIn?: string[];
  items?: Record<string, number>;
  noteOn?: Record<string, string>;
  unclear?: boolean;
  topic?: string;
  topicIn?: (string | null)[];
};
type Case = {
  message: string;
  currentOrder?: InterpretInput["currentOrder"];
  previousOrder?: InterpretInput["previousOrder"];
  expect: Expect;
};

loadDotEnv();
const picked = process.env.RUN_PARSER_EVAL ? llmFromEnv() : null;

describe.skipIf(!picked)(`order parser (${picked?.label ?? "no model"})`, () => {
  // Free models are slow and rate-limited, hence the long timeout.
  it.concurrent.each(fixtures.cases as Case[])("$message", { timeout: 120_000 }, async (c) => {
    const it = await picked!.llm.interpret({
      message: c.message,
      menu: fixtures.menu,
      currentOrder: c.currentOrder ?? null,
      previousOrder: c.previousOrder ?? null,
      clarification: null,
    });
    const e = c.expect;
    if (e.intent) expect(it.intent).toBe(e.intent);
    if (e.intentIn) expect(e.intentIn).toContain(it.intent);
    if (e.topic) expect(it.question_topic).toBe(e.topic);
    if (e.topicIn) expect(e.topicIn).toContain(it.question_topic);

    const { lines, problems } = priceLines(it.lines, fixtures.menu);
    const accepted = lines.length > 0 && !it.unmatched.length && !problems.length && it.confidence >= CONFIDENCE_MIN;
    if (e.unclear) expect(accepted, `should not auto-accept: ${JSON.stringify(it)}`).toBe(false);
    if (e.items) {
      expect(accepted, `should auto-accept: ${JSON.stringify(it)}`).toBe(true);
      const got: Record<string, number> = {};
      for (const l of lines) got[l.item_id] = (got[l.item_id] ?? 0) + l.qty;
      expect(got).toEqual(e.items);
    }
    for (const [id, frag] of Object.entries(e.noteOn ?? {})) {
      const notes = lines.filter((l) => l.item_id === id).map((l) => l.note ?? "").join(" ").toLowerCase();
      expect(notes).toContain(frag);
    }
  });
});
