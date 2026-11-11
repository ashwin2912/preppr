/**
 * Real-model owner-chat suite. Costs a few cents per run, so it only runs via
 * `pnpm test:owner`. Uses the model picked by llmFromEnv (.env is read).
 */
import { describe, expect, it } from "vitest";
import { cleanParsedProducts } from "../src/domain/products";
import { loadDotEnv } from "../src/lib/env";
import { llmFromEnv } from "../src/llm";
import fixtures from "./fixtures/owner-messages.json";

type Expect = {
  action?: string;
  actionIn?: string[];
  dishes?: number[];
  add?: number[];
  remove?: number[];
  sizesOf?: Record<string, string[]>;
  day?: string;
  cutoff?: boolean;
  unknown?: boolean;
  ns?: number[];
  /** Name ("*" = the edited dish) -> expected prices in cents, after the price check in code. */
  prices?: Record<string, number[]>;
  noNewPrices?: boolean;
};
type Case = { message: string; open?: boolean; expect: Expect };

loadDotEnv();
const picked = process.env.RUN_OWNER_EVAL ? llmFromEnv() : null;
const ctx = fixtures.context;
// Price check in code needs product rows; only nameKey and sizes matter here.
const known = ctx.products.map((p) => ({
  nameKey: p.name.toLowerCase(),
  sizes: p.sizes.split(" · ").map((s) => {
    const m = s.match(/^(?:(.+) )?\$(\d+)(?: each)?$/)!;
    return { label: m[1] ?? "each", price_cents: Number(m[2]) * 100 };
  }),
}));

describe.skipIf(!picked)(`owner chat (${picked?.label ?? "no model"})`, () => {
  it.concurrent.each(fixtures.cases as Case[])("$message", { timeout: 120_000 }, async (c) => {
    const a = await picked!.llm.interpretOwner({
      message: c.message,
      today: ctx.today,
      products: ctx.products,
      openMenu: c.open ? { date: "2026-10-19", status: "draft", dishes: "Dal Makhani (8oz, 16oz), Roti, Paneer Tikka (S, M, L)" } : null,
      lastMenu: ctx.lastMenu,
    });
    const why = JSON.stringify(a);
    const e = c.expect;
    if (e.action) expect(a.action, why).toBe(e.action);
    if (e.actionIn) expect(e.actionIn, why).toContain(a.action);
    const ns = (xs: { n: number }[]) => [...new Set(xs.map((x) => x.n))].sort((x, y) => x - y);
    if (e.dishes) expect(ns(a.dishes), why).toEqual(e.dishes);
    if (e.add) expect(ns(a.dishes), why).toEqual(e.add);
    if (e.remove) expect(ns(a.remove_dishes), why).toEqual(e.remove);
    for (const [n, sizes] of Object.entries(e.sizesOf ?? {})) {
      const pick = [...a.dishes, ...a.remove_dishes].find((d) => d.n === Number(n));
      expect(pick?.sizes.map((s) => s.toLowerCase()).sort(), why).toEqual(sizes.map((s) => s.toLowerCase()).sort());
    }
    if (e.day) expect(a.day?.toLowerCase(), why).toBe(e.day);
    if (e.cutoff) expect(a.cutoff, why).toBeTruthy();
    if (e.unknown) expect(a.unknown.length, why).toBeGreaterThan(0);
    if (e.ns) expect(a.product_ns, why).toEqual(e.ns);
    if (e.prices || e.noNewPrices) {
      const named = a.products.map((p, i) => ({ ...p, name: ctx.products[(a.product_ns[i] ?? 0) - 1]?.name ?? p.name }));
      const { products } = cleanParsedProducts({ products: named }, c.message, known);
      if (e.noNewPrices) expect(products, why).toEqual([]);
      for (const [name, prices] of Object.entries(e.prices ?? {})) {
        const p = name === "*" ? products[0] : products.find((x) => x.name === name);
        expect(p?.sizes.map((s) => s.price_cents), why).toEqual(prices);
      }
    }
  });
});
