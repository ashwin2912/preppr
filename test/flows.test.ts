import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { customers, menus, messages, orders } from "../src/db/schema";
import { runCutoff } from "../src/jobs/cutoff";
import { send } from "../src/wa/send";
import { BOT, harness, OWNER } from "./helpers";

const ALICE = "+12015550001";
const BOB = "+12015550002";
const CHARU = "+12015550003";
const HOUR = 60 * 60 * 1000;

describe("webhook endpoint", () => {
  it("verifies the subscription challenge", async () => {
    const h = await harness();
    const ok = await h.app.request("/webhook?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=42");
    expect(await ok.text()).toBe("42");
    const bad = await h.app.request("/webhook?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=42");
    expect(bad.status).toBe(403);
  });

  it("rejects a bad signature and processes nothing", async () => {
    const h = await harness();
    const res = await h.post(h.payload(ALICE, "hi"), "sha256=deadbeef");
    expect(res.status).toBe(401);
    await h.drain();
    expect(await h.db.select().from(messages)).toHaveLength(0);
  });

  it("protects the cutoff job with the job secret", async () => {
    const h = await harness();
    expect((await h.app.request("/jobs/cutoff", { method: "POST" })).status).toBe(403);
    const ok = await h.app.request("/jobs/cutoff", { method: "POST", headers: { "x-job-secret": "job-secret" } });
    expect(ok.status).toBe(200);
  });
});

describe("owner menu flow", () => {
  it("previews, publishes and returns a forwardable broadcast with the wa.me link", async () => {
    const h = await harness();
    const preview = await h.say(OWNER, "MENU Mon: Dal makhani 6, Jeera rice 4, Roti 1, Paneer bhurji 7. Cutoff 10:30");
    expect(h.texts(preview)).toContain("Dal Makhani — $6.00");
    expect(h.buttonsOf(preview).map((b) => b.title)).toEqual(["Publish", "Edit"]);
    expect((await h.db.select().from(menus))[0]!.status).toBe("draft");

    const pub = await h.say(OWNER, { replyId: h.buttonsOf(preview)[0]!.id });
    const broadcast = pub.at(-1)!.body;
    expect(broadcast).toContain(`https://wa.me/${BOT.slice(1)}?text=Order`);
    expect(broadcast).toContain("Order by 10:30 AM");
    expect((await h.db.select().from(menus))[0]!.status).toBe("active");
  });

  it("answers HELP for unknown commands", async () => {
    const h = await harness();
    expect(h.texts(await h.say(OWNER, "blah"))).toContain("Owner commands");
  });
});

