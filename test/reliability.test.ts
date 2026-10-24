import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { inbox, messages, outbox } from "../src/db/schema";
import { RATE_LIMIT } from "../src/flows/router";
import { claimInbox, LEASE_MS } from "../src/jobs/queue";
import { WaSendError } from "../src/wa/client";
import { harness, OWNER } from "./helpers";

// Lets a test make customer handling throw, as a DB blip would.
const boom = vi.hoisted(() => ({ on: false }));
vi.mock("../src/flows/customer", async (orig) => {
  const m = await orig<typeof import("../src/flows/customer")>();
  return {
    ...m,
    handleCustomer: async (...a: Parameters<typeof m.handleCustomer>) => {
      if (boom.on) throw new Error("db blip");
      return m.handleCustomer(...a);
    },
  };
});

const ALICE = "+12015550001";
const MIN = 60 * 1000;

describe("durable inbox", () => {
  it("saves the message before returning 200, and handles it only when the worker runs", async () => {
    const h = await harness();
    await h.publishMenu();
    const res = await h.post(h.payload(ALICE, "Order"));
    expect(res.status).toBe(200);
    const [row] = await h.db.select().from(inbox).where(eq(inbox.phone, ALICE));
    expect(row).toMatchObject({ status: "pending", attempts: 0 });
    const before = h.wa.sent.length;
    await h.drain();
    expect(h.wa.sent.length).toBeGreaterThan(before);
    expect((await h.db.select().from(inbox).where(eq(inbox.phone, ALICE)))[0]!.status).toBe("done");
  });

  it("returns 500 when the message can't be saved, so Meta redelivers", async () => {
    const h = await harness();
    const realInsert = h.db.insert.bind(h.db);
    (h.db as any).insert = () => {
      throw new Error("db down");
    };
    const res = await h.post(h.payload(ALICE, "Order"));
    (h.db as any).insert = realInsert;
    expect(res.status).toBe(500);
  });

  it("handles a duplicate delivery once", async () => {
    const h = await harness();
    await h.publishMenu();
    const first = await h.say(ALICE, "Order", "wamid.dup");
    const again = await h.say(ALICE, "Order", "wamid.dup");
    expect(first.length).toBeGreaterThan(0);
    expect(again).toHaveLength(0);
    expect(await h.db.select().from(inbox).where(eq(inbox.waMessageId, "wamid.dup"))).toHaveLength(1);
  });

  it("handles one phone's messages in arrival order, one at a time", async () => {
    const h = await harness();
    await h.publishMenu();
    await h.onboard(ALICE, "Alice");
    // Two quick messages before the worker runs at all.
    await h.post(h.payload(ALICE, "2 dal"));
    await h.post(h.payload(ALICE, "1 dal, 3 roti"));
    const claimed = await claimInbox(h.db, h.clock.now, 5);
    expect(claimed.map((r) => r.payload.text?.body)).toEqual(["2 dal"]); // second waits its turn
    expect(await claimInbox(h.db, h.clock.now, 5)).toHaveLength(0);
    await h.db.update(inbox).set({ status: "pending", attempts: 0 }).where(eq(inbox.id, claimed[0]!.id));
    const before = h.wa.sent.length;
    await h.drain();
    const out = h.texts(h.wa.sent.slice(before));
    expect(out.indexOf("2 × Dal")).toBeLessThan(out.lastIndexOf("3 × Roti"));
    expect(out.lastIndexOf("Total: $9.00")).toBeGreaterThan(out.indexOf("Total: $12.00"));
  });

  it("retries a failed handler, then succeeds", async () => {
    const h = await harness();
    await h.publishMenu();
    await h.onboard(ALICE, "Alice");
    boom.on = true;
    await h.post(h.payload(ALICE, "2 dal", "wamid.flaky"));
    await h.drain();
    const row = async () => (await h.db.select().from(inbox).where(eq(inbox.waMessageId, "wamid.flaky")))[0]!;
    expect(await row()).toMatchObject({ status: "pending", attempts: 1, lastError: "db blip" });
    h.advance(5_000);
    await h.drain();
    expect(await row()).toMatchObject({ status: "pending", attempts: 2 });
    boom.on = false;
    h.advance(30_000);
    const before = h.wa.sent.length;
    await h.drain();
    expect(await row()).toMatchObject({ status: "done", attempts: 3 });
    expect(h.texts(h.wa.sent.slice(before))).toContain("Total: $12.00");
  });

  it("dead-letters after the last attempt and tells the customer", async () => {
    const h = await harness();
    await h.publishMenu();
    await h.onboard(ALICE, "Alice");
    boom.on = true;
    await h.post(h.payload(ALICE, "2 dal", "wamid.dead"));
    for (const wait of [0, 5_000, 30_000]) {
      h.advance(wait);
      await h.drain();
    }
    boom.on = false;
    const [r] = await h.db.select().from(inbox).where(eq(inbox.waMessageId, "wamid.dead"));
    expect(r).toMatchObject({ status: "failed", attempts: 3 });
    expect(h.wa.sent.at(-1)).toMatchObject({ to: ALICE, body: expect.stringContaining("something went wrong") });
  });

  it("keeps simple orders working when the model is down, and hands the rest to the owner", async () => {
    const h = await harness();
    await h.publishMenu();
    await h.onboard(ALICE, "Alice");
    h.llm.interpret = async () => {
      throw new Error("Claude API 529 overloaded");
    };
    expect(h.texts(await h.say(ALICE, "2 dal, 3 roti"))).toContain("Total: $15.00"); // rules, no model

    await h.post(h.payload(ALICE, "add 1 paneer please", "wamid.needs-model"));
    for (const wait of [0, 5_000, 30_000]) {
      h.advance(wait);
      await h.drain();
    }
    const [r] = await h.db.select().from(inbox).where(eq(inbox.waMessageId, "wamid.needs-model"));
    expect(r).toMatchObject({ status: "failed", attempts: 3 });
    const last = h.wa.sent.slice(-2);
    expect(last.find((m) => m.to === OWNER)!.body).toMatch(/parser down[\s\S]*add 1 paneer please/);
    expect(last.find((m) => m.to === ALICE)!.body).toContain("passed yours to the kitchen");
  });

  it("reclaims a row whose worker died mid-handling (expired lease)", async () => {
    const h = await harness();
    await h.publishMenu();
    await h.post(h.payload(ALICE, "Order", "wamid.crash"));
    // Simulate a crash: row claimed, never finished.
    await h.db
      .update(inbox)
      .set({ status: "processing", attempts: 1, lockedUntil: new Date(h.clock.now.getTime() + LEASE_MS) })
      .where(eq(inbox.waMessageId, "wamid.crash"));
    expect(await h.worker.tick()).toBe(0);
    h.advance(LEASE_MS);
    const before = h.wa.sent.length;
    await h.drain();
    expect(h.wa.sent.length).toBeGreaterThan(before);
  });

  it("rate-limits a phone that floods the bot", async () => {
    const h = await harness();
    await h.publishMenu();
    await h.onboard(ALICE, "Alice"); // 4 messages
    for (let i = 0; i < RATE_LIMIT.max - 4; i++) await h.say(ALICE, "hi");
    expect(await h.say(ALICE, "hi")).toHaveLength(0);
    const [m] = await h.db.select().from(messages).where(eq(messages.intent, "rate_limited"));
    expect(m?.phone).toBe(ALICE);
    h.advance(RATE_LIMIT.windowMs + MIN);
    expect((await h.say(ALICE, "hi")).length).toBeGreaterThan(0);
  });

  it("never rate-limits the owner", async () => {
    const h = await harness();
    for (let i = 0; i < RATE_LIMIT.max + 2; i++) await h.say(OWNER, "HELP");
    expect((await h.say(OWNER, "HELP")).length).toBe(1);
  });
});

