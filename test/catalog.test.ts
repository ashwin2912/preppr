import { describe, expect, it } from "vitest";
import { menus, messages, products } from "../src/db/schema";
import { cleanParsedProducts, parseProductLine, parseProductsText, resolvePicks } from "../src/domain/products";
import { harness, OWNER } from "./helpers";

const FORM = { ORDER_CHANNEL: "whatsform", OWNER_ONLY: "1" };

async function addAndSave(h: Awaited<ReturnType<typeof harness>>, text: string) {
  const preview = await h.say(OWNER, text);
  const save = h.buttonsOf(preview).find((b) => b.id.startsWith("prod_save:"));
  if (!save) throw new Error(`no Save button: ${h.texts(preview)}`);
  return { preview, saved: await h.say(OWNER, { replyId: save.id, title: "Save" }) };
}

describe("product line parser (strict)", () => {
  it.each([
    ["Dal makhani 8oz 6, 16oz 10", "Dal Makhani", [["8oz", 600], ["16oz", 1000]]],
    ["Dal - 8 oz $6, 16 oz $10", "Dal", [["8oz", 600], ["16oz", 1000]]],
    ["Paneer tikka S 5 M 8 L 12", "Paneer Tikka", [["S", 500], ["M", 800], ["L", 1200]]],
    ["Biryani half 8 full 14", "Biryani", [["Half", 800], ["Full", 1400]]],
    ["Roti 1 each", "Roti", [["each", 100]]],
    ["Samosa $2.50 per piece", "Samosa", [["per piece", 250]]],
    ["Kheer 4", "Kheer", [["each", 400]]],
    ["1. Raita 500ml 3", "Raita", [["500ml", 300]]],
  ])("%s", (line, name, sizes) => {
    const p = parseProductLine(line);
    expect(p?.name).toBe(name);
    expect(p?.sizes.map((s) => [s.label, s.price_cents])).toEqual(sizes);
  });

  it.each(["Dal 6, Roti 1", "Dal 6 8oz", "Chicken 65 curry 12", "Full meal 12", "Dal 8oz", "Dal 8oz 6, 8oz 7", "Dal makhani", "Dal 6 spicy"])(
    "leaves %s to the model",
    (line) => expect(parseProductLine(line)).toBeNull(),
  );

  it("needs every line to parse", () => {
    expect(parseProductsText("Dal 8oz 6, 16oz 10\nRoti 1 each")).toHaveLength(2);
    expect(parseProductsText("Dal 8oz 6, 16oz 10\nsomething nice")).toBeNull();
  });

  it("drops model prices the owner never wrote", () => {
    const r = cleanParsedProducts(
      {
        products: [
          { name: "dal", sizes: [{ label: "8oz", price_cents: 600 }, { label: "16oz", price_cents: 1000 }], aliases: ["Daal"] },
          { name: "jeera rice", sizes: [{ label: "each", price_cents: 450 }], aliases: [] },
        ],
      },
      "dal small cup six bucks or 8oz for $6 and 16oz 10\njeera rice also",
    );
    expect(r.products).toEqual([{ name: "Dal", sizes: [{ label: "8oz", price_cents: 600 }, { label: "16oz", price_cents: 1000 }], aliases: ["daal"] }]);
    expect(r.rejected).toEqual(["Jeera Rice"]);
  });
});