describe("customer ordering", () => {
  it("onboards a new customer, takes an order, computes the total in code, and confirms", async () => {
    const h = await harness();
    await h.publishMenu();

    expect(h.texts(await h.say(ALICE, "Order"))).toContain("What name");
    const area = await h.say(ALICE, "Alice");
    expect(h.buttonsOf(area).map((b) => b.title)).toEqual(["Journal Square", "Newport", "Heights"]);
    expect(h.texts(await h.say(ALICE, { replyId: "area:1" }))).toContain("delivery note");
    const done = await h.say(ALICE, "Apt 4B, ring twice");
    expect(h.texts(done)).toContain("You're all set");
    expect(h.texts(done)).toContain("Dal Makhani — $6.00");

    const summary = await h.say(ALICE, "2 dal (no onion), 3 roti");
    expect(h.texts(summary)).toContain("Total: $15.00");
    expect(h.texts(summary)).toContain("no onion");
    expect(h.texts(summary)).toContain("Pay by Zelle");
    const [confirm, change] = h.buttonsOf(summary);
    expect(change!.title).toBe("Change ✏️");

    expect(h.texts(await h.say(ALICE, { replyId: confirm!.id }))).toContain("You're in! ✅ Delivery to Newport today");
    const [o] = await h.db.select().from(orders);
    expect(o).toMatchObject({ status: "confirmed", totalCents: 1500 });
    const [c] = await h.db.select().from(customers).where(eq(customers.phone, ALICE));
    expect(c).toMatchObject({ name: "Alice", area: "Newport", addressNote: "Apt 4B, ring twice" });
  });

  it("does not create duplicates when Meta redelivers the same message", async () => {
    const h = await harness();
    await h.publishMenu();
    await h.onboard(ALICE, "Alice");
    const first = await h.say(ALICE, "2 dal (no onion)", "wamid.dup");
    const second = await h.say(ALICE, "2 dal (no onion)", "wamid.dup");
    expect(first.length).toBeGreaterThan(0);
    expect(second).toHaveLength(0);
    expect(await h.db.select().from(orders)).toHaveLength(1);
    expect(h.llm.calls.filter((c) => c.message === "2 dal (no onion)")).toHaveLength(1);
  });

  it("edits re-require confirmation and old confirm buttons are rejected", async () => {
    const h = await harness();
    await h.publishMenu();
    await h.onboard(ALICE, "Alice");
    const s1 = await h.say(ALICE, "2 dal");
    const oldConfirm = h.buttonsOf(s1)[0]!.id;
    await h.say(ALICE, { replyId: oldConfirm });
    h.advance(1000);
    const s2 = await h.say(ALICE, "2 dal, 4 roti");
    expect(h.texts(s2)).toContain("Updated your order");
    expect(h.texts(s2)).toContain("Total: $16.00");
    expect((await h.db.select().from(orders))[0]!.status).toBe("draft");
    expect(h.texts(await h.say(ALICE, { replyId: oldConfirm }))).toContain("out of date");
    await h.say(ALICE, { replyId: h.buttonsOf(s2)[0]!.id });
    expect((await h.db.select().from(orders))[0]).toMatchObject({ status: "confirmed", totalCents: 1600 });
  });

  it("cancels an order", async () => {
    const h = await harness();
    await h.publishMenu();
    await h.onboard(ALICE, "Alice");
    await h.say(ALICE, "2 dal");
    expect(h.texts(await h.say(ALICE, "cancel please"))).toContain("cancelled");
    expect((await h.db.select().from(orders))[0]!.status).toBe("cancelled");
  });

  it("asks one clarifying question, then hands off and flags", async () => {
    const h = await harness();
    await h.publishMenu();
    await h.onboard(ALICE, "Alice");
    const q = await h.say(ALICE, "2 dal, 1 biryani");
    expect(h.texts(q)).toContain("We don't have 1 biryani");
    expect(await h.db.select().from(orders)).toHaveLength(0);
    const out = await h.say(ALICE, "1 pizza");
    expect(out.some((o) => o.to === OWNER && o.body.includes("couldn't understand"))).toBe(true);
    const [c] = await h.db.select().from(customers).where(eq(customers.phone, ALICE));
    expect(c!.humanTakeoverUntil).not.toBeNull();
  });

  it("repeats 'same as yesterday' from the last confirmed order", async () => {
    const h = await harness();
    await h.publishMenu();
    await h.onboard(ALICE, "Alice");
    const s = await h.say(ALICE, "2 dal, 3 roti");
    await h.say(ALICE, { replyId: h.buttonsOf(s)[0]!.id });

    h.advance(24 * HOUR); // next day; Alice messages again so her window is fresh
    await h.publishMenu();
    const again = await h.say(ALICE, "same as yesterday");
    expect(h.texts(again)).toContain("2 × Dal Makhani");
    expect(h.texts(again)).toContain("Total: $15.00");
  });

  it("answers cutoff questions from data", async () => {
    const h = await harness();
    await h.publishMenu();
    await h.onboard(ALICE, "Alice");
    expect(h.texts(await h.say(ALICE, "what is the cutoff?"))).toContain("Orders close at 10:30 AM today");
  });

  it("asks for typing on voice notes and forwards to the owner", async () => {
    const h = await harness();
    await h.publishMenu();
    await h.onboard(ALICE, "Alice");
    const out = await h.say(ALICE, { type: "audio" });
    expect(out.find((o) => o.to === ALICE)!.body).toContain("Please type your order");
    expect(out.find((o) => o.to === OWNER)!.body).toContain("voice note");
  });

  it("skips onboarding for imported customers", async () => {
    const h = await harness();
    await h.db.insert(customers).values({ phone: BOB, name: "Bob", area: "Heights", addressNote: "Blue door" });
    await h.publishMenu();
    const out = await h.say(BOB, "Order");
    expect(h.texts(out)).not.toContain("What name");
    expect(h.texts(out)).toContain("Dal Makhani");
  });

  it("asks imported customers only for the missing area", async () => {
    const h = await harness();
    await h.db.insert(customers).values({ phone: BOB, name: "Bob" });
    await h.publishMenu();
    const out = await h.say(BOB, "Order");
    expect(h.buttonsOf(out).map((b) => b.title)).toContain("Heights");
    const done = await h.say(BOB, "heights");
    expect(h.texts(done)).toContain("You're all set");
    expect((await h.db.select().from(customers))[0]!.area).toBe("Heights");
  });
});

describe("handoff", () => {
  it("notifies the owner, pauses the bot, and RESUME turns it back on", async () => {
    const h = await harness();
    await h.publishMenu();
    await h.onboard(ALICE, "Alice");
    const out = await h.say(ALICE, "I want to talk to aunty");
    const note = out.find((o) => o.to === OWNER)!.body;
    expect(note).toContain("Alice");
    expect(note).toContain("https://wa.me/12015550001");
    expect(note).toContain("RESUME +12015550001");

    expect(await h.say(ALICE, "hello??")).toHaveLength(0);

    expect(h.texts(await h.say(OWNER, "RESUME 201-555-0001"))).toContain("back on for Alice");
    expect(h.texts(await h.say(ALICE, "2 dal"))).toContain("Total: $12.00");
  });

  it("takeover expires after 4 hours", async () => {
    const h = await harness();
    await h.publishMenu();
    await h.onboard(ALICE, "Alice");
    await h.say(ALICE, "owner please");
    h.advance(4 * HOUR + 1000);
    expect(await h.say(ALICE, "hi")).not.toHaveLength(0);
  });
});

