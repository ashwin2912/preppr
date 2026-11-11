import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { customers, messages, orders, outbox } from "../src/db/schema";
import { runCutoff } from "../src/jobs/cutoff";
import { harness, OWNER } from "./helpers";

const ALICE = "+12015550001";
const HOUR = 60 * 60 * 1000;

const depsOf = (h: Awaited<ReturnType<typeof harness>>) => ({ db: h.db, wa: h.wa, llm: h.llm, cfg: h.cfg, now: () => h.clock.now });

async function setup(env: Record<string, string>) {
  const h = await harness({ env });
  await h.db.insert(customers).values({ phone: ALICE, name: "Alice", area: "Heights" });
  await h.publishMenu();
  return h;
}

describe("BOT_MODE=shadow", () => {
  it("records orders, sends customers nothing, leaves chats unread, and tells the owner at cutoff", async () => {
    const h = await setup({ BOT_MODE: "shadow" });
    const read = h.wa.read.length;
    expect(await h.say(ALICE, "2 dal")).toEqual([]);
    expect(h.wa.read.length).toBe(read);
    const [o] = await h.db.select().from(orders);
    expect(o).toMatchObject({ status: "draft", customerPhone: ALICE, totalCents: 1200 });
    const held = await h.db.select().from(outbox).where(eq(outbox.status, "suppressed"));
    expect(held.map((r) => r.to)).toEqual([ALICE]);

    h.advance(3 * HOUR); // past 10:30 cutoff
    await h.say(OWNER, "HELP"); // owner window open
    const before = h.wa.sent.length;
    await runCutoff(depsOf(h));
    await h.drain();
    const summary = h.texts(h.wa.sent.slice(before));
    expect(summary).toContain("SHADOW");
    expect(summary).toContain("Not confirmed (1)");
  });

  it("owner commands still work", async () => {
    const h = await setup({ BOT_MODE: "shadow" });
    expect(h.texts(await h.say(OWNER, "ORDERS"))).toContain("No orders yet");
  });
});

describe("BOT_MODE=assist", () => {
  it("sends a confident order summary and the confirm flow after it", async () => {
    const h = await setup({ BOT_MODE: "assist" });
    const out = await h.say(ALICE, "2 dal"); // rules parser: confidence 1
    expect(h.texts(out)).toContain("Total: $12.00");
    const confirm = h.buttonsOf(out).find((b) => b.id.startsWith("confirm:"))!;
    expect(h.texts(await h.say(ALICE, { replyId: confirm.id }))).toContain("You're in!");
    expect((await h.db.select().from(orders))[0]!.status).toBe("confirmed");
  });

  it("holds anything else for the owner: no customer reply, order flagged, one ping, REVIEW lists it", async () => {
    const h = await setup({ BOT_MODE: "assist", ASSIST_MIN_CONFIDENCE: "0.99" });
    const out = await h.say(ALICE, "2 dal (less spicy), 3 roti");
    const [m] = await h.db.select().from(messages).where(eq(messages.phone, ALICE));
    expect(m!.parser).toBe("model"); // fake model: confidence 0.95
    expect(out.filter((o) => o.to === ALICE)).toEqual([]);
    expect(out.find((o) => o.to === OWNER)!.body).toContain("Needs a reply");
    expect((await h.db.select().from(orders))[0]).toMatchObject({ status: "draft", flagged: true });

    expect(await h.say(ALICE, "hello?")).toEqual([]); // second held reply today: no second ping
    const review = h.texts(await h.say(OWNER, "REVIEW"));
    expect(review).toContain("Flagged orders");
    expect(review).toContain("Replies held back today");
    expect(review).toContain("Alice");
  });

  it("does not ping for a handoff (the handoff already told the owner)", async () => {
    const h = await setup({ BOT_MODE: "assist" });
    const out = await h.say(ALICE, "I want to talk to aunty");
    expect(out.filter((o) => o.to === OWNER)).toHaveLength(1);
    expect(out.filter((o) => o.to === ALICE)).toEqual([]);
  });
});

describe("BOT OFF / BOT ON", () => {
  it("stops every customer reply until turned back on; per-customer echo pause stays separate", async () => {
    const h = await setup({});
    expect(h.texts(await h.say(OWNER, "BOT OFF"))).toContain("Bot is OFF");
    expect(await h.say(ALICE, "2 dal")).toEqual([]);
    expect(await (await h.app.request("/health")).json()).toMatchObject({ botOff: true, mode: "shadow" });

    expect(h.texts(await h.say(OWNER, "BOT ON"))).toContain("Bot is ON");
    expect(h.texts(await h.say(ALICE, "2 dal"))).toContain("Total: $12.00");
  });

  it("is listed in HELP", async () => {
    const h = await setup({});
    expect(h.texts(await h.say(OWNER, "HELP"))).toContain("BOT OFF / BOT ON");
  });
});
