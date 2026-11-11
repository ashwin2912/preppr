import { and, count, eq, isNull } from "drizzle-orm";
import { conversationState, customers, menus, type Menu } from "../db/schema";
import type { Ctx } from "../ctx";
import { buildMenu, currentMenu, formatBroadcast, ownerMenu } from "../domain/menu";
import { buildOrdersList, buildSummary, loadSummaryData } from "../domain/summary";
import { errFields, log } from "../lib/log";
import { normalizePhone, waLink } from "../lib/phone";
import { formatClock, formatDay, localDate, parseClock, zonedInstant } from "../lib/time";
import { send, sendLongText, sendText } from "../wa/send";
import { InboundMessageSchema, type Incoming } from "../wa/types";
import { importCustomers, parseSharedContacts } from "../domain/importCustomers";
import { KITCHEN_LINK_TTL_MS, signViewerToken } from "../admin/auth";
import { cmdAdd, cmdSetField } from "./customerAdmin";
import { cmdBalance, cmdBlock, cmdDues, cmdPaid, cmdPending, settlePayment } from "./payments";
import { tagIntent } from "./state";
import { pushMenu, STARTER_LIMIT } from "../jobs/menuPush";
import { cmdBot, cmdReview, modeBanner } from "./review";
import { cmdAddProducts, cmdCatalogMenu, cmdLink, cmdProducts, cmdRemoveProduct, copyMenuTo, handleCatalogButton, sendFormKit } from "./catalog";
import { kvDelete } from "../db/kv";
import { ownerCtxKey, saveDraftMenu } from "./menuDraft";
import { CHAT_EXAMPLES, handleOwnerChat, type ChatCommand } from "./ownerChat";
import { cmdFormOrders, cmdHow, cmdMessage, cmdWhat } from "./ownerDay";

/** What the owner sees for /help in the WhatsForm flow: plain chat for dishes and menus, then the day commands. */
export const DAY_HELP = `*Your dishes and today's menu*
${CHAT_EXAMPLES}

*Your day*
/products — your dishes with numbers
/how — today at a glance: orders, sales, menu
/what — how much of each dish to make
/orders — who ordered what
/message — today's broadcast message to forward
/app — your kitchen page (orders and totals; dishes and menu too)`;

/** The menu-assistant commands (product list, daily menu, WhatsForm). */
export const PRODUCT_HELP = `*Products & menu*
${CHAT_EXAMPLES}

Or with commands:
/products — your dishes with sizes and prices
/add-product Dal 8oz 6, 16oz 10 — add dishes (one per line; Roti 1 each for no sizes)
/edit-product 3 8oz 7, 16oz 11 — change a dish's sizes/prices (number from /products)
/remove-product 3 — take a dish off the list
/app — open your kitchen page: add dishes and sizes, make the menu, copy the WhatsForm lines
/menu 1 3 5 cutoff 10:30 — today's menu from your products (or /menu dal, roti; /menu tomorrow: …)
/link <form link> — put today's WhatsForm link into the broadcast
/help — this list`;

export const HELP = `${PRODUCT_HELP}

*Owner commands*
MENU <menu text> — set a menu, e.g. MENU Mon: Dal makhani 6, Jeera rice 4, Roti 1 each. Cutoff 10:30
SUMMARY — full report for today
ORDERS — quick list of orders so far
CLOSE — stop taking orders now and send the summary
OPEN [time] — reopen ordering until time (default: 30 min from now)
RESUME <number> — turn the bot back on for a customer (also after you reply to them yourself)
BOT OFF / BOT ON — stop or restart all bot replies to customers (it keeps recording orders)
REVIEW — orders and messages the bot wasn't sure about

*Customers*
ADD <number> [name] — add a regular; they skip the sign-up questions
(Or share contacts with me: 📎 → Contact → pick people → Send)
NAME / AREA / NOTE <number> <value> — fill in name, delivery area, delivery note

*Payments*
PENDING — payments customers reported, waiting for you
VERIFY <#> / REJECT <#> — confirm or reject a reported payment
PAID <number> <amount> [cash|zelle|venmo|card] — record a payment yourself
BALANCE <number> — what a customer owes
DUES — everyone who owes money
BLOCK <number> / UNBLOCK <number> — make the bot ignore a customer
OPTIN <number>|ALL / OPTOUT <number> — who gets the daily "ordering is open" message
CHATS [number] — private link to read the bot's conversations (works 12 h)
HELP — this list`;