describe("outbox", () => {
  it("retries a transient send failure with backoff", async () => {
    const h = await harness();
    await h.publishMenu();
    h.wa.failNext(2);
    await h.post(h.payload(ALICE, "Order"));
    await h.drain();
    const row = async () => (await h.db.select().from(outbox).where(eq(outbox.to, ALICE)))[0]!;
    expect(await row()).toMatchObject({ status: "pending", attempts: 1 });
    h.advance(2_000);
    await h.drain();
    expect(await row()).toMatchObject({ status: "pending", attempts: 2 });
    h.advance(5_000);
    await h.drain();
    expect(await row()).toMatchObject({ status: "done", attempts: 3 });
    expect((await row()).waMessageId).toMatch(/^dry-/);
    const out = await h.db.select().from(messages).where(eq(messages.direction, "out"));
    expect(out.some((m) => m.phone === ALICE)).toBe(true);
  });

  it("dead-letters a permanent send error at once and doesn't block later messages", async () => {
    const h = await harness();
    await h.publishMenu();
    h.wa.failNext(1, new WaSendError("Graph API 400", 400, 131026, false));
    const out = await h.say(ALICE, "Order"); // onboarding asks for name
    const rows = await h.db.select().from(outbox).where(eq(outbox.to, ALICE));
    expect(rows[0]).toMatchObject({ status: "failed", attempts: 1 });
    expect(out).toHaveLength(rows.length - 1);
    expect(await h.say(ALICE, "Alice")).not.toHaveLength(0);
  });

  it("a retried handler doesn't queue the same reply twice", async () => {
    const h = await harness();
    await h.publishMenu();
    await h.post(h.payload(ALICE, "Order", "wamid.twice"));
    await h.drain();
    const n = (await h.db.select().from(outbox).where(eq(outbox.to, ALICE))).length;
    // Force the same inbound row to run again, as after a crash.
    await h.db.update(inbox).set({ status: "pending" }).where(eq(inbox.waMessageId, "wamid.twice"));
    await h.drain();
    expect(await h.db.select().from(outbox).where(eq(outbox.to, ALICE))).toHaveLength(n);
  });

  it("keeps one recipient's replies in order while an earlier one is retrying", async () => {
    const h = await harness();
    await h.publishMenu();
    h.wa.failNext(1);
    await h.post(h.payload(ALICE, "Order"));
    await h.drain();
    await h.post(h.payload(ALICE, "Alice"));
    await h.drain();
    expect(h.wa.sent.filter((m) => m.to === ALICE)).toHaveLength(0);
    h.advance(2_000);
    const before = h.wa.sent.length;
    await h.drain();
    const bodies = h.wa.sent.slice(before).map((m) => m.body);
    expect(bodies[0]).toMatch(/name/i);
    expect(bodies.length).toBeGreaterThan(1);
  });
});
