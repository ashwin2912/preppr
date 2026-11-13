import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { customerDevices, customers, formResponses, menus, orders } from "../src/db/schema";
import { linesFromForm, maskAddress, maskName } from "../src/domain/orderPage";
import { keepItemIds } from "../src/domain/products";
import { upsertMenu } from "../src/flows/menuDraft";
import { rateLimiter } from "../src/lib/rateLimit";
import { harness, OWNER } from "./helpers";

type H = Awaited<ReturnType<typeof harness>>;
const ENV = { ORDER_CHANNEL: "page", OWNER_ONLY: "1" };
const BASE = "https://preppr.test";

/** A harness with today's menu published (Dal 6, Rice 4, Roti 1, Paneer 7, Jamun 2; cutoff 10:30). */
async function setup() {
  const h = await harness({ env: ENV });
  await h.publishMenu();
  const [m] = await h.db.select().from(menus);
  const id = (name: string) => m!.items.find((i) => i.name === name)!.id;
  return { h, menu: m!, dal: id("Dal Makhani"), roti: id("Roti"), rice: id("Jeera Rice") };
}

let ipSeq = 0;
function post(h: H, path: string, fields: [string, string][], opts: { cookie?: string; ip?: string; headers?: Record<string, string> } = {}) {
  return h.app.request(`${BASE}${path}`, {
    method: "POST",
    headers: {
      origin: BASE,
      "content-type": "application/x-www-form-urlencoded",
      "x-forwarded-for": opts.ip ?? `10.0.0.${++ipSeq % 250}`,
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
      ...opts.headers,
    },
    body: new URLSearchParams(fields).toString(),
  });
}
const get = (h: H, path: string, cookie?: string) => h.app.request(`${BASE}${path}`, { headers: cookie ? { cookie } : {} });
const cookieOf = (res: Response) => {
  const v = res.headers.get("set-cookie")?.match(/po=([^;]+)/)?.[1];
  return v ? `po=${v}` : undefined;
};

/** Owner's kitchen page session cookie. */
async function login(h: H) {
  const out = await h.say(OWNER, "/app"); // order pings may drain in the same batch
  const link = h.texts(out).match(/https:\/\/preppr\.test(\/admin\?\S+)/)![1]!;
  const res = await h.app.request(link);
  return res.headers.get("set-cookie")!.split(";")[0]!;
}
const kitchenPost = (h: H, path: string, cookie: string) =>
  h.app.request(`${BASE}${path}`, { method: "POST", headers: { cookie, origin: BASE, "content-type": "application/x-www-form-urlencoded" }, body: "" });

/** First order from a new number; returns the device cookie. */
async function firstOrder(h: H, dal: string, roti: string, phone = "201-555-0111", name = "Priya Sharma", address = "12 Oak Street Apt 4B") {
  const res = await post(h, "/order", [
    ["phone", phone],
    ["name", name],
    ["address", address],
    ["area", "Heights"],
    [`q_${dal}`, "2"],
    [`q_${roti}`, "4"],
    ["price_cents", "1"],
    ["action", "save"],
  ]);
  expect(res.status).toBe(200);
  return { res, cookie: cookieOf(res)!, html: await res.text() };
}

