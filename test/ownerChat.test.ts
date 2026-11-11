import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { menus, products } from "../src/db/schema";
import { runMenuNudge } from "../src/jobs/menuNudge";
import { harness, OWNER } from "./helpers";

const FORM = { ORDER_CHANNEL: "whatsform", OWNER_ONLY: "1" };
const DAY = 24 * 60 * 60 * 1000;

type H = Awaited<ReturnType<typeof harness>>;

async function tap(h: H, out: Awaited<ReturnType<H["say"]>>, prefix: string) {
  const b = h.buttonsOf(out).find((x) => x.id.startsWith(prefix));
  if (!b) throw new Error(`no ${prefix} button in: ${h.texts(out)}`);
  return h.say(OWNER, { replyId: b.id, title: b.title });
}

/** Dishes: 1 Dal Makhani (8oz, 16oz), 2 Roti (each), 3 Paneer Tikka (S, M, L). */
async function withDishes(env: Record<string, string> = FORM) {
  const h = await harness({ env });
  const preview = await h.say(OWNER, "add Dal makhani 8oz 6, 16oz 10\nRoti 1 each\nPaneer tikka S 5 M 8 L 12");
  await tap(h, preview, "prod_save:");
  return h;
}

const menuNames = async (h: H) => (await h.db.select().from(menus)).map((m) => [m.date, m.status, m.items.map((i) => i.name)]);

describe("owner manages dishes by plain chat", () => {
  it("adds a dish without a command word, and a price change keeps the other sizes", async () => {
    const h = await withDishes();
    await tap(h, await h.say(OWNER, "samosa 2 each"), "prod_save:");
    const preview = await h.say(OWNER, "dal makhani 16oz 11");
    expect(h.texts(preview)).toContain("Dal Makhani — 8oz $6 · 16oz $11\n   _replaces 8oz $6 · 16oz $10_");
    await tap(h, preview, "prod_save:");
    const rows = await h.db.select().from(products);
    expect(rows.map((p) => p.name).sort()).toEqual(["Dal Makhani", "Paneer Tikka", "Roti", "Samosa"]);
    expect(rows.find((p) => p.name === "Dal Makhani")!.sizes).toEqual([
      { label: "8oz", price_cents: 600 },
      { label: "16oz", price_cents: 1100 },
    ]);
    expect(h.llm.ownerCalls).toHaveLength(0);
  });

  it("edits a dish through the model, keeping unchanged prices and refusing invented ones", async () => {
    const h = await withDishes();
    h.llm.ownerOverrides.set("dal ka bada wala 11 kar do", {
      action: "edit_product",
      product_ns: [1],
      products: [{ name: "dal", sizes: [{ label: "8oz", price_cents: 600 }, { label: "16oz", price_cents: 1100 }], aliases: [] }],
    });
    const ok = await h.say(OWNER, "dal ka bada wala 11 kar do");
    expect(h.texts(ok)).toContain("Dal Makhani — 8oz $6 · 16oz $11");

    h.llm.ownerOverrides.set("make paneer cheaper", {
      action: "edit_product",
      product_ns: [3],
      products: [{ name: "Paneer Tikka", sizes: [{ label: "S", price_cents: 400 }], aliases: [] }],
    });
    const bad = await h.say(OWNER, "make paneer cheaper");
    expect(h.texts(bad)).toContain("I couldn't find a price for Paneer Tikka");
    expect(h.buttonsOf(bad)).toEqual([]);
  });

  it("removes a dish from the list after asking", async () => {
    const h = await withDishes();
    h.llm.ownerOverrides.set("we don't make roti any more", { action: "remove_product", product_ns: [2] });
    const ask = await h.say(OWNER, "we don't make roti any more");
    expect(h.texts(ask)).toContain("Remove *Roti*");
    await tap(h, ask, "prod_rm:");
    expect((await h.db.select().from(products).where(eq(products.active, true))).map((p) => p.name)).not.toContain("Roti");
  });
});