describe("owner product list", () => {
  it("previews, saves on tap, and lists products", async () => {
    const h = await harness({ env: FORM });
    const { preview, saved } = await addAndSave(h, "/add-product Dal makhani 8oz 6, 16oz 10\nRoti 1 each");
    expect(h.texts(preview)).toContain("Dal Makhani — 8oz $6 · 16oz $10");
    expect(h.texts(preview)).toContain("Roti — $1 each");
    expect(await h.db.select().from(products)).toHaveLength(2);
    expect(h.texts(saved)).toContain("You have 2 dishes");
    expect(h.llm.productsCalls).toEqual([]);

    const list = h.texts(await h.say(OWNER, "/products"));
    expect(list).toContain("1. Dal Makhani — 8oz $6 · 16oz $10");
    expect(list).toContain("2. Roti — $1 each");
  });

  it("saves nothing until Save, and a second tap is harmless", async () => {
    const h = await harness({ env: FORM });
    const preview = await h.say(OWNER, "add-product Kheer 4");
    expect(await h.db.select().from(products)).toHaveLength(0);
    const id = h.buttonsOf(preview)[0]!.id;
    await h.say(OWNER, { replyId: id });
    expect(h.texts(await h.say(OWNER, { replyId: id }))).toContain("Already saved");
    expect(await h.db.select().from(products)).toHaveLength(1);
  });

  it("asks before replacing an existing dish, and edits by number", async () => {
    const h = await harness({ env: FORM });
    await addAndSave(h, "/add-product Dal 8oz 6, 16oz 10");
    const again = await h.say(OWNER, "/add-product dal 8oz 7, 16oz 11");
    expect(h.texts(again)).toContain("replaces 8oz $6 · 16oz $10");

    const { saved } = await addAndSave(h, "/edit-product 1 8oz 7, 16oz 12");
    expect(h.texts(saved)).toContain("You have 1 dish");
    const [p] = await h.db.select().from(products);
    expect(p!.sizes).toEqual([{ label: "8oz", price_cents: 700 }, { label: "16oz", price_cents: 1200 }]);
    expect(h.texts(await h.say(OWNER, "/edit-product paneer 8"))).toContain("isn't in your dishes");
  });

  it("uses the model for loose text and refuses invented prices", async () => {
    const h = await harness({ env: FORM });
    h.llm.productsResult = {
      products: [
        { name: "Chole", sizes: [{ label: "8oz", price_cents: 500 }], aliases: [] },
        { name: "Lassi", sizes: [{ label: "each", price_cents: 300 }], aliases: [] },
      ],
    };
    const preview = await h.say(OWNER, "/add-product chole small cup is 5 dollars, lassi too");
    expect(h.llm.productsCalls).toHaveLength(1);
    expect(h.texts(preview)).toContain("Chole — 8oz $5");
    expect(h.texts(preview)).toContain("Left out (no price I could find): Lassi");
  });

  it("removes after confirming", async () => {
    const h = await harness({ env: FORM });
    await addAndSave(h, "/add-product Dal 8oz 6\nRoti 1 each");
    const ask = await h.say(OWNER, "/remove-product 2");
    expect(h.texts(ask)).toContain("Remove *Roti*");
    await h.say(OWNER, { replyId: h.buttonsOf(ask)[0]!.id });
    expect(h.texts(await h.say(OWNER, "/products"))).not.toContain("Roti");
  });

  it("treats ADD with a dish name as a product, ADD with a number as a customer", async () => {
    const h = await harness({ env: FORM });
    expect(h.buttonsOf(await h.say(OWNER, "ADD Kheer 4")).map((b) => b.title)).toEqual(["Save", "Cancel"]);
    expect(h.texts(await h.say(OWNER, "ADD +12015551234 Priya"))).not.toContain("Save");
  });
});

