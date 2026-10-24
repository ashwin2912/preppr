import { and, desc, eq } from "drizzle-orm";
import { customers, payments, type Customer, type Payment, type PaymentMethod } from "../db/schema";
import type { Ctx } from "../ctx";
import { allBalances, balance, methodLabel, parseAmount, parseMethod, type Balance } from "../domain/ledger";
import { money } from "../domain/order";
import { normalizePhone } from "../lib/phone";
import { formatDay, localDate } from "../lib/time";
import type { Interpretation } from "../llm/types";
import { send, sendLongText, sendText } from "../wa/send";
import type { Incoming } from "../wa/types";
import { handoff } from "./handoff";
import { type ConvState, clearState, setState } from "./state";

/** Sanity cap on a self-reported payment; anything above goes to the owner. */
const MAX_REPORTED_CENTS = 100_000;

export function balanceText(b: Balance): string {
  const main =
    b.owedCents > 0 ? `Balance due: ${money(b.owedCents)}` : b.owedCents < 0 ? `Credit: ${money(-b.owedCents)}` : "All paid up ✅";
  return b.pendingCents > 0 ? `${main} (${money(b.pendingCents)} waiting to be confirmed)` : main;
}

const who = (c: Pick<Customer, "name" | "area" | "phone">) => `${c.name ?? "Customer"} (${c.area ?? "no area"}) ${c.phone}`;
const describe = (p: Payment) => `${money(p.amountCents)} via ${methodLabel(p.method)}`;

// ---------- customer side ----------