describe("owner sets the daily menu by plain chat", () => {
  it("today's menu from names, without the model; Publish gives the form kit", async () => {
    const h = await withDishes();
    const preview = await h.say(OWNER, "today dal, roti");
    expect(h.texts(preview)).toContain("Dal Makhani 8oz — $6.00");
    expect(h.texts(preview)).toContain("tell me what to change");
    expect(h.llm.ownerCalls).toHaveLength(0);
    const pub = await tap(h, preview, "menu_publish:");
    expect(h.texts(pub)).toContain("• Dal Makhani — 8oz $6 · 16oz $10");
    expect(await menuNames(h)).toEqual([["2026-10-19", "active", ["Dal Makhani 8oz", "Dal Makhani 16oz", "Roti"]]]);
  });

  it("follow-ups change the open draft: add a size, take a dish off, move the cutoff", async () => {
    const h = await withDishes();
    await h.say(OWNER, "today 1 2");
    h.llm.ownerOverrides.set("add paneer large", { action: "edit_menu", dishes: [{ n: 3, sizes: ["L"] }] });
    await h.say(OWNER, "add paneer large");
    h.llm.ownerOverrides.set("no roti today", { action: "edit_menu", remove_dishes: [{ n: 2, sizes: [] }] });
    await h.say(OWNER, "no roti today");
    h.llm.ownerOverrides.set("only the big dal", { action: "edit_menu", remove_dishes: [{ n: 1, sizes: ["8oz"] }] });
    await h.say(OWNER, "only the big dal");
    expect(await menuNames(h)).toEqual([["2026-10-19", "draft", ["Dal Makhani 16oz", "Paneer Tikka L"]]]);

    const cut = await h.say(OWNER, "cutoff 11");
    expect(h.texts(cut)).toContain("Cutoff: 11:00 AM");
    await tap(h, cut, "menu_publish:");
    const later = await h.say(OWNER, "cutoff 11:30am");
    expect(h.texts(later)).toContain("Cutoff for Mon");
    expect(h.texts(later)).toContain("is now 11:30 AM");
    const [m] = await h.db.select().from(menus);
    expect(m!.status).toBe("active");
  });

  it("says which dishes it doesn't know and never invents a dish number", async () => {
    const h = await withDishes();
    h.llm.ownerOverrides.set("today dal and biryani", { action: "set_menu", day: "today", dishes: [{ n: 1, sizes: [] }, { n: 9, sizes: [] }], unknown: ["biryani"] });
    const out = await h.say(OWNER, "today dal and biryani");
    expect(h.texts(out)).toContain("Not in your dishes: biryani, #9");
    expect((await menuNames(h))[0]![2]).toEqual(["Dal Makhani 8oz", "Dal Makhani 16oz"]);
  });

  it("same as yesterday copies at today's prices and drops dishes no longer on the list", async () => {
    const h = await withDishes();
    await tap(h, await h.say(OWNER, "today dal, roti, paneer (s)"), "menu_publish:");
    h.advance(DAY);
    await tap(h, await h.say(OWNER, "/remove-product 2"), "prod_rm:");
    await tap(h, await h.say(OWNER, "dal makhani 8oz 7"), "prod_save:");
    const out = await h.say(OWNER, "same as yesterday");
    expect(h.texts(out)).toContain("Left out (not in your dishes any more): Roti");
    expect(h.texts(out)).toContain("Dal Makhani 8oz — $7.00");
    const tue = (await h.db.select().from(menus)).find((m) => m.date === "2026-10-20")!;
    expect(tue.items.map((i) => i.name)).toEqual(["Dal Makhani 8oz", "Dal Makhani 16oz", "Paneer Tikka S"]);
    expect(h.llm.ownerCalls).toHaveLength(0);
  });

  it("copies with changes through the model", async () => {
    const h = await withDishes();
    await tap(h, await h.say(OWNER, "today dal, roti"), "menu_publish:");
    h.advance(DAY);
    h.llm.ownerOverrides.set("same as monday but no roti, add paneer", {
      action: "copy_menu",
      copy_from: "monday",
      dishes: [{ n: 3, sizes: [] }],
      remove_dishes: [{ n: 2, sizes: [] }],
    });
    await h.say(OWNER, "same as monday but no roti, add paneer");
    const tue = (await h.db.select().from(menus)).find((m) => m.date === "2026-10-20")!;
    expect(tue.items.map((i) => i.name)).toEqual(["Dal Makhani 8oz", "Dal Makhani 16oz", "Paneer Tikka S", "Paneer Tikka M", "Paneer Tikka L"]);
    // The model saw the dish list and the menu to copy.
    expect(h.llm.ownerCalls[0]!.products[2]).toEqual({ n: 3, name: "Paneer Tikka", sizes: "S $5 · M $8 · L $12" });
    expect(h.llm.ownerCalls[0]!.lastMenu?.dishes).toBe("Dal Makhani (8oz, 16oz), Roti");
  });

  it("model down: a friendly reply and nothing written", async () => {
    const h = await withDishes();
    h.llm.ownerError = new Error("boom");
    const out = await h.say(OWNER, "kal ke liye wahi daal aur roti");
    expect(h.texts(out)).toContain("couldn't read that right now");
    expect(await h.db.select().from(menus)).toHaveLength(0);
  });

  it("exact commands and read-only questions don't need a menu draft", async () => {
    const h = await withDishes();
    expect(h.texts(await h.say(OWNER, "/how"))).toContain("No menu for today yet");
    h.llm.ownerOverrides.set("kitna banana hai", { action: "what" });
    expect(h.texts(await h.say(OWNER, "kitna banana hai"))).toContain("No menu for today yet");
    expect(h.llm.ownerCalls).toHaveLength(1);
    expect(h.texts(await h.say(OWNER, "help"))).toContain("Just type it");
  });
});

describe("morning menu nudge", () => {
  const deps = (h: H) => ({ db: h.db, wa: h.wa, llm: h.llm, cfg: h.cfg, now: () => h.clock.now });

  it("asks once, only in the owner's window, and Same as Mon makes the draft", async () => {
    const h = await withDishes();
    await tap(h, await h.say(OWNER, "today dal, roti"), "menu_publish:");
    h.advance(DAY); // Tue 8:00
    await h.say(OWNER, "/how"); // her 24 h window is open again
    expect(await runMenuNudge(deps(h))).toEqual([]); // before MENU_EXPECTED_BY
    h.advance(65 * 60 * 1000); // 9:05
    expect(await runMenuNudge(deps(h))).toEqual([OWNER]);
    expect(await runMenuNudge(deps(h))).toEqual([]);
    await h.drain();
    const nudge = h.wa.sent.at(-1)!;
    expect(nudge.body).toContain("Last time (Mon): Dal Makhani (8oz, 16oz), Roti");
    const copied = await tap(h, [nudge], "menu_copy:");
    expect(h.texts(copied)).toContain("Menu preview — Tue");
    expect(await runMenuNudge(deps(h))).toEqual([]);
  });

  it("stays quiet when the owner's window is closed or the menu is set", async () => {
    const h = await withDishes();
    h.advance(2 * DAY); // Wed 8:00, last owner message two days ago
    h.advance(65 * 60 * 1000);
    expect(await runMenuNudge(deps(h))).toEqual([]);
    await h.say(OWNER, "today dal");
    expect(await runMenuNudge(deps(h))).toEqual([]);
  });
});
