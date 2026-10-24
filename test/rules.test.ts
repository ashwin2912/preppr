import { describe, expect, it } from "vitest";
import { ruleInterpret } from "../src/llm/rules";
import type { InterpretInput } from "../src/llm/types";
import fixtures from "./fixtures/orders.json";

const MENU = fixtures.menu;
const input = (message: string, extra: Partial<InterpretInput> = {}): InterpretInput => ({
  message,
  menu: MENU,
  currentOrder: null,
  previousOrder: null,
  clarification: null,
  ...extra,
});
const items = (message: string) => {
  const it = ruleInterpret(input(message));
  if (!it || it.intent !== "order") return null;
  return Object.fromEntries(it.lines.map((l) => [l.item_id, l.qty]));
};

describe("rule parser", () => {
  it("reads simple orders in several shapes", () => {
    expect(items("2 dal makhani, 3 roti")).toEqual({ i1: 2, i3: 3 });
    expect(items("2 dal makhani 3 roti")).toEqual({ i1: 2, i3: 3 });
    expect(items("do dal aur char roti")).toEqual({ i1: 2, i3: 4 });
    expect(items("Paneer x2, roti x4, jamun x1")).toEqual({ i4: 2, i3: 4, i5: 1 });
    expect(items("2x dal & 5 rotis")).toEqual({ i1: 2, i3: 5 });
    expect(items("Hi aunty, 1 dal 1 rice 4 roti pls")).toEqual({ i1: 1, i2: 1, i3: 4 });
    expect(items("1 dal\n2 roti")).toEqual({ i1: 1, i3: 2 });
    expect(items("2 roti and 2 roti")).toEqual({ i3: 4 });
  });

  it("handles greetings, thanks, emoji and cancel", () => {
    expect(ruleInterpret(input("Order"))?.intent).toBe("menu");
    expect(ruleInterpret(input("hiii aunty"))?.intent).toBe("menu");
    expect(ruleInterpret(input("thank you 🙏"))?.intent).toBe("other");
    expect(ruleInterpret(input("Thanks!"))?.intent).toBe("other");
    expect(ruleInterpret(input("👍🏽"))?.intent).toBe("other");
    expect(ruleInterpret(input("cancel my order"))?.intent).toBe("cancel");
  });

  it("leaves anything uncertain to the model", () => {
    for (const m of [
      "2 dal and 1 chicken biryani", // not on the menu
      "1 paneer bhurji no onion please, 2 roti", // note
      "2 dal (less spicy)",
      "dal", // no quantity
      "do you have paneer today",
      "same as yesterday",
      "paid 20 zelle",
      "what time is cutoff?",
      "Dal makhni 2 roti 6 gulab jamun 2",
      "60 roti", // over the quantity cap
      "done",
    ])
      expect(ruleInterpret(input(m)), m).toBeNull();
    // edits and clarification answers need context
    expect(ruleInterpret(input("2 roti", { currentOrder: [{ item_id: "i1", name: "Dal Makhani", qty: 1, note: null }] }))).toBeNull();
    expect(ruleInterpret(input("2 dal", { clarification: { previousMessage: "x", question: "y" } }))).toBeNull();
  });

  it("refuses an alias that fits two items", () => {
    const menu = [
      { id: "a", name: "Jeera Rice", price_cents: 400, aliases: ["rice"] },
      { id: "b", name: "Lemon Rice", price_cents: 400, aliases: ["rice"] },
    ];
    expect(ruleInterpret(input("2 rice", { menu }))).toBeNull();
    expect(ruleInterpret(input("2 lemon rice", { menu }))?.lines).toEqual([{ item_id: "b", qty: 2, note: null }]);
  });

  // Precision check against the same fixtures the model is graded on: whenever the
  // rules answer, they must agree with the expected result.
  it("never contradicts a parser fixture it answers", () => {
    type Case = { message: string; currentOrder?: InterpretInput["currentOrder"]; previousOrder?: InterpretInput["previousOrder"]; expect: Record<string, any> };
    let answered = 0;
    for (const c of fixtures.cases as Case[]) {
      const it = ruleInterpret(input(c.message, { currentOrder: c.currentOrder ?? null, previousOrder: c.previousOrder ?? null }));
      if (!it) continue;
      answered++;
      const e = c.expect;
      if (e.intent) expect(it.intent, c.message).toBe(e.intent);
      if (e.intentIn) expect(e.intentIn, c.message).toContain(it.intent);
      expect(e.unclear, c.message).not.toBe(true);
      if (e.noteOn) throw new Error(`rules answered a case with notes: ${c.message}`);
      if (e.items) expect(Object.fromEntries(it.lines.map((l) => [l.item_id, l.qty])), c.message).toEqual(e.items);
    }
    expect(answered).toBeGreaterThanOrEqual(8);
  });
});
