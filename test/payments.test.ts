import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { customers, messages, payments } from "../src/db/schema";
import { balance, parseAmount, parseMethod } from "../src/domain/ledger";
import { harness, OWNER } from "./helpers";

const ALICE = "+12015550001";
const BOB = "+12015550002";
const HOUR = 60 * 60 * 1000;

/** Alice with one confirmed $12 order (2 dal). */
async function aliceOwes12() {
  const h = await harness();
  await h.publishMenu();
  await h.onboard(ALICE, "Alice");
  const s = await h.say(ALICE, "2 dal");
  const confirm = h.buttonsOf(s).find((b) => b.id.startsWith("confirm:"))!;
  const out = await h.say(ALICE, { replyId: confirm.id });
  return { h, confirmText: h.texts(out) };
}

const payButtons = (h: Awaited<ReturnType<typeof harness>>, out: Parameters<typeof h.buttonsOf>[0]) =>
  h.buttonsOf(out).filter((b) => b.id.startsWith("pay_"));

describe("ledger helpers", () => {
  it("parses amounts and methods", () => {
    expect(parseAmount("$20")).toBe(2000);
    expect(parseAmount("20.5")).toBe(2050);
    expect(parseAmount("1,200")).toBe(120000);
    expect(parseAmount("0")).toBeNull();
    expect(parseAmount("abc")).toBeNull();
    expect(parseMethod("Zelle")).toBe("zelle");
    expect(parseMethod("paypal")).toBeNull();
  });
});

describe("customer-reported payments", () => {
  it("shows the balance due on order confirmation", async () => {
    const { confirmText } = await aliceOwes12();
    expect(confirmText).toContain("Balance due: $12.00");
  });

  it("records a reported payment as pending, owner verifies, balance updates", async () => {
    const { h } = await aliceOwes12();
    const out = await h.say(ALICE, "paid $12 on zelle");
    expect(out.find((o) => o.to === ALICE)!.body).toContain("Noted $12.00 via Zelle");
    const toOwner = out.find((o) => o.to === OWNER)!;
    expect(toOwner.body).toMatch(/Payment to verify[\s\S]*Alice[\s\S]*\$12\.00 via Zelle/);
    const [p] = await h.db.select().from(payments);
    expect(p).toMatchObject({ status: "pending", source: "customer", amountCents: 1200, method: "zelle" });
    expect(await balance(h.db, ALICE)).toEqual({ owedCents: 1200, pendingCents: 1200 });

    const verify = payButtons(h, out).find((b) => b.id.startsWith("pay_ok:"))!;
    const v = await h.say(OWNER, { replyId: verify.id });
    expect(v.find((o) => o.to === OWNER)!.body).toContain("Verified #1");
    expect(v.find((o) => o.to === ALICE)!.body).toMatch(/received ✅[\s\S]*All paid up/);
    expect(await balance(h.db, ALICE)).toEqual({ owedCents: 0, pendingCents: 0 });
    expect((await h.db.select().from(payments))[0]).toMatchObject({ status: "verified", verifiedBy: OWNER });

    // Tapping again does nothing harmful.
    expect(h.texts(await h.say(OWNER, { replyId: verify.id }))).toContain("already verified");
  });

  it("owner rejects a reported payment", async () => {
    const { h } = await aliceOwes12();
    const out = await h.say(ALICE, "sent 12 venmo");
    const reject = payButtons(h, out).find((b) => b.id.startsWith("pay_no:"))!;
    const r = await h.say(OWNER, { replyId: reject.id });
    expect(r.find((o) => o.to === ALICE)!.body).toContain("couldn't match your $12.00 payment");
    expect(await balance(h.db, ALICE)).toEqual({ owedCents: 1200, pendingCents: 0 });
  });

  it("asks for the amount when it's missing, then records the follow-up", async () => {
    const { h } = await aliceOwes12();
    expect(h.texts(await h.say(ALICE, "payment done"))).toContain("How much did you send");
    const out = await h.say(ALICE, "$12 zelle");
    expect(out.find((o) => o.to === ALICE)!.body).toContain("Noted $12.00");
    expect(await h.db.select().from(payments)).toHaveLength(1);
  });

  it("drops the payment question if the customer moves on to ordering", async () => {
    const h = await harness();
    await h.publishMenu();
    await h.onboard(ALICE, "Alice");
    await h.say(ALICE, "payment done");
    expect(h.texts(await h.say(ALICE, "1 dal"))).toContain("Total: $6.00");
    expect(await h.db.select().from(payments)).toHaveLength(0);
  });

  it("accepts a payment report after cutoff", async () => {
    const { h } = await aliceOwes12();
    h.advance(5 * HOUR); // well past 10:30 cutoff
    const out = await h.say(ALICE, "paid 12 zelle");
    expect(out.find((o) => o.to === ALICE)!.body).toContain("Noted $12.00");
    expect(out.some((o) => o.to === OWNER && o.body.includes("Payment to verify"))).toBe(true);
  });

  it("tells a customer their balance", async () => {
    const { h } = await aliceOwes12();
    expect(h.texts(await h.say(ALICE, "how much do i owe"))).toContain("Balance due: $12.00");
  });
});

describe("owner payment commands", () => {
  it("PAID records a verified cash payment and tells the customer", async () => {
    const { h } = await aliceOwes12();
    const out = await h.say(OWNER, `PAID ${ALICE} 20`);
    expect(out.find((o) => o.to === OWNER)!.body).toMatch(/Recorded \$20\.00 cash from Alice[\s\S]*Credit: \$8\.00/);
    expect(out.find((o) => o.to === ALICE)!.body).toContain("Credit: $8.00");
    expect((await h.db.select().from(payments))[0]).toMatchObject({ status: "verified", source: "owner", method: "cash" });
    expect(h.texts(await h.say(OWNER, "PAID nonsense"))).toContain("Use PAID");
  });

  it("PENDING, VERIFY by number, BALANCE and DUES", async () => {
    const { h } = await aliceOwes12();
    await h.onboard(BOB, "Bob", 1);
    await h.say(ALICE, "paid 5 zelle");
    expect(h.texts(await h.say(OWNER, "PENDING"))).toMatch(/#1 Alice — \$5\.00 via Zelle/);
    expect(h.texts(await h.say(OWNER, "DUES"))).toMatch(/1 customers, \$12\.00[\s\S]*Alice[\s\S]*\$5\.00 to verify/);
    await h.say(OWNER, "VERIFY 1");
    expect(h.texts(await h.say(OWNER, `BALANCE ${ALICE}`))).toMatch(/Balance due: \$7\.00[\s\S]*#1 .* verified/);
    expect(h.texts(await h.say(OWNER, "PENDING"))).toContain("No payments waiting");
    expect(h.texts(await h.say(OWNER, "REJECT 1"))).toContain("already verified");
  });

  it("BLOCK makes the bot ignore a customer; UNBLOCK restores it", async () => {
    const h = await harness();
    await h.publishMenu();
    await h.onboard(ALICE, "Alice");
    expect(h.texts(await h.say(OWNER, `BLOCK ${ALICE}`))).toContain("Blocked Alice");
    expect(await h.say(ALICE, "2 dal")).toHaveLength(0);
    const [m] = await h.db.select().from(messages).where(eq(messages.intent, "blocked"));
    expect(m?.phone).toBe(ALICE);
    await h.say(OWNER, `UNBLOCK ${ALICE}`);
    expect((await h.db.select().from(customers).where(eq(customers.phone, ALICE)))[0]!.status).toBe("active");
    expect(h.texts(await h.say(ALICE, "2 dal"))).toContain("Total: $12.00");
  });
});