describe("order page helpers", () => {
  it("masks names and addresses", () => {
    expect(maskName("Priya Sharma")).toBe("P***a");
    expect(maskName("Al")).toBe("A*");
    expect(maskName(null)).toBeNull();
    expect(maskAddress("12 Oak Street Apt 4B")).toBe("…Apt 4B");
    expect(maskAddress("12 Oak")).toBe("…Oak");
    expect(maskAddress("Building 12")).toBe("…");
    expect(maskAddress("")).toBeNull();
  });

  it("reads quantity fields and never prices", () => {
    const items = [{ id: "i1", name: "Dal", price_cents: 600, aliases: [] }];
    expect(linesFromForm({ q_i1: "2", name: "x", price: "1" }, items)).toEqual({ raw: [{ item_id: "i1", qty: 2, note: null }], problems: [] });
    expect(linesFromForm({ q_i1: "0", q_i2: "" }, items).raw).toEqual([]);
    expect(linesFromForm({ q_i1: "51" }, items).problems).toHaveLength(1);
    expect(linesFromForm({ q_i1: "2.5" }, items).problems).toHaveLength(1);
    expect(linesFromForm({ q_i9: "1" }, items).problems).toHaveLength(1);
  });

  it("rate limiter counts per key per window", () => {
    const rl = rateLimiter(2, 1000);
    const t = new Date(0);
    expect([rl.hit("a", t), rl.hit("a", t), rl.hit("a", t), rl.hit("b", t)]).toEqual([true, true, false, true]);
    expect(rl.hit("a", new Date(1000))).toBe(true);
  });

  it("keeps item ids across menu edits", () => {
    const prev = [
      { id: "i1", name: "Dal 8oz", price_cents: 600, aliases: [], product_id: 1, size: "8oz" },
      { id: "i2", name: "Roti", price_cents: 100, aliases: [], product_id: 2, size: "each" },
    ];
    const next = [
      { id: "i1", name: "Roti", price_cents: 100, aliases: [], product_id: 2, size: "each" },
      { id: "i2", name: "Paneer", price_cents: 700, aliases: [], product_id: 3, size: "each" },
      { id: "i3", name: "Dal 8oz", price_cents: 600, aliases: [], product_id: 1, size: "8oz" },
    ];
    expect(keepItemIds(prev, next).map((i) => `${i.name}=${i.id}`)).toEqual(["Roti=i2", "Paneer=i3", "Dal 8oz=i1"]);
  });
});

