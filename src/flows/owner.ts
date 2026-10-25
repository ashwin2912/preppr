import { count, eq } from "drizzle-orm";
import { conversationState, customers, menus, orders, type Menu } from "../db/schema";
import type { Ctx } from "../ctx";
import { buildMenu, currentMenu, formatBroadcast, formatMenuPreview, ownerMenu } from "../domain/menu";
import { buildOrdersList, buildSummary, loadSummaryData } from "../domain/summary";
import { errFields, log } from "../lib/log";
import { normalizePhone } from "../lib/phone";
import { formatClock, formatDay, localDate, parseClock, zonedInstant } from "../lib/time";
import { send, sendLongText, sendText } from "../wa/send";
import type { Incoming } from "../wa/types";
import { cmdAdd, cmdSetField } from "./customerAdmin";
import { cmdBalance, cmdBlock, cmdDues, cmdPaid, cmdPending, settlePayment } from "./payments";
import { tagIntent } from "./state";

export const HELP = `*Owner commands*
MENU <menu text> — set a menu, e.g. MENU Mon: Dal makhani 6, Jeera rice 4, Roti 1 each. Cutoff 10:30
SUMMARY — full report for today
ORDERS — quick list of orders so far
CLOSE — stop taking orders now and send the summary
OPEN [time] — reopen ordering until time (default: 30 min from now)
RESUME <number> — turn the bot back on for a customer

*Customers*
ADD <number> [name] — add a regular; they skip the sign-up questions
NAME / AREA / NOTE <number> <value> — fill in name, delivery area, delivery note

*Payments*
PENDING — payments customers reported, waiting for you
VERIFY <#> / REJECT <#> — confirm or reject a reported payment
PAID <number> <amount> [cash|zelle|venmo|card] — record a payment yourself
BALANCE <number> — what a customer owes
DUES — everyone who owes money
BLOCK <number> / UNBLOCK <number> — make the bot ignore a customer
HELP — this list`;

const OPEN_DEFAULT_MS = 30 * 60 * 1000;

export async function sendSummary(ctx: Ctx, to: string, menu: Menu): Promise<boolean> {
  const { rows, handoffs } = await loadSummaryData(ctx.db, menu, ctx.cfg.tz);
  return sendLongText(ctx, to, buildSummary(menu, rows, handoffs, ctx.cfg));
}

async function cmdMenu(ctx: Ctx, phone: string, text: string) {
  if (!text) {
    await sendText(ctx, phone, "Send the menu after the word MENU, e.g.\nMENU Mon: Dal makhani 6, Jeera rice 4, Roti 1 each. Cutoff 10:30");
    return;
  }
  let built;
  try {
    built = buildMenu(await ctx.llm.parseMenu(text), ctx.now(), ctx.cfg);
  } catch (e) {
    log.error("parseMenu failed", errFields(e));
    await sendText(ctx, phone, "Sorry, I couldn't read that menu. Please try again.");
    return;
  }
  if (!built.items.length) {
    await sendText(ctx, phone, "I couldn't find any items with prices. Try: MENU Mon: Dal makhani 6, Roti 1. Cutoff 10:30");
    return;
  }
  const [existing] = await ctx.db.select().from(menus).where(eq(menus.date, built.date));
  if (existing && existing.status !== "draft") {
    const [{ n }] = (await ctx.db.select({ n: count() }).from(orders).where(eq(orders.menuId, existing.id))) as [{ n: number }];
    if (n > 0) {
      await sendText(
        ctx,
        phone,
        `The menu for ${formatDay(built.date, ctx.cfg.tz)} is already published and has ${n} order(s), so I can't replace it. Use OPEN/CLOSE to change the cutoff.`,
      );
      return;
    }
  }
  const values = { items: built.items, cutoffAt: built.cutoffAt, status: "draft" as const, summarySentAt: null };
  const [m] = await ctx.db
    .insert(menus)
    .values({ date: built.date, createdAt: ctx.now(), ...values })
    .onConflictDoUpdate({ target: menus.date, set: values })
    .returning();
  await send(ctx, {
    kind: "buttons",
    to: phone,
    body: formatMenuPreview(m!, ctx.cfg, built.cutoffWasDefault),
    buttons: [
      { id: `menu_publish:${m!.id}`, title: "Publish" },
      { id: `menu_edit:${m!.id}`, title: "Edit" },
    ],
  });
}

async function publish(ctx: Ctx, phone: string, menuId: number) {
  const [m] = await ctx.db.select().from(menus).where(eq(menus.id, menuId));
  if (!m) return sendText(ctx, phone, "That menu no longer exists. Send a new MENU.");
  if (m.status === "draft") {
    if (m.cutoffAt <= ctx.now()) {
      await sendText(ctx, phone, `The cutoff (${formatClock(m.cutoffAt, ctx.cfg.tz)}) has already passed. Send a new MENU with a later cutoff.`);
      return;
    }
    // Only one menu per date exists, so publishing can't collide with another active one for the same day.
    const [pub] = await ctx.db.update(menus).set({ status: "active" }).where(eq(menus.id, m.id)).returning();
    await sendText(ctx, phone, `✅ Published. Orders open until ${formatClock(m.cutoffAt, ctx.cfg.tz)}.\nForward the next message to your broadcast lists 👇`);
    await sendText(ctx, phone, formatBroadcast(pub!, ctx.cfg));
    return;
  }
  await sendText(ctx, phone, `This menu is already ${m.status}. Here's the broadcast again 👇`);
  await sendText(ctx, phone, formatBroadcast(m, ctx.cfg));
}

