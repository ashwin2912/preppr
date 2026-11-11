import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { customers, formResponses, menus, products } from "../src/db/schema";
import { parseOrderText, prepTotals } from "../src/domain/formOrders";
import { FORM_SCRIPT } from "../src/flows/formScript";
import { productFromForm } from "../src/admin/kitchen";
import { harness, OWNER } from "./helpers";

type H = Awaited<ReturnType<typeof harness>>;
const FORM = { ORDER_CHANNEL: "whatsform", OWNER_ONLY: "1" };

/** Owner sends /app, opens the link; returns the session cookie. */
async function login(h: H) {
  const out = await h.say(OWNER, "/app");
  expect(out[0]!.body).toContain("30 days");
  const link = out[0]!.body.match(/https:\/\/preppr\.test(\/admin\?\S+)/)![1]!;
  const res = await h.app.request(link);
  expect(res.status).toBe(302);
  expect(res.headers.get("location")).toBe("/admin/kitchen");
  const cookie = res.headers.get("set-cookie")!;
  expect(Number(cookie.match(/Max-Age=(\d+)/)![1])).toBeGreaterThan(29 * 24 * 3600);
  return cookie.split(";")[0]!;
}

const get = (h: H, path: string, cookie?: string) => h.app.request(path, { headers: cookie ? { cookie } : {} });
function post(h: H, path: string, cookie: string, fields: [string, string][], origin = "https://preppr.test", extra: Record<string, string> = {}) {
  return h.app.request(`https://preppr.test${path}`, {
    method: "POST",
    headers: { cookie, origin, "content-type": "application/x-www-form-urlencoded", ...extra },
    body: new URLSearchParams(fields).toString(),
  });
}

describe("product form parsing", () => {
  it("reads sizes, a single price, and refuses bad input", () => {
    expect(productFromForm({ name: "Dal", label_0: "8oz", price_0: "6", label_1: "16oz", price_1: "$10.50" })).toEqual({
      name: "Dal",
      sizes: [
        { label: "8oz", price_cents: 600 },
        { label: "16oz", price_cents: 1050 },
      ],
    });
    expect(productFromForm({ name: "Roti", label_0: "", price_0: "1" })).toEqual({ name: "Roti", sizes: [{ label: "each", price_cents: 100 }] });
    expect(productFromForm({ name: "Dal", label_0: "8oz", price_0: "six" })).toHaveProperty("error");
    expect(productFromForm({ name: "", price_0: "1" })).toHaveProperty("error");
    expect(productFromForm({ name: "Dal" })).toHaveProperty("error");
    expect(productFromForm({ name: "Dal", label_0: "8oz", price_0: "6", label_1: "8OZ", price_1: "7" })).toHaveProperty("error");
  });
});

