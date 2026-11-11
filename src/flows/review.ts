import { and, desc, eq, gte, inArray, like } from "drizzle-orm";
import { customers, kv, messages, orders, outbox } from "../db/schema";
import type { Ctx } from "../ctx";
import { ownerMenu } from "../domain/menu";
import { shortLines } from "../domain/order";
import { zonedInstant, localDate } from "../lib/time";
import { effectiveMode, isStaff, notifyOwners, sendLongText, sendText, setBotOff } from "../wa/send";

const since = (ctx: Ctx) => zonedInstant(localDate(ctx.now(), ctx.cfg.tz), "00:00", ctx.cfg.tz);

/** Customer replies the bot held back today (shadow / assist / BOT OFF). */
export async function heldReplies(ctx: Ctx) {
  return ctx.db
    .select({ to: outbox.to, payload: outbox.payload, createdAt: outbox.createdAt })
    .from(outbox)
    .where(and(eq(outbox.status, "suppressed"), gte(outbox.createdAt, since(ctx))))
    .orderBy(desc(outbox.createdAt));
}

/** BOT OFF / BOT ON: the owner's kill switch for every customer reply. */
export async function cmdBot(ctx: Ctx, phone: string, arg: string) {
  const a = arg.trim().toUpperCase();
  if (a !== "OFF" && a !== "ON") return sendText(ctx, phone, `Bot is ${(await effectiveMode(ctx)) === "shadow" ? "not replying to customers" : "on"}. Send BOT OFF or BOT ON.`);
  await setBotOff(ctx, a === "OFF");
  if (a === "OFF") return sendText(ctx, phone, "🛑 Bot is OFF: it won't reply to any customer. It still reads and records orders. Send BOT ON to turn it back on.");
  const mode = ctx.cfg.botMode;
  await sendText(ctx, phone, mode === "live" ? "✅ Bot is ON and replying to customers." : `✅ Bot is ON (mode: ${mode}).`);
}

/** REVIEW: flagged orders and the replies the bot held back, newest first. */
export async function cmdReview(ctx: Ctx, phone: string) {
  const out: string[] = [];
  const menu = await ownerMenu(ctx.db, ctx.now(), ctx.cfg.tz);
  if (menu) {
    const flagged = await ctx.db
      .select({ order: orders, name: customers.name })
      .from(orders)
      .innerJoin(customers, eq(orders.customerPhone, customers.phone))
      .where(and(eq(orders.menuId, menu.id), eq(orders.flagged, true), inArray(orders.status, ["draft", "confirmed"])));
    if (flagged.length) {
      out.push("*🚩 Flagged orders*");
      for (const f of flagged) out.push(`• ${f.name ?? f.order.customerPhone}: ${shortLines(f.order.lines)} — ${f.order.customerPhone}`);
    }
  }
  const held = await heldReplies(ctx);
  const byPhone = new Map<string, typeof held>();
  for (const h of held) byPhone.set(h.to, [...(byPhone.get(h.to) ?? []), h]);
  if (byPhone.size) {
    out.push("", `*✋ Replies held back today (${held.length})* — reply in your Business app`);
    for (const [to, list] of [...byPhone].slice(0, 15)) {
      const [last] = await ctx.db
        .select({ body: messages.body })
        .from(messages)
        .where(and(eq(messages.phone, to), eq(messages.direction, "in")))
        .orderBy(desc(messages.createdAt))
        .limit(1);
      const [c] = await ctx.db.select({ name: customers.name }).from(customers).where(eq(customers.phone, to));
      out.push(`• ${c?.name ?? to} ${to}\n  They said: "${(last?.body ?? "").slice(0, 100)}"\n  Bot would say: "${list[0]!.payload.body.slice(0, 120)}"`);
    }
  }
  await sendLongText(ctx, phone, out.length ? out.join("\n").trim() : "Nothing to review 👍");
}

/**
 * assist: the bot held back its reply to this customer message. Tell the
 * owner once per customer per day (handoffs already notified them).
 */
export async function pingHeld(ctx: Ctx, phone: string, msgId: string) {
  if (isStaff(ctx, phone) || (await effectiveMode(ctx)) !== "assist") return;
  const held = await ctx.db
    .select({ id: outbox.id })
    .from(outbox)
    .where(and(eq(outbox.status, "suppressed"), eq(outbox.to, phone), like(outbox.idemKey, `${msgId}:%`)))
    .limit(1);
  if (!held.length) return;
  const [m] = await ctx.db.select({ intent: messages.intent, body: messages.body }).from(messages).where(eq(messages.waMessageId, msgId));
  if (m?.intent === "handoff") return;
  const key = `review_ping:${localDate(ctx.now(), ctx.cfg.tz)}:${phone}`;
  const first = await ctx.db.insert(kv).values({ key, value: true, updatedAt: ctx.now() }).onConflictDoNothing().returning();
  if (!first.length) return;
  const [c] = await ctx.db.select({ name: customers.name }).from(customers).where(eq(customers.phone, phone));
  await notifyOwners(ctx, `✋ *Needs a reply:* ${c?.name ?? "Unknown"} ${phone}\n"${(m?.body ?? "").slice(0, 200)}"\nThe bot wasn't sure, so it didn't answer. Reply in your Business app. Send *REVIEW* for the list.`);
}

/** Header for the cutoff summary when the bot isn't fully live. */
export async function modeBanner(ctx: Ctx): Promise<string> {
  const mode = await effectiveMode(ctx);
  if (mode === "live") return "";
  const held = (await heldReplies(ctx)).length;
  if (mode === "shadow")
    return `🕶 *SHADOW: the bot sent nothing to customers.* Orders below are what it read (none confirmed by customers). Held replies today: ${held} — send REVIEW.\n\n`;
  return `🤝 *ASSIST mode:* held replies today: ${held} — send REVIEW.\n\n`;
}