const OPEN_DEFAULT_MS = 30 * 60 * 1000;
/** Returned by a command handler when the text isn't really that command: read it as plain chat. */
const NOT_A_COMMAND = Symbol("not a command");

export async function sendSummary(ctx: Ctx, to: string, menu: Menu): Promise<boolean> {
  const { rows, handoffs } = await loadSummaryData(ctx.db, menu, ctx.cfg.tz);
  return sendLongText(ctx, to, (await modeBanner(ctx)) + buildSummary(menu, rows, handoffs, ctx.cfg));
}

async function cmdMenu(ctx: Ctx, phone: string, text: string): Promise<unknown> {
  // With a product list, MENU picks dishes from it; free-text menus are for kitchens without one.
  const r = await cmdCatalogMenu(ctx, phone, text);
  if (r === "chat") return NOT_A_COMMAND;
  if (r) return;
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
  await saveDraftMenu(ctx, phone, built);
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
    await kvDelete(ctx.db, ownerCtxKey(phone));
    if (ctx.cfg.orderChannel === "whatsform") return sendFormKit(ctx, phone, pub!);
    if (ctx.cfg.coexistence) return offerPush(ctx, phone, pub!);
    await sendText(ctx, phone, `✅ Published. Orders open until ${formatClock(m.cutoffAt, ctx.cfg.tz)}.\nForward the next message to your broadcast lists 👇`);
    await sendText(ctx, phone, formatBroadcast(pub!, ctx.cfg));
    return;
  }
  if (ctx.cfg.orderChannel === "whatsform") return sendFormKit(ctx, phone, m);
  if (ctx.cfg.coexistence) return offerPush(ctx, phone, m);
  await sendText(ctx, phone, `This menu is already ${m.status}. Here's the broadcast again 👇`);
  await sendText(ctx, phone, formatBroadcast(m, ctx.cfg));
}

/** Shared number: broadcast lists are off, so the bot sends the menu itself once the owner says so. */
async function offerPush(ctx: Ctx, phone: string, m: Menu) {
  const [{ n }] = (await ctx.db
    .select({ n: count() })
    .from(customers)
    .where(and(eq(customers.status, "active"), eq(customers.menuOptIn, true)))) as [{ n: number }];
  await send(ctx, {
    kind: "buttons",
    to: phone,
    body:
      `✅ Published. Orders open until ${formatClock(m.cutoffAt, ctx.cfg.tz)}.\n\n` +
      `Send the menu to ${n} customer${n === 1 ? "" : "s"} who asked for it?\n` +
      `For your Status or groups, the order link is ${waLink(`+${ctx.cfg.botNumber}`, "ORDER")}`,
    buttons: [
      { id: `menu_push:${m.id}`, title: "Send menu 📣" },
      { id: `menu_nopush:${m.id}`, title: "Not now" },
    ],
  });
}

async function cmdPush(ctx: Ctx, phone: string, menuId: number) {
  const [m] = await ctx.db.select().from(menus).where(eq(menus.id, menuId));
  if (!m || m.status !== "active" || m.cutoffAt <= ctx.now()) return sendText(ctx, phone, "That menu isn't open any more.");
  const r = await pushMenu(ctx, m);
  if (r.already) return sendText(ctx, phone, "Already sent this menu to customers ✅");
  const lines = [`📣 Sent to ${r.inChat + r.template} customer${r.inChat + r.template === 1 ? "" : "s"} (${r.inChat} in chat, ${r.template} as the "ordering is open" message).`];
  if (r.notOptedIn) lines.push(`${r.notOptedIn} customer${r.notOptedIn === 1 ? " hasn't" : "s haven't"} asked for it yet: OPTIN <number> or OPTIN ALL if they already get your menu.`);
  if (r.template > STARTER_LIMIT) lines.push(`⚠️ More than ${STARTER_LIMIT} reminder messages: Meta may hold some back until the account's limit goes up.`);
  await sendText(ctx, phone, lines.join("\n"));
}