describe("kitchen page", () => {
  it("needs the /app link", async () => {
    const h = await harness({ env: FORM });
    expect((await get(h, "/admin/kitchen")).status).toBe(401);
    expect((await post(h, "/admin/kitchen/p", "preppr_admin=bogus", [["name", "Dal"]])).status).toBe(401);
  });

  it("adds, edits and removes dishes; WhatsApp numbering matches", async () => {
    const h = await harness({ env: FORM });
    const cookie = await login(h);
    let res = await post(h, "/admin/kitchen/p", cookie, [["name", "Dal Makhani"], ["label_0", "8oz"], ["price_0", "6"], ["label_1", "16oz"], ["price_1", "10"]]);
    expect(res.status).toBe(303);
    await post(h, "/admin/kitchen/p", cookie, [["name", "Roti"], ["price_0", "1"]]);
    const html = await (await get(h, "/admin/kitchen/products", cookie)).text();
    expect(html).toContain("Dal Makhani");
    expect(html).toContain("8oz $6 · 16oz $10");
    expect(h.texts(await h.say(OWNER, "/products"))).toContain("2. Roti — $1 each");

    // Duplicate name is refused; editing keeps the id.
    res = await post(h, "/admin/kitchen/p", cookie, [["name", "roti"], ["price_0", "2"]]);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("already have a dish called Roti");
    const [dal] = await h.db.select().from(products).where(eq(products.name, "Dal Makhani"));
    await post(h, `/admin/kitchen/p/${dal!.id}`, cookie, [["name", "Dal Makhani"], ["label_0", "8oz"], ["price_0", "7"]]);
    expect((await h.db.select().from(products).where(eq(products.id, dal!.id)))[0]!.sizes).toEqual([{ label: "8oz", price_cents: 700 }]);

    await post(h, `/admin/kitchen/p/${dal!.id}/remove`, cookie, []);
    expect(h.texts(await h.say(OWNER, "/products"))).not.toContain("Dal");
  });

  it("refuses posts from another site", async () => {
    const h = await harness({ env: FORM });
    const cookie = await login(h);
    const res = await post(h, "/admin/kitchen/p", cookie, [["name", "Dal"], ["price_0", "6"]], "https://evil.example");
    expect(res.status).toBe(401);
    const cross = await post(h, "/admin/kitchen/p", cookie, [["name", "Dal"], ["price_0", "6"]], "null", { "sec-fetch-site": "cross-site" });
    expect(cross.status).toBe(401);
    expect(await h.db.select().from(products)).toHaveLength(0);
  });

  it("accepts a real browser post that sends Origin: null (same-origin per Sec-Fetch-Site)", async () => {
    const h = await harness({ env: FORM });
    const cookie = await login(h);
    const res = await post(h, "/admin/kitchen/p", cookie, [["name", "Dal"], ["price_0", "6"]], "null", { "sec-fetch-site": "same-origin" });
    expect(res.status).toBe(303);
    expect(res.headers.get("referrer-policy")).toBe("same-origin");
    expect(await h.db.select().from(products)).toHaveLength(1);
  });

  it("publishes a menu from ticked sizes and shows the WhatsForm lines, link and broadcast", async () => {
    const h = await harness({ env: FORM });
    const cookie = await login(h);
    await post(h, "/admin/kitchen/p", cookie, [["name", "Dal"], ["label_0", "8oz"], ["price_0", "6"], ["label_1", "16oz"], ["price_1", "10"]]);
    await post(h, "/admin/kitchen/p", cookie, [["name", "Roti"], ["price_0", "1"]]);
    const [dal, roti] = await h.db.select().from(products).orderBy(products.id);

    const res = await post(h, "/admin/kitchen/menu", cookie, [["s", `${dal!.id}:1`], ["s", `${roti!.id}:0`]]);
    expect(res.status).toBe(303);
    const [m] = await h.db.select().from(menus);
    expect(m!.status).toBe("active");
    expect(m!.items.map((i) => i.name)).toEqual(["Dal 16oz", "Roti"]);

    await post(h, "/admin/kitchen/link", cookie, [["url", "https://whatsform.com/abc"], ["date", m!.date]]);
    const html = await (await get(h, "/admin/kitchen", cookie)).text();
    expect(html).toContain("Order here 👉 https://whatsform.com/abc");
    expect(html).not.toContain("cutoff");
    expect(html).toContain("2 items on the menu");
    expect(html).toContain(`href="/admin/kitchen/menu">Edit</a>`);
    // Link saved once: only the broadcast is left, after the menu summary.
    expect(html).toContain("Send today's broadcast");
    expect(html.indexOf("items on the menu")).toBeLessThan(html.indexOf("Send today's broadcast"));
    expect(html.indexOf("Send today's broadcast")).toBeLessThan(html.indexOf("orders</span>"));
    expect(html).toContain("/wf.js&quot;&gt;&lt;/script&gt;");
    // The same link reaches the WhatsApp broadcast.
    expect(h.texts(await h.say(OWNER, "/link https://whatsform.com/abc"))).toContain("whatsform.com/abc");
  });

  it("won't save a menu with nothing ticked; Edit shows today's dishes ticked", async () => {
    const h = await harness({ env: FORM }); // 8:00 AM ET
    const cookie = await login(h);
    await post(h, "/admin/kitchen/p", cookie, [["name", "Roti"], ["price_0", "1"]]);
    await post(h, "/admin/kitchen/p", cookie, [["name", "Kheer"], ["price_0", "4"]]);
    const res = await post(h, "/admin/kitchen/menu", cookie, []);
    expect(decodeURIComponent(res.headers.get("location")!)).toContain("Tick at least one");
    expect(await h.db.select().from(menus)).toHaveLength(0);

    const [roti] = await h.db.select().from(products).where(eq(products.name, "Roti"));
    await post(h, "/admin/kitchen/menu", cookie, [["s", `${roti!.id}:0`]]);
    const picker = await (await get(h, "/admin/kitchen/menu", cookie)).text();
    expect(picker).toContain(`value="${roti!.id}:0" checked`);
    expect(picker).not.toContain("cutoff");
    const [m] = await h.db.select().from(menus);
    expect(m!.status).toBe("active");
  });

  it("accepts /menu 1,2 on WhatsApp", async () => {
    const h = await harness({ env: FORM });
    const cookie = await login(h);
    await post(h, "/admin/kitchen/p", cookie, [["name", "Dal"], ["price_0", "6"]]);
    await post(h, "/admin/kitchen/p", cookie, [["name", "Roti"], ["price_0", "1"]]);
    const preview = await h.say(OWNER, "/menu 1,2");
    expect(h.buttonsOf(preview).map((b) => b.title)).toEqual(["Publish", "Edit"]);
  });
});