describe("menu from the product list (WhatsForm flow)", () => {
  async function withProducts() {
    const h = await harness({ env: FORM });
    await addAndSave(h, "/add-product Dal makhani 8oz 6, 16oz 10\nRoti 1 each\nPaneer tikka S 5 M 8 L 12");
    return h;
  }

  it("builds today's menu by number, publishes, and hands back form lines and the broadcast", async () => {
    const h = await withProducts();
    const preview = await h.say(OWNER, "/menu 1 2 cutoff 11am");
    expect(h.texts(preview)).toContain("Dal Makhani 8oz — $6.00");
    expect(h.texts(preview)).toContain("Cutoff: 11:00 AM");
    const [draft] = await h.db.select().from(menus);
    expect(draft!.items.map((i) => [i.name, i.price_cents, i.size])).toEqual([
      ["Dal Makhani 8oz", 600, "8oz"],
      ["Dal Makhani 16oz", 1000, "16oz"],
      ["Roti", 100, "each"],
    ]);

    const pub = await h.say(OWNER, { replyId: h.buttonsOf(preview)[0]!.id });
    const bodies = pub.map((o) => o.body);
    expect(bodies[0]).toContain("Send me your order form link once with /link");
    const broadcast = bodies.at(-1)!;
    expect(broadcast).toContain("• Dal Makhani — 8oz $6 · 16oz $10");
    expect(broadcast).toContain("• Roti — $1 each");
    expect(broadcast).toContain("Order by 11:00 AM 👉 [LINK]");
    expect(broadcast).not.toContain("wa.me");

    const linked = await h.say(OWNER, "/link https://whatsform.com/abc123");
    expect(linked.at(-1)!.body).toContain("👉 https://whatsform.com/abc123");
  });

  it("picks by name, with a size subset and a day word", async () => {
    const h = await withProducts();
    await h.say(OWNER, "/menu tomorrow: dal (16oz), paneer (s, l)");
    const [m] = await h.db.select().from(menus);
    expect(m!.date).toBe("2026-10-20");
    expect(m!.items.map((i) => i.name)).toEqual(["Dal Makhani 16oz", "Paneer Tikka S", "Paneer Tikka L"]);
  });

  it("says which dishes aren't in the list", async () => {
    const h = await withProducts();
    // Not all dishes resolve: read as chat (the model says what it couldn't match).
    h.llm.ownerOverrides.set("/menu dal, biryani, 9", { action: "set_menu", dishes: [{ n: 1, sizes: [] }], unknown: ["biryani", "#9"] });
    expect(h.texts(await h.say(OWNER, "/menu dal, biryani, 9"))).toContain("Not in your dishes: biryani, #9");
    // The dishes it did find become a draft; nothing is published before Publish.
    const [draft] = await h.db.select().from(menus);
    expect(draft!.status).toBe("draft");
    expect(draft!.items.map((i) => i.name)).toEqual(["Dal Makhani 8oz", "Dal Makhani 16oz"]);
  });

  it("with no dishes, shows the numbered list", async () => {
    const h = await withProducts();
    expect(h.texts(await h.say(OWNER, "/menu"))).toContain("3. Paneer Tikka — S $5 · M $8 · L $12");
  });

  it("keeps the free-text MENU when there is no product list", async () => {
    const h = await harness({ env: FORM });
    const preview = await h.say(OWNER, "MENU Mon: Dal makhani 6, Roti 1. Cutoff 10:30");
    expect(h.texts(preview)).toContain("Dal Makhani — $6.00");
    const pub = await h.say(OWNER, { replyId: h.buttonsOf(preview)[0]!.id });
    expect(pub.at(-1)!.body).toContain("• Gulab Jamun — $2");
  });

  it("sends no order summary at the cutoff", async () => {
    const h = await withProducts();
    const preview = await h.say(OWNER, "/menu 1 cutoff 10:30");
    await h.say(OWNER, { replyId: h.buttonsOf(preview)[0]!.id });
    h.advance(3 * 60 * 60 * 1000);
    const before = h.wa.sent.length;
    await h.app.request("/jobs/cutoff", { method: "POST", headers: { "x-job-secret": "job-secret" } });
    await h.drain();
    expect(h.wa.sent.length).toBe(before);
    expect((await h.db.select().from(menus))[0]!.status).toBe("closed");
  });

  it("shows the short help in the WhatsForm flow", async () => {
    const h = await harness({ env: FORM });
    const help = h.texts(await h.say(OWNER, "/help"));
    expect(help).toContain("/how");
    expect(help).toContain("/app");
    expect(help).not.toContain("/add-product");
    expect(help).not.toContain("BALANCE");
    expect(h.texts(await h.say(OWNER, "/help all"))).toContain("BALANCE");
  });
});

describe("owner-only mode", () => {
  it("records strangers but never answers or calls the model", async () => {
    const h = await harness({ env: FORM });
    const out = await h.say("+12015557777", "hi I want 2 dal");
    expect(out).toEqual([]);
    expect(h.llm.calls).toEqual([]);
    const [m] = await h.db.select().from(messages);
    expect(m!.intent).toBe("owner_only_ignored");
  });
});

describe("resolvePicks", () => {
  const p = (id: number, name: string, aliases: string[] = []) => ({
    id,
    name,
    nameKey: name.toLowerCase(),
    sizes: [{ label: "each", price_cents: 100 }],
    aliases,
    active: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const list = [p(1, "Dal Makhani", ["daal"]), p(2, "Dal Tadka"), p(3, "Roti", ["chapati"])];

  it("matches exact, alias and unique partial names; refuses ambiguous ones", () => {
    expect(resolvePicks("daal, chapati, tadka", list).picks.map((x) => x.product.id)).toEqual([1, 3, 2]);
    expect(resolvePicks("dal", list).unknown).toEqual(["dal"]);
  });
});