async function cmdOptIn(ctx: Ctx, phone: string, arg: string, on: boolean) {
  const all = on && arg.trim().toUpperCase() === "ALL";
  const target = all ? null : normalizePhone(arg);
  if (!all && !target) return sendText(ctx, phone, on ? "Use OPTIN +12015551234 or OPTIN ALL" : "Use OPTOUT +12015551234");
  const now = ctx.now();
  const res = await ctx.db
    .update(customers)
    .set({ menuOptIn: on, menuOptInAt: now, updatedAt: now })
    .where(all ? and(eq(customers.status, "active"), isNull(customers.menuOptIn)) : eq(customers.phone, target!))
    .returning({ phone: customers.phone });
  if (all) return sendText(ctx, phone, `${res.length} customer${res.length === 1 ? "" : "s"} will get the daily message. (Customers who said no or sent STOP are left out.)`);
  if (!res.length) return sendText(ctx, phone, `No customer with number ${target}.`);
  await sendText(ctx, phone, on ? `${target} will get the daily message.` : `${target} won't get the daily message.`);
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

/** APP: private link to the kitchen page (dishes, menu, WhatsForm lines), valid 30 days. */
async function cmdApp(ctx: Ctx, phone: string) {
  const { publicUrl, adminSecret } = ctx.cfg;
  if (!publicUrl || !adminSecret) return sendText(ctx, phone, "The kitchen page isn't set up yet (needs PUBLIC_URL and ADMIN_SECRET).");
  const params = new URLSearchParams({ t: signViewerToken(adminSecret, phone, ctx.now(), KITCHEN_LINK_TTL_MS), next: "/admin/kitchen" });
  await sendText(ctx, phone, `Your kitchen page 👇 (private link, works for 30 days — don't forward it)\n${publicUrl}/admin?${params}`);
}

async function cmdChats(ctx: Ctx, phone: string, arg: string) {
  const { publicUrl, adminSecret } = ctx.cfg;
  if (!publicUrl || !adminSecret) return sendText(ctx, phone, "The chat viewer isn't set up yet (needs PUBLIC_URL and ADMIN_SECRET).");
  const target = arg ? normalizePhone(arg) : null;
  if (arg && !target) return sendText(ctx, phone, "Use CHATS, or CHATS +12015551234 for one customer.");
  const params = new URLSearchParams({ t: signViewerToken(adminSecret, phone, ctx.now()) });
  if (target) params.set("next", `/admin/c/${encodeURIComponent(target)}`);
  await sendText(ctx, phone, `Bot conversations 👇 (private link, works for 12 hours — don't forward it)\n${publicUrl}/admin?${params}`);
}

/** Owner shared contact cards with the bot: they become known customers. */
async function addSharedContacts(ctx: Ctx, phone: string, msg: Incoming) {
  const parsed = InboundMessageSchema.safeParse(msg.raw);
  const { rows, report } = parseSharedContacts(parsed.success ? (parsed.data.contacts ?? []) : []);
  if (!rows.length) return sendText(ctx, phone, "I couldn't find any phone numbers in those contacts.");
  await importCustomers(ctx.db, rows, report, ctx.now());
  const parts = [`Added ${report.inserted} customer${report.inserted === 1 ? "" : "s"}`];
  if (report.updated) parts.push(`updated ${report.updated}`);
  const same = rows.length - report.inserted - report.updated;
  if (same > 0) parts.push(`${same} already known`);
  if (report.badPhones.length) parts.push(`${report.badPhones.length} number(s) unreadable`);
  await sendText(ctx, phone, `${parts.join(", ")}. They can order straight away, no sign-up questions.`);
}

export async function handleOwner(ctx: Ctx, msg: Incoming) {
  const phone = msg.phone;
  if (msg.replyId) {
    const [kind, id] = msg.replyId.split(":");
    await tagIntent(ctx, msg.id, `owner_${kind}`);
    if (kind === "menu_publish") return publish(ctx, phone, Number(id));
    if (kind === "menu_edit")
      return sendText(ctx, phone, "What should I change? e.g. *add samosa*, *no rice*, *only 16oz dal*, *cutoff 11*, or send the whole menu again.");
    if (kind === "menu_copy") return copyNudgedMenu(ctx, phone, Number(id));
    if (kind === "show_products") return cmdProducts(ctx, phone);
    if (kind === "menu_push") return cmdPush(ctx, phone, Number(id));
    if (kind === "menu_nopush") return sendText(ctx, phone, "OK, not sent. Tap Send menu above any time before the cutoff.");
    if (kind === "pay_ok" || kind === "pay_no") return settlePayment(ctx, phone, Number(id), kind === "pay_ok");
    await handleCatalogButton(ctx, phone, kind ?? "", id ?? "");
    return;
  }
  if (msg.type === "contacts") {
    await tagIntent(ctx, msg.id, "owner_contacts");
    return addSharedContacts(ctx, phone, msg);
  }
  const text = msg.text.trim();
  const [word = ""] = text.split(/\s+/);
  const cmd = word.toUpperCase().replace(/[^A-Z]/g, "");
  const arg = text.slice(word.length).trim();
  await tagIntent(ctx, msg.id, `owner_${cmd.toLowerCase() || msg.type}`);
  if (await runCommand(ctx, phone, cmd, arg, msg)) return;

  // Not a command word: plain chat about dishes and menus.
  const next = text ? await handleOwnerChat(ctx, phone, text, msg.id) : "HELP";
  if (next) await runCommand(ctx, phone, next, "", msg);
}

/** Nudge button "Same as Mon": that menu again for today. */
async function copyNudgedMenu(ctx: Ctx, phone: string, menuId: number) {
  const [src] = await ctx.db.select().from(menus).where(eq(menus.id, menuId));
  if (!src) return sendText(ctx, phone, "That menu no longer exists. Tell me today's dishes, e.g. *today dal, paneer, roti*.");
  await copyMenuTo(ctx, phone, src, localDate(ctx.now(), ctx.cfg.tz));
}

/** Exact owner commands; false when `cmd` isn't one (the caller then reads it as chat). */
async function runCommand(ctx: Ctx, phone: string, cmd: ChatCommand | string, arg: string, msg: Incoming): Promise<boolean> {
  return (await dispatch(ctx, phone, cmd, arg, msg)) !== NOT_A_COMMAND;
}

async function dispatch(ctx: Ctx, phone: string, cmd: string, arg: string, msg: Incoming): Promise<unknown> {
  switch (cmd) {
    case "MENU":
      return cmdMenu(ctx, phone, arg);
    case "SUMMARY": {
      const m = await ownerMenu(ctx.db, ctx.now(), ctx.cfg.tz);
      if (!m) return sendText(ctx, phone, "No published menu yet.");
      await sendSummary(ctx, phone, m);
      return;
    }
    case "HOW":
      return cmdHow(ctx, phone);
    case "WHAT":
      return cmdWhat(ctx, phone);
    case "MESSAGE":
    case "BROADCAST":
      return cmdMessage(ctx, phone);
    case "ORDERS": {
      if (ctx.cfg.orderChannel === "whatsform") return cmdFormOrders(ctx, phone);
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
    case "BOT":
      return cmdBot(ctx, phone, arg);
    case "REVIEW":
      return cmdReview(ctx, phone);
    case "CHATS":
    case "CHAT":
      return cmdChats(ctx, phone, arg);
    case "PRODUCTS":
    case "PRODUCT":
    case "ITEMS":
      return cmdProducts(ctx, phone);
    case "ADDPRODUCT":
    case "ADDPRODUCTS":
    case "ADDITEM":
    case "ADDITEMS":
    case "ADDDISH":
      return cmdAddProducts(ctx, phone, arg, msg.id, false);
    case "EDITPRODUCT":
    case "EDITITEM":
    case "EDITDISH":
      return cmdAddProducts(ctx, phone, arg, msg.id, true);
    case "REMOVEPRODUCT":
    case "REMOVEITEM":
    case "DELETEPRODUCT":
    case "REMOVEDISH":
      return cmdRemoveProduct(ctx, phone, arg);
    case "LINK":
      return cmdLink(ctx, phone, arg);
    case "APP":
    case "DASHBOARD":
    case "KITCHEN":
    case "PAGE":
      return cmdApp(ctx, phone);
    case "ADD":
      // "ADD +1201… Name" is a customer; "ADD Dal 8oz 6" a dish; "add samosa" (no price) is chat: onto the menu.
      if (!/^[a-z]/i.test(arg)) return cmdAdd(ctx, phone, arg);
      if (!/\d/.test(arg)) return NOT_A_COMMAND;
      return cmdAddProducts(ctx, phone, arg, msg.id, false);
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
    case "OPTIN":
    case "OPTOUT":
      return cmdOptIn(ctx, phone, arg, cmd === "OPTIN");
    case "BLOCK":
    case "UNBLOCK":
      return cmdBlock(ctx, phone, arg, cmd === "BLOCK");
    case "HELP":
    case "COMMANDS":
      // Menu assistant (WhatsForm flow): the short list, unless they ask for everything.
      if (ctx.cfg.orderChannel === "whatsform" && !/^all$/i.test(arg)) return sendText(ctx, phone, DAY_HELP);
      return sendText(ctx, phone, HELP);
    default:
      return NOT_A_COMMAND;
  }
}