describe("today view and WhatsForm orders", () => {
  async function withMenu() {
    const h = await harness({ env: FORM });
    const cookie = await login(h);
    await post(h, "/admin/kitchen/p", cookie, [["name", "Palak Paneer"], ["label_0", "8oz"], ["price_0", "8"], ["label_1", "16oz"], ["price_1", "14"]]);
    await post(h, "/admin/kitchen/p", cookie, [["name", "Roti"], ["price_0", "1"]]);
    const [pp, roti] = await h.db.select().from(products).orderBy(products.id);
    await post(h, "/admin/kitchen/menu", cookie, [["s", `${pp!.id}:0`], ["s", `${pp!.id}:1`], ["s", `${roti!.id}:0`]]);
    const today = await (await get(h, "/admin/kitchen", cookie)).text();
    const hook = today.match(/https:\/\/preppr\.test(\/webhooks\/whatsform\/[\w-]+)/)![1]!;
    const submit = (body: unknown) =>
      h.app.request(hook, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { h, cookie, submit };
  }

  it("without a menu, only offers to create one", async () => {
    const h = await harness({ env: FORM });
    const cookie = await login(h);
    let html = await (await get(h, "/admin/kitchen", cookie)).text();
    expect(html).toContain("Add your first dish");
    await post(h, "/admin/kitchen/p", cookie, [["name", "Roti"], ["price_0", "1"]]);
    html = await (await get(h, "/admin/kitchen", cookie)).text();
    expect(html).toContain("Create today's menu");
    expect(html).toContain('class="off"');
    expect(html).not.toContain("webhooks/whatsform");
  });

  it("stores submissions, prices them in code, and totals what to make", async () => {
    const { h, cookie, submit } = await withMenu();
    expect((await submit({ "Response number": "1", "Your name": "Priya", "Your WhatsApp number": "+1 (201) 555-0101", Area: "Heights", "Palak Paneer – 8oz – $8": "3", "Palak Paneer – 16oz – $14": "1", "Roti – each – $1": "6", Total: "999" })).status).toBe(200);
    await submit({ "Response number": "2", Name: "Sam", "Phone": "2015550102", "Palak Paneer – 8oz": "2", "Roti – each": "4" });
    await submit({ "Response number": "2", Name: "Sam", "Phone": "2015550102", "Palak Paneer – 8oz": "2" }); // redelivery

    const rows = await h.db.select().from(formResponses);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.totalCents).toBe(3 * 800 + 1400 + 6 * 100);
    const [priya] = await h.db.select().from(customers).where(eq(customers.phone, "+12015550101"));
    expect(priya).toMatchObject({ name: "Priya", area: "Heights" });

    const html = await (await get(h, "/admin/kitchen", cookie)).text();
    expect(html).toContain("<b>2</b><span>orders</span>");
    expect(html).toContain("$64.00"); // Priya 44 + Sam 20
    expect(html).toContain("<b>56 oz</b>"); // 5×8oz + 1×16oz
    expect(html).toContain("<b>10</b>"); // roti
  });

  it("answers /how, /what, /orders and /message on WhatsApp", async () => {
    const { h, cookie, submit } = await withMenu();
    await submit({ "Response number": "1", Name: "Priya", Area: "Heights", "Palak Paneer – 8oz – $8": "3", "Roti – each – $1": "6" });
    await submit({ "Response number": "2", Name: "Sam", "Palak Paneer – 16oz": "1" });

    const how = h.texts(await h.say(OWNER, "/how"));
    expect(how).toContain("2 orders · $44.00");
    expect(how).toContain("Menu: Palak Paneer, Roti");
    expect(how).toContain("Order form link not saved yet");

    const what = h.texts(await h.say(OWNER, "what"));
    expect(what).toContain("Palak Paneer: *40 oz* (3× 8oz, 1× 16oz)");
    expect(what).toContain("Roti: *6*");

    const orders = h.texts(await h.say(OWNER, "/orders"));
    expect(orders).toContain("1. *Priya* (Heights): 3× Palak Paneer 8oz, 6× Roti — $30.00");
    expect(orders).toContain("Total: $44.00");

    expect(h.texts(await h.say(OWNER, "/message"))).toContain("[LINK]");
    await post(h, "/admin/kitchen/link", cookie, [["url", "https://whatsform.com/x"], ["date", (await h.db.select().from(menus))[0]!.date]]);
    const msg = await h.say(OWNER, "/message");
    expect(msg).toHaveLength(1);
    expect(msg[0]!.body).toContain("Order here 👉 https://whatsform.com/x");
  });

  it("says there's no menu yet", async () => {
    const h = await harness({ env: FORM });
    for (const cmd of ["/how", "/what", "/orders", "/message"]) expect(h.texts(await h.say(OWNER, cmd))).toContain("No menu for today yet");
  });

  it("flags answers that match nothing on the menu", async () => {
    const { h, cookie, submit } = await withMenu();
    await submit({ "Response number": "9", Name: "Ana", "Dal – 8oz – $6": "2" });
    const html = await (await get(h, "/admin/kitchen", cookie)).text();
    expect(html).toContain("1 order need a look");
    expect(html).toContain("check: Dal – 8oz – $6: 2");
  });

  it("rejects a wrong webhook token", async () => {
    const h = await harness({ env: FORM });
    const res = await h.app.request("/webhooks/whatsform/nope", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(res.status).toBe(404);
  });
});

describe("one permanent order form", () => {
  async function withMenu() {
    const h = await harness({ env: FORM });
    const cookie = await login(h);
    await post(h, "/admin/kitchen/p", cookie, [["name", "Palak Paneer"], ["label_0", "8oz"], ["price_0", "8"], ["label_1", "16oz"], ["price_1", "14"]]);
    await post(h, "/admin/kitchen/p", cookie, [["name", "Roti"], ["price_0", "1"]]);
    const [pp, roti] = await h.db.select().from(products).orderBy(products.id);
    const today = await (await get(h, "/admin/kitchen", cookie)).text();
    const hook = today.match(/https:\/\/preppr\.test(\/webhooks\/whatsform\/[\w-]+)/)?.[1];
    return { h, cookie, pp: pp!, roti: roti!, hook };
  }
  const menuJson = async (h: H) => {
    const res = await get(h, "/public/menu.json");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    return res.json();
  };

  it("menu.json shows the published menu grouped by dish, and closes at cutoff", async () => {
    const { h, cookie, pp, roti } = await withMenu();
    expect(await menuJson(h)).toMatchObject({ open: false, dishes: [] });

    await post(h, "/admin/kitchen/menu", cookie, [["s", `${pp.id}:0`], ["s", `${pp.id}:1`], ["s", `${roti.id}:0`]]);
    const m = await menuJson(h);
    expect(m).toMatchObject({ open: true, cutoff: null, date: "2026-10-19" });
    expect(m.dishes).toEqual([
      {
        name: "Palak Paneer",
        sizes: [
          { id: "i1", label: "8oz", name: "Palak Paneer 8oz", price_cents: 800, price: "$8" },
          { id: "i2", label: "16oz", name: "Palak Paneer 16oz", price_cents: 1400, price: "$14" },
        ],
      },
      { name: "Roti", sizes: [{ id: "i3", label: null, name: "Roti", price_cents: 100, price: "$1" }] },
    ]);
    expect(JSON.stringify(m)).not.toMatch(/phone|customer/i);

    // Chat menu with a cutoff: shown, then closed once it passes.
    const h2 = await harness({ env: FORM });
    await h2.publishMenu();
    expect(await menuJson(h2)).toMatchObject({ open: true, cutoff: "10:30 AM" });
    h2.advance(3 * 3600_000);
    expect(await menuJson(h2)).toMatchObject({ open: false });
  });

  it("serves the form script", async () => {
    const { h } = await withMenu();
    const res = await get(h, "/wf.js");
    expect(res.headers.get("content-type")).toContain("javascript");
    const js = await res.text();
    expect(js).toContain("/public/menu.json");
    expect(() => new Function(js)).not.toThrow(); // parses
    expect(js).toBe(FORM_SCRIPT);
  });

  it("reads the 'Your order' answer, prices it in code, and flags what it can't read", async () => {
    const { h, cookie, pp, roti, hook } = await withMenu();
    await post(h, "/admin/kitchen/menu", cookie, [["s", `${pp.id}:0`], ["s", `${pp.id}:1`], ["s", `${roti.id}:0`]]);
    const hookUrl = hook ?? (await (await get(h, "/admin/kitchen", cookie)).text()).match(/https:\/\/preppr\.test(\/webhooks\/whatsform\/[\w-]+)/)![1]!;
    const submit = (body: unknown) => h.app.request(hookUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

    await submit({ "Response number": "1", Name: "Priya", Phone: "2015550101", "Your order": "2 × Palak Paneer 8oz, 4 × Roti (total $999)" });
    await submit({ "Response number": "2", Name: "Sam", "Your order": "1 palak paneer 16oz and 3 roti" });
    await submit({ "Response number": "3", Name: "Ana", "Your order": "whatever is good today" });

    const rows = await h.db.select().from(formResponses).orderBy(formResponses.id);
    expect(rows.map((r) => [r.name, r.lines.map((l) => `${l.qty}× ${l.name}`), r.totalCents, r.unmatched])).toEqual([
      ["Priya", ["2× Palak Paneer 8oz", "4× Roti"], 2000, []],
      ["Sam", ["1× Palak Paneer 16oz", "3× Roti"], 1700, []],
      ["Ana", [], 0, ["Order: whatever is good today"]],
    ]);
  });

  it("keeps one link: saved once, it's in every day's broadcast", async () => {
    const h = await harness({ env: FORM });
    await h.say(OWNER, "/link https://whatsform.com/kitchen");
    h.advance(24 * 3600_000);
    const out = await h.say(OWNER, "/message");
    expect(h.texts(out)).toContain("No menu for today yet");
    const cookie = await login(h);
    await post(h, "/admin/kitchen/p", cookie, [["name", "Roti"], ["price_0", "1"]]);
    const [roti] = await h.db.select().from(products);
    await post(h, "/admin/kitchen/menu", cookie, [["s", `${roti!.id}:0`]]);
    expect(h.texts(await h.say(OWNER, "/message"))).toContain("Order here 👉 https://whatsform.com/kitchen");
  });
});

describe("order text", () => {
  const items = [
    { id: "i1", name: "Dal 8oz", price_cents: 600, aliases: ["dal 8oz"], product_id: 1, size: "8oz" },
    { id: "i2", name: "Roti", price_cents: 100, aliases: ["roti"], product_id: 2, size: "each" },
  ];
  it("reads the script's format, typed orders, and nothing else", () => {
    expect([...parseOrderText("2 × Dal 8oz, 4 × Roti (total $16)", items).qty]).toEqual([["i1", 2], ["i2", 4]]);
    expect([...parseOrderText("1 x Dal – 8oz\n1 x Dal 8oz", items).qty]).toEqual([["i1", 2]]);
    expect(parseOrderText("2 × Biryani", items)).toEqual({ qty: new Map(), unmatched: ["Order: 2 × Biryani"] });
    expect(parseOrderText("  ", items).unmatched).toEqual([]);
  });
});

describe("prep totals", () => {
  it("adds up units, counts other sizes and plain dishes", () => {
    const items = [
      { id: "i1", name: "Dal 8oz", price_cents: 600, aliases: [], product_id: 1, size: "8oz" },
      { id: "i2", name: "Dal 16oz", price_cents: 1000, aliases: [], product_id: 1, size: "16oz" },
      { id: "i3", name: "Roti", price_cents: 100, aliases: [], product_id: 2, size: "each" },
      { id: "i4", name: "Biryani Half", price_cents: 800, aliases: [], product_id: 3, size: "Half" },
      { id: "i5", name: "Biryani Full", price_cents: 1400, aliases: [], product_id: 3, size: "Full" },
    ];
    const line = (item_id: string, qty: number) => ({ item_id, name: "", qty, unit_cents: 0, note: null });
    expect(prepTotals(items, [line("i1", 5), line("i2", 1), line("i3", 10), line("i4", 2), line("i5", 1), line("i1", 1)])).toEqual([
      { name: "Dal", amount: "64 oz", detail: "6× 8oz, 1× 16oz" },
      { name: "Roti", amount: "10", detail: "" },
      { name: "Biryani", amount: "3", detail: "2× Half, 1× Full" },
    ]);
  });
});