async function cmdClose(ctx: Ctx, phone: string) {
  const m = await currentMenu(ctx.db, ctx.now(), ctx.cfg.tz);
  if (!m) return sendText(ctx, phone, "No menu is open right now.");
  const [closed] = await ctx.db
    .update(menus)
    .set({ status: "closed", cutoffAt: ctx.now(), summarySentAt: ctx.now() })
    .where(eq(menus.id, m.id))
    .returning();
  await sendText(ctx, phone, `Closed ordering for ${formatDay(m.date, ctx.cfg.tz)}.`);
  await sendSummary(ctx, phone, closed!);
}

async function cmdOpen(ctx: Ctx, phone: string, arg: string) {
  const m = await ownerMenu(ctx.db, ctx.now(), ctx.cfg.tz);
  if (!m || m.date < localDate(ctx.now(), ctx.cfg.tz)) return sendText(ctx, phone, "No menu for today. Send a MENU first.");
  let cutoffAt = new Date(ctx.now().getTime() + OPEN_DEFAULT_MS);
  if (arg) {
    const hhmm = parseClock(arg);
    if (!hhmm) return sendText(ctx, phone, "Use OPEN or OPEN 11:30");
    cutoffAt = zonedInstant(m.date, hhmm, ctx.cfg.tz);
  }
  if (cutoffAt <= ctx.now()) return sendText(ctx, phone, "That time has already passed.");
  await ctx.db.update(menus).set({ status: "active", cutoffAt, summarySentAt: null }).where(eq(menus.id, m.id));
  await sendText(ctx, phone, `Reopened ${formatDay(m.date, ctx.cfg.tz)} until ${formatClock(cutoffAt, ctx.cfg.tz)}.`);
}

async function cmdResume(ctx: Ctx, phone: string, arg: string) {
  const target = normalizePhone(arg);
  if (!target) return sendText(ctx, phone, "Use RESUME +12015551234");
  const res = await ctx.db
    .update(customers)
    .set({ humanTakeoverUntil: null })
    .where(eq(customers.phone, target))
    .returning({ name: customers.name });
  await ctx.db.delete(conversationState).where(eq(conversationState.phone, target));
  if (!res.length) return sendText(ctx, phone, `No customer with number ${target}.`);
  await sendText(ctx, phone, `Bot is back on for ${res[0]!.name ?? target}.`);
}

export async function handleOwner(ctx: Ctx, msg: Incoming) {
  const phone = msg.phone;
  if (msg.replyId) {
    const [kind, id] = msg.replyId.split(":");
    await tagIntent(ctx, msg.id, `owner_${kind}`);
    if (kind === "menu_publish") return publish(ctx, phone, Number(id));
    if (kind === "menu_edit") return sendText(ctx, phone, "Send the corrected menu as a new MENU message.");
    if (kind === "pay_ok" || kind === "pay_no") return settlePayment(ctx, phone, Number(id), kind === "pay_ok");
    return;
  }
  const text = msg.text.trim();
  const [word = ""] = text.split(/\s+/);
  const cmd = word.toUpperCase().replace(/[^A-Z]/g, "");
  const arg = text.slice(word.length).trim();
  await tagIntent(ctx, msg.id, `owner_${cmd.toLowerCase() || msg.type}`);

  switch (cmd) {
    case "MENU":
      return cmdMenu(ctx, phone, arg);
    case "SUMMARY": {
      const m = await ownerMenu(ctx.db, ctx.now(), ctx.cfg.tz);
      if (!m) return sendText(ctx, phone, "No published menu yet.");
      await sendSummary(ctx, phone, m);
      return;
    }
    case "ORDERS": {
      const m = await ownerMenu(ctx.db, ctx.now(), ctx.cfg.tz);
      if (!m) return sendText(ctx, phone, "No published menu yet.");
      const { rows } = await loadSummaryData(ctx.db, m, ctx.cfg.tz);
      await sendLongText(ctx, phone, buildOrdersList(m, rows, ctx.cfg));
      return;
    }
    case "CLOSE":
      return cmdClose(ctx, phone);
    case "OPEN":
      return cmdOpen(ctx, phone, arg);
    case "RESUME":
      return cmdResume(ctx, phone, arg);
    case "ADD":
      return cmdAdd(ctx, phone, arg);
    case "NAME":
      return cmdSetField(ctx, phone, arg, "name");
    case "AREA":
      return cmdSetField(ctx, phone, arg, "area");
    case "NOTE":
      return cmdSetField(ctx, phone, arg, "addressNote");
    case "PAID":
      return cmdPaid(ctx, phone, arg);
    case "VERIFY":
    case "REJECT":
      return settlePayment(ctx, phone, Number(arg.replace(/^#/, "")), cmd === "VERIFY");
    case "PENDING":
      return cmdPending(ctx, phone);
    case "BALANCE":
      return cmdBalance(ctx, phone, arg);
    case "DUES":
      return cmdDues(ctx, phone);
    case "BLOCK":
    case "UNBLOCK":
      return cmdBlock(ctx, phone, arg, cmd === "BLOCK");
    default:
      await sendText(ctx, phone, HELP);
  }
}