describe("cutoff", () => {
  async function dayWithOrders() {
    const h = await harness();
    await h.publishMenu();
    await h.onboard(ALICE, "Alice", 0);
    await h.onboard(BOB, "Bob", 1);
    await h.onboard(CHARU, "Charu", 0);
    for (const [p, text] of [
      [ALICE, "2 dal (less spicy), 3 roti"],
      [BOB, "1 paneer, 2 roti"],
    ] as const) {
      const s = await h.say(p, text);
      await h.say(p, { replyId: h.buttonsOf(s)[0]!.id });
    }
    await h.say(CHARU, "1 rice"); // never confirmed
    return h;
  }

  it("replies closed after cutoff and forwards late orders to the owner", async () => {
    const h = await dayWithOrders();
    h.advance(3 * HOUR); // 11:00 AM ET
    const out = await h.say(ALICE, "1 dal");
    expect(out.find((o) => o.to === ALICE)!.body).toContain("Orders for today closed at 10:30 AM");
    expect(out.find((o) => o.to === OWNER)!.body).toContain("Late order attempt");
  });

  it("closes the menu and sends the owner a grouped summary exactly once", async () => {
    const h = await dayWithOrders();
    h.advance(3 * HOUR);
    const before = h.wa.sent.length;
    const r1 = await runCutoff({ db: h.db, wa: h.wa, llm: h.llm, cfg: h.cfg, now: () => h.clock.now });
    expect(r1).toMatchObject({ closed: 1, summaries: [{ sent: true }] });
    await h.drain();
    const summary = h.texts(h.wa.sent.slice(before));
    expect(summary).toContain("2 × Dal Makhani");
    expect(summary).toContain("5 × Roti");
    expect(summary).toContain("1 × Paneer Bhurji");
    expect(summary).toMatch(/\*Journal Square\* \(1 order, \$15\.00\)[\s\S]*Alice[\s\S]*less spicy[\s\S]*Apt 4B/);
    expect(summary).toMatch(/\*Newport\* \(1 order, \$9\.00\)[\s\S]*Bob/);
    expect(summary).toContain("Total: 2 orders · $24.00");
    expect(summary).toMatch(/Not confirmed \(1\)[\s\S]*Charu/);

    const n = h.wa.sent.length;
    const r2 = await runCutoff({ db: h.db, wa: h.wa, llm: h.llm, cfg: h.cfg, now: () => h.clock.now });
    expect(r2).toMatchObject({ closed: 0, summaries: [] });
    await h.drain();
    expect(h.wa.sent.length).toBe(n);
  });

  it("CLOSE and OPEN work from the owner number", async () => {
    const h = await dayWithOrders();
    expect(h.texts(await h.say(OWNER, "CLOSE"))).toContain("Kitchen totals");
    expect(h.texts(await h.say(ALICE, "1 dal"))).toContain("closed");
    expect(h.texts(await h.say(OWNER, "OPEN 11:30"))).toContain("until 11:30 AM");
    expect(h.texts(await h.say(ALICE, "1 dal"))).toContain("Total: $6.00");
  });
});

describe("24-hour window guard", () => {
  it("blocks sends to a customer whose last message is older than 24h", async () => {
    const h = await harness();
    await h.publishMenu();
    await h.onboard(ALICE, "Alice");
    const ctx = { db: h.db, wa: h.wa, llm: h.llm, cfg: h.cfg, now: () => h.clock.now };
    expect(await send(ctx, { kind: "text", to: ALICE, body: "hi" })).toBe(true);
    await h.drain();
    expect(h.wa.sent.at(-1)).toMatchObject({ to: ALICE, body: "hi" });
    h.advance(24 * HOUR + 1000);
    const n = h.wa.sent.length;
    expect(await send(ctx, { kind: "text", to: ALICE, body: "hi" })).toBe(false);
    expect(await send(ctx, { kind: "text", to: CHARU, body: "never messaged us" })).toBe(false);
    await h.drain();
    expect(h.wa.sent.length).toBe(n);
  });

  it("holds the cutoff summary when the owner's window is closed, then delivers it later", async () => {
    const h = await harness();
    await h.publishMenu();
    await h.onboard(ALICE, "Alice");
    h.advance(25 * HOUR); // owner last messaged >24h ago; menu cutoff long passed
    const deps = { db: h.db, wa: h.wa, llm: h.llm, cfg: h.cfg, now: () => h.clock.now };
    const r = await runCutoff(deps);
    expect(r.summaries).toEqual([{ menuId: 1, sent: false }]);
    expect((await h.db.select().from(menus))[0]!.summarySentAt).toBeNull();
    await h.say(OWNER, "ORDERS"); // owner reopens their window
    const r2 = await runCutoff(deps);
    expect(r2.summaries).toEqual([{ menuId: 1, sent: true }]);
  });
});