describe("order page", () => {
  it("first order: phone step, details, priced in code, device remembered, owner pinged", async () => {
    const { h, dal, roti } = await setup();
    const page = await get(h, "/order");
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain("script-src 'nonce-");
    expect(page.headers.get("referrer-policy")).toBe("no-referrer");
    const html = await page.text();
    expect(html).toContain("Your WhatsApp number");
    expect(html).toContain("Order by 10:30 AM");

    const start = await (await post(h, "/order/start", [["phone", "201-555-0111"]])).text();
    expect(start).toContain('name="name"');
    expect(start).toContain(`name="q_${dal}"`);

    const sentBefore = h.wa.sent.length;
    const { res, cookie, html: done } = await firstOrder(h, dal, roti);
    expect(done).toContain("Order received");
    expect(done).toContain("$16.00");
    expect(res.headers.get("set-cookie")).toMatch(/HttpOnly/i);
    expect(res.headers.get("set-cookie")).toMatch(/SameSite=Lax/i);
    expect(cookie).toBeTruthy();

    const [o] = await h.db.select().from(orders);
    expect(o).toMatchObject({ customerPhone: "+12015550111", totalCents: 1600, status: "confirmed", source: "page", flagged: false, address: "12 Oak Street Apt 4B" });
    const [c] = await h.db.select().from(customers).where(eq(customers.phone, "+12015550111"));
    expect(c).toMatchObject({ name: "Priya Sharma", area: "Heights", addressNote: "12 Oak Street Apt 4B" });
    const [d] = await h.db.select().from(customerDevices);
    expect(d!.trusted).toBe(true);
    expect(d!.tokenHash).not.toContain(cookie.slice(3));

    await h.drain();
    const pings = h.wa.sent.slice(sentBefore).filter((m) => m.to === OWNER);
    expect(pings).toHaveLength(1);
    expect(pings[0]!.body).toContain("New order: Priya Sharma (Heights)");
    expect(pings[0]!.body).toContain("2× Dal Makhani, 4× Roti — $16.00");
  });

  it("returning browser: prefilled, edits the same order, resubmit is quiet, cancel works", async () => {
    const { h, dal, roti } = await setup();
    const { cookie } = await firstOrder(h, dal, roti);
    await h.drain();

    const html = await (await get(h, "/order", cookie)).text();
    expect(html).toContain('value="Priya Sharma"');
    expect(html).toContain(`name="q_${dal}" value="2"`);
    expect(html).toContain("Update order");
    expect(html).not.toContain("Your WhatsApp number");

    const edit: [string, string][] = [
      ["name", "Priya Sharma"],
      ["address", "12 Oak Street Apt 4B"],
      [`q_${dal}`, "1"],
      ["action", "save"],
    ];
    expect((await post(h, "/order", edit, { cookie })).status).toBe(200);
    const rows = await h.db.select().from(orders);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.totalCents).toBe(600);
    await h.drain();
    const n = h.wa.sent.length;
    expect(h.wa.sent.at(-1)!.body).toContain("Order changed");

    expect((await post(h, "/order", edit, { cookie })).status).toBe(200);
    await h.drain();
    expect(h.wa.sent.length).toBe(n);

    const cancel = await post(h, "/order", [["action", "cancel"]], { cookie });
    expect(await cancel.text()).toContain("cancelled");
    const [o] = await h.db.select().from(orders);
    expect(o!.status).toBe("cancelled");
    await h.drain();
    expect(h.wa.sent.at(-1)!.body).toContain("Order cancelled: Priya Sharma");
  });

  it("closes at the cutoff", async () => {
    const { h, dal, roti } = await setup();
    const { cookie } = await firstOrder(h, dal, roti);
    h.advance(3 * 3600_000); // 11:00 AM
    const html = await (await get(h, "/order", cookie)).text();
    expect(html).toContain("Ordering is closed");
    expect(html).toContain("Your order for");
    const late = await post(h, "/order", [["name", "Priya"], ["address", "x"], [`q_${dal}`, "5"]], { cookie });
    expect(late.status).toBe(409);
    const [o] = await h.db.select().from(orders);
    expect(o!.totalCents).toBe(1600);
  });

  it("known number on a new browser: masked details, can't replace an order, flagged until the owner trusts it", async () => {
    const { h, dal, roti } = await setup();
    await firstOrder(h, dal, roti);

    const start = await (await post(h, "/order/start", [["phone", "(201) 555-0111"]])).text();
    expect(start).toContain("P***a");
    expect(start).toContain("…Apt 4B");
    expect(start).not.toContain("Priya");
    expect(start).not.toContain("Oak Street");
    expect(start).not.toContain('name="name"');

    const steal = await post(h, "/order", [["phone", "201-555-0111"], [`q_${dal}`, "9"], ["action", "save"]]);
    expect(steal.status).toBe(409);
    expect((await h.db.select().from(orders))[0]!.totalCents).toBe(1600);
    const steal2 = await post(h, "/order", [["phone", "201-555-0111"], ["action", "cancel"]]);
    expect(steal2.status).toBe(409);
    expect((await h.db.select().from(orders))[0]!.status).toBe("confirmed");

    // A saved customer (imported) with no order yet: their order goes in, flagged.
    await h.db.insert(customers).values({ phone: "+12015550122", name: "Ravi Kumar", addressNote: "7 Elm Road", area: "Newport" });
    const res = await post(h, "/order", [["phone", "201-555-0122"], [`q_${roti}`, "3"], ["name", "Mallory"], ["address", "evil"], ["action", "save"]]);
    expect(res.status).toBe(200);
    const cookie = cookieOf(res)!;
    const [o] = await h.db.select().from(orders).where(eq(orders.customerPhone, "+12015550122"));
    expect(o).toMatchObject({ flagged: true, flagReason: "new device", totalCents: 300, address: "7 Elm Road" });
    const [c] = await h.db.select().from(customers).where(eq(customers.phone, "+12015550122"));
    expect(c!.name).toBe("Ravi Kumar");

    const again = await (await get(h, "/order", cookie)).text();
    expect(again).toContain("R***r");
    expect(again).not.toContain("Ravi");
    // Same untrusted browser may still change its own flagged order.
    expect((await post(h, "/order", [[`q_${roti}`, "4"], ["action", "save"]], { cookie })).status).toBe(200);

    await h.drain();
    expect(h.wa.sent.at(-1)!.body).toContain("new phone");

    const admin = await login(h);
    const kitchen = await (await get(h, "/admin/kitchen", admin)).text();
    expect(kitchen).toContain("new device");
    expect(kitchen).toContain(`/admin/kitchen/o/o:${o!.id}/trust`);
    expect((await kitchenPost(h, `/admin/kitchen/o/o:${o!.id}/trust`, admin)).status).toBe(303);
    const [after] = await h.db.select().from(orders).where(eq(orders.id, o!.id));
    expect(after!.flagged).toBe(false);
    expect(await (await get(h, "/order", cookie)).text()).toContain('value="Ravi Kumar"');
  });

  it("rejects bad lines, missing details, cross-site posts and floods", async () => {
    const { h, dal, roti } = await setup();
    const base: [string, string][] = [["phone", "201-555-0133"], ["name", "A"], ["address", "B"]];
    expect((await post(h, "/order", [...base, ["q_i99", "1"]])).status).toBe(400);
    expect((await post(h, "/order", [...base, [`q_${dal}`, "51"]])).status).toBe(400);
    expect((await post(h, "/order", [...base, [`q_${dal}`, "two"]])).status).toBe(400);
    expect((await post(h, "/order", [...base])).status).toBe(400);
    expect((await post(h, "/order", [["phone", "201-555-0133"], [`q_${roti}`, "1"]])).status).toBe(400);
    expect((await post(h, "/order", [["phone", "12"], [`q_${roti}`, "1"]])).status).toBe(400);
    expect((await post(h, "/order", [...base, [`q_${roti}`, "1"]], { headers: { "sec-fetch-site": "cross-site" } })).status).toBe(403);
    expect(await h.db.select().from(orders)).toHaveLength(0);

    const codes: number[] = [];
    for (let i = 0; i < 11; i++) codes.push((await post(h, "/order/start", [["phone", `201-555-01${10 + i}`]], { ip: "9.9.9.9" })).status);
    expect(codes.slice(0, 10).every((s) => s === 200)).toBe(true);
    expect(codes[10]).toBe(429);
  });

  it("escapes customer text on the order page and the kitchen page", async () => {
    const { h, dal, roti } = await setup();
    const { cookie } = await firstOrder(h, dal, roti, "201-555-0144", `<script>alert(1)</script>`, `<img src=x onerror=alert(1)>`);
    const html = await (await get(h, "/order", cookie)).text();
    expect(html).not.toContain("<script>alert(1)");
    expect(html).not.toContain("<img src=x");
    const kitchen = await (await get(h, "/admin/kitchen", await login(h))).text();
    expect(kitchen).not.toContain("<script>alert(1)");
    expect(kitchen).toContain("&lt;script&gt;alert(1)");
  });

  it("forgetting devices from the Customers tab makes the browser ask again", async () => {
    const { h, dal, roti } = await setup();
    const { cookie } = await firstOrder(h, dal, roti);
    const admin = await login(h);
    const list = await (await get(h, "/admin/kitchen/customers", admin)).text();
    expect(list).toContain("Priya Sharma");
    expect(list).toContain("forget 1 device");
    expect((await kitchenPost(h, `/admin/kitchen/customers/${encodeURIComponent("+12015550111")}/forget`, admin)).status).toBe(303);
    expect(await (await get(h, "/order", cookie)).text()).toContain("Your WhatsApp number");
    const [d] = await h.db.select().from(customerDevices);
    expect(d!.revokedAt).not.toBeNull();
  });

  it("imports customers from a CSV upload", async () => {
    const { h } = await setup();
    const admin = await login(h);
    const fd = new FormData();
    fd.append("file", new File(["phone,name,area,address_note\n201-555-0155,Meena,Heights,3 Pine St\nbad,No One,,\n"], "customers.csv", { type: "text/csv" }));
    const res = await h.app.request(`${BASE}/admin/kitchen/customers/import`, { method: "POST", headers: { cookie: admin, origin: BASE }, body: fd });
    const html = await res.text();
    expect(html).toContain("1 added");
    expect(html).toContain("Skipped 1 invalid number");
    const [c] = await h.db.select().from(customers).where(eq(customers.phone, "+12015550155"));
    expect(c).toMatchObject({ name: "Meena", area: "Heights", addressNote: "3 Pine St" });
  });

  it("owner views and the broadcast include page and WhatsForm orders", async () => {
    const { h, menu, dal, roti, rice } = await setup();
    await firstOrder(h, dal, roti);
    await h.db.insert(formResponses).values({
      responseKey: "wf-1",
      menuId: menu.id,
      customerPhone: null,
      name: "Form Fan",
      lines: [{ item_id: rice, name: "Jeera Rice", qty: 1, unit_cents: 400, note: null }],
      totalCents: 400,
      raw: {},
    });
    const out = h.texts(await h.say(OWNER, "/orders"));
    expect(out).toContain("Priya Sharma");
    expect(out).toContain("Form Fan");
    expect(out).toContain("Total: $20.00");
    expect(h.texts(await h.say(OWNER, "/what"))).toContain("Dal Makhani");
    expect(h.texts(await h.say(OWNER, "/message"))).toContain("https://preppr.test/order");

    const kitchen = await (await get(h, "/admin/kitchen", await login(h))).text();
    expect(kitchen).toContain("order page");
    expect(kitchen).toContain("WhatsForm");
    expect(kitchen).not.toContain("Connect WhatsForm");
    expect(kitchen).toContain("https://preppr.test/order");
  });

  it("menu edits after orders keep ids; ordered dishes can't be dropped or repriced", async () => {
    const { h, menu, dal, roti } = await setup();
    await firstOrder(h, dal, roti);
    const now = h.clock.now;
    const built = (items: typeof menu.items) => ({ date: menu.date, cutoffAt: menu.cutoffAt, items, cutoffWasDefault: false });
    const extra = { id: "x", name: "Kheer", price_cents: 300, aliases: [] };
    const fresh = menu.items.map((i, n) => ({ ...i, id: `i${n + 2}` })); // ids shifted, as a rebuilt menu would have

    const added = await upsertMenu(h.db, built([extra, ...fresh]), "active", now);
    expect("menu" in added).toBe(true);
    const [m] = await h.db.select().from(menus).where(eq(menus.id, menu.id));
    expect(m!.items.find((i) => i.name === "Dal Makhani")!.id).toBe(dal);
    expect(m!.items.find((i) => i.name === "Kheer")!.id).not.toBe(dal);

    const dropped = await upsertMenu(h.db, built(fresh.filter((i) => i.name !== "Roti")), "active", now);
    expect(dropped).toMatchObject({ blockedBy: 1, dishes: ["Roti"] });
    const repriced = await upsertMenu(h.db, built(fresh.map((i) => (i.name === "Dal Makhani" ? { ...i, price_cents: 900 } : i))), "active", now);
    expect(repriced).toMatchObject({ dishes: ["Dal Makhani"] });
    expect(await upsertMenu(h.db, built(fresh), "draft", now)).toMatchObject({ blockedBy: 1, dishes: [] });
    const [still] = await h.db.select().from(orders).where(and(eq(orders.menuId, menu.id)));
    expect(still!.lines.map((l) => l.item_id)).toEqual([dal, roti]);
  });
});