/** Customer says they paid. Records it as pending and asks the owner to verify. */
export async function handlePaymentReport(ctx: Ctx, msg: Incoming, customer: Customer, it: Interpretation, st: ConvState) {
  const phone = customer.phone;
  const cents = it.payment_cents;
  if (!cents || cents <= 0) {
    if (st.state === "awaiting_payment_details") {
      return handoff(ctx, customer, msg, "Payment message the bot couldn't read");
    }
    const question = "Thanks! How much did you send, and on Zelle or Venmo? (e.g. *$20 Zelle*)";
    await sendText(ctx, phone, question);
    await setState(ctx, phone, "awaiting_payment_details", { previousMessage: msg.text, question });
    return;
  }
  if (cents > MAX_REPORTED_CENTS) return handoff(ctx, customer, msg, `Reported a large payment (${money(cents)})`);

  await clearState(ctx, phone);
  const method: PaymentMethod = it.payment_method ?? "other";
  const now = ctx.now();
  const [p] = await ctx.db
    .insert(payments)
    .values({
      customerPhone: phone,
      amountCents: cents,
      method,
      status: "pending",
      source: "customer",
      messageId: msg.id,
      note: msg.text.slice(0, 300),
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .returning();
  if (!p) return; // handler retry: already recorded and announced

  await sendText(
    ctx,
    phone,
    `Thanks! Noted ${money(cents)}${method === "other" ? "" : ` via ${methodLabel(method)}`}. The kitchen will confirm it shortly 🙏`,
  );
  const b = await balance(ctx.db, phone);
  for (const owner of ctx.cfg.ownerNumbers) {
    await send(ctx, {
      kind: "buttons",
      to: owner,
      body:
        `💵 *Payment to verify* #${p.id}\n${who(customer)}\n${describe(p)}\n` +
        `"${msg.text.slice(0, 200)}"\n\n` +
        `Owed before this: ${money(Math.max(b.owedCents, 0))}`,
      buttons: [
        { id: `pay_ok:${p.id}`, title: "Verify ✅" },
        { id: `pay_no:${p.id}`, title: "Reject ❌" },
      ],
    });
  }
}

export async function answerBalance(ctx: Ctx, customer: Customer) {
  await sendText(ctx, customer.phone, balanceText(await balance(ctx.db, customer.phone)));
}

// ---------- owner side ----------

/** Verify or reject a pending payment (buttons, VERIFY, REJECT). */
export async function settlePayment(ctx: Ctx, owner: string, id: number, ok: boolean) {
  if (!Number.isInteger(id) || id <= 0) return sendText(ctx, owner, `Use ${ok ? "VERIFY" : "REJECT"} <payment number>, e.g. ${ok ? "VERIFY" : "REJECT"} 12`);
  const now = ctx.now();
  const [p] = await ctx.db
    .update(payments)
    .set({ status: ok ? "verified" : "rejected", verifiedAt: now, verifiedBy: owner, updatedAt: now })
    .where(and(eq(payments.id, id), eq(payments.status, "pending")))
    .returning();
  if (!p) {
    const [cur] = await ctx.db.select().from(payments).where(eq(payments.id, id));
    return sendText(ctx, owner, cur ? `Payment #${id} is already ${cur.status}.` : `No payment #${id}.`);
  }
  const [c] = await ctx.db.select().from(customers).where(eq(customers.phone, p.customerPhone));
  const b = await balance(ctx.db, p.customerPhone);
  await sendText(ctx, owner, `${ok ? "✅ Verified" : "❌ Rejected"} #${p.id}: ${describe(p)} from ${c?.name ?? p.customerPhone}.\n${balanceText(b)}`);
  await sendText(
    ctx,
    p.customerPhone,
    ok
      ? `Payment of ${money(p.amountCents)} received ✅ Thank you!\n${balanceText(b)}`
      : `We couldn't match your ${money(p.amountCents)} payment yet — the kitchen will message you about it 🙏`,
  );
}

const PAID_USAGE = "Use PAID <number> <amount> [zelle|venmo|cash|card], e.g. PAID +12015551234 24 cash";

/** Owner records a payment directly (cash etc.). Verified immediately. */
export async function cmdPaid(ctx: Ctx, owner: string, arg: string) {
  const [rawPhone = "", rawAmount = "", rawMethod, ...rest] = arg.split(/\s+/);
  const phone = normalizePhone(rawPhone);
  const cents = parseAmount(rawAmount);
  const method = rawMethod ? parseMethod(rawMethod) : "cash";
  if (!phone || !cents || !method) return sendText(ctx, owner, PAID_USAGE);
  const [c] = await ctx.db.select().from(customers).where(eq(customers.phone, phone));
  if (!c) return sendText(ctx, owner, `No customer with number ${phone}.`);
  const now = ctx.now();
  await ctx.db.insert(payments).values({
    customerPhone: phone,
    amountCents: cents,
    method,
    status: "verified",
    source: "owner",
    note: rest.join(" ") || null,
    createdAt: now,
    verifiedAt: now,
    verifiedBy: owner,
    updatedAt: now,
  });
  const b = await balance(ctx.db, phone);
  await sendText(ctx, owner, `Recorded ${money(cents)} ${methodLabel(method)} from ${c.name ?? phone}.\n${balanceText(b)}`);
  await sendText(ctx, phone, `Payment of ${money(cents)} received ✅ Thank you!\n${balanceText(b)}`);
}

export async function cmdPending(ctx: Ctx, owner: string) {
  const rows = await ctx.db
    .select({ p: payments, name: customers.name })
    .from(payments)
    .innerJoin(customers, eq(payments.customerPhone, customers.phone))
    .where(eq(payments.status, "pending"))
    .orderBy(payments.createdAt);
  if (!rows.length) return sendText(ctx, owner, "No payments waiting to be verified.");
  await sendLongText(
    ctx,
    owner,
    `*Payments to verify (${rows.length})*\n\n` +
      rows
        .map(({ p, name }) => `#${p.id} ${name ?? p.customerPhone} — ${describe(p)} — ${formatDay(localDate(p.createdAt, ctx.cfg.tz), ctx.cfg.tz)}`)
        .join("\n") +
      `\n\nReply VERIFY <#> or REJECT <#>.`,
  );
}

export async function cmdBalance(ctx: Ctx, owner: string, arg: string) {
  const phone = normalizePhone(arg);
  if (!phone) return sendText(ctx, owner, "Use BALANCE +12015551234");
  const [c] = await ctx.db.select().from(customers).where(eq(customers.phone, phone));
  if (!c) return sendText(ctx, owner, `No customer with number ${phone}.`);
  const b = await balance(ctx.db, phone);
  const recent = await ctx.db
    .select()
    .from(payments)
    .where(eq(payments.customerPhone, phone))
    .orderBy(desc(payments.createdAt))
    .limit(5);
  await sendText(
    ctx,
    owner,
    `*${who(c)}*\n${balanceText(b)}` +
      (recent.length
        ? `\n\nRecent payments:\n${recent.map((p) => `#${p.id} ${formatDay(localDate(p.createdAt, ctx.cfg.tz), ctx.cfg.tz)} — ${describe(p)} — ${p.status}`).join("\n")}`
        : "\n\nNo payments yet."),
  );
}

export async function cmdDues(ctx: Ctx, owner: string) {
  const rows = (await allBalances(ctx.db)).filter((b) => b.owedCents > 0).sort((a, b) => b.owedCents - a.owedCents);
  if (!rows.length) return sendText(ctx, owner, "Nobody owes anything 🎉");
  const total = rows.reduce((s, r) => s + r.owedCents, 0);
  await sendLongText(
    ctx,
    owner,
    `*Dues — ${rows.length} customers, ${money(total)}*\n\n` +
      rows
        .map((r) => `${r.name ?? r.phone} (${r.area ?? "no area"}) — ${money(r.owedCents)}${r.pendingCents ? ` (${money(r.pendingCents)} to verify)` : ""} — ${r.phone}`)
        .join("\n"),
  );
}

export async function cmdBlock(ctx: Ctx, owner: string, arg: string, blocked: boolean) {
  const phone = normalizePhone(arg);
  if (!phone) return sendText(ctx, owner, `Use ${blocked ? "BLOCK" : "UNBLOCK"} +12015551234`);
  const res = await ctx.db
    .update(customers)
    .set({ status: blocked ? "blocked" : "active", updatedAt: ctx.now() })
    .where(eq(customers.phone, phone))
    .returning({ name: customers.name });
  if (!res.length) return sendText(ctx, owner, `No customer with number ${phone}.`);
  await sendText(ctx, owner, blocked ? `Blocked ${res[0]!.name ?? phone}. The bot will ignore them.` : `Unblocked ${res[0]!.name ?? phone}.`);
}

