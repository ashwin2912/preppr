/**
 * Orders from WhatsApp "Export chat" files: find each day's menu in the
 * kitchen's own messages, then read every customer's messages that day with
 * the same parser the bot uses. Read-only; nothing is sent or stored.
 */
import type { MenuItem, OrderLine } from "../db/schema";
import { ruleInterpret } from "../llm/rules";
import type { Llm } from "../llm/types";
import type { ExportedMessage } from "./chatExport";
import { menuItemsFrom } from "./menu";
import { CONFIDENCE_MIN, money, orderTotal, priceLines, shortLines, toSimple } from "./order";

export type DateOrder = "mdy" | "dmy";
export type ExportChat = { file: string; messages: ExportedMessage[] };

export type ExtractedOrder = {
  date: string;
  /** Customer key: E.164 phone, or a name-based key when there's no phone. */
  key: string;
  phone: string | null;
  customer: string;
  /** Chats the customer wrote in that day ("1:1", group names, export files). */
  chats: string[];
  lines: OrderLine[];
  totalCents: number;
  cancelled: boolean;
  /** Reasons the owner should look at this one; empty = read cleanly. */
  check: string[];
  /** The customer's messages that day, in order. */
  messages: string[];
};

const DATE = /^(\d{1,4})[./-](\d{1,2})[./-](\d{1,4})/;

/** Month-first or day-first: decided by any date part over 12, else the fallback. */
export function detectDateOrder(chats: ExportChat[], fallback: DateOrder = "mdy"): DateOrder {
  for (const c of chats)
    for (const m of c.messages) {
      const d = m.at.match(DATE);
      if (!d || d[1]!.length === 4) continue;
      if (Number(d[1]) > 12) return "dmy";
      if (Number(d[2]) > 12) return "mdy";
    }
  return fallback;
}

/** "10/23/26, 8:14 AM" -> "2026-10-23" (null if the date can't be read). */
export function exportDate(at: string, order: DateOrder): string | null {
  const d = at.match(DATE);
  if (!d) return null;
  let [y, mo, da] = d[1]!.length === 4 ? [d[1]!, d[2]!, d[3]!] : order === "mdy" ? [d[3]!, d[1]!, d[2]!] : [d[3]!, d[2]!, d[1]!];
  if (y.length === 2) y = `20${y}`;
  const [Y, M, D] = [Number(y), Number(mo), Number(da)];
  if (M < 1 || M > 12 || D < 1 || D > 31) return null;
  return `${Y}-${String(M).padStart(2, "0")}-${String(D).padStart(2, "0")}`;
}

// "$6", "6$", "6.50", "- 6", "Rs 6": a price-ish number on a line.
const PRICE = /(\$\s?\d+(\.\d{1,2})?|\d+(\.\d{1,2})?\s?\$|[-–:@]\s*\d{1,3}(\.\d{1,2})?\s*$)/m;

/**
 * One chat message from any source (chat export, phone backup), already
 * dated in the kitchen's local time. `key` identifies the customer: the
 * E.164 phone when known, else a name-based key.
 */
export type OrderInput = {
  phone: string | null;
  key: string;
  name: string;
  /** "1:1" or the group's name (exports: the file name). */
  chat: string;
  isOwner: boolean;
  text: string;
  /** Local "YYYY-MM-DD", null if the date couldn't be read. */
  date: string | null;
  /** Something the owner should know about this sender, e.g. "phone hidden by WhatsApp". */
  note?: string;
};

/**
 * The kitchen's menu message for each date: an owner message with at least
 * two priced lines. A broadcast lands in every chat, so the text seen most
 * often that day wins; ties go to the longest.
 */
export function findMenus(inputs: OrderInput[]): Map<string, string> {
  const seen = new Map<string, Map<string, number>>();
  for (const m of inputs) {
    if (!m.isOwner || !m.date) continue;
    const priced = m.text.split("\n").filter((l) => PRICE.test(l)).length;
    if (priced < 2) continue;
    const byText = seen.get(m.date) ?? new Map<string, number>();
    byText.set(m.text, (byText.get(m.text) ?? 0) + 1);
    seen.set(m.date, byText);
  }
  const out = new Map<string, string>();
  for (const [date, byText] of seen) {
    const [best] = [...byText].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length);
    if (best) out.set(date, best[0]);
  }
  return out;
}

/** Chat exports as order inputs: the customer is the chat (no phone numbers in exports). */
export function exportInputs(chats: ExportChat[], owner: string, order: DateOrder): OrderInput[] {
  return chats.flatMap((c) => {
    const customer = customerName(c, owner);
    return c.messages.map((m) => ({
      phone: null,
      key: customer,
      name: customer,
      chat: c.file,
      isOwner: m.author === owner,
      text: m.text,
      date: exportDate(m.at, order),
    }));
  });
}

/** Menu texts per date in chat exports (see findMenus). */
export function findMenuTexts(chats: ExportChat[], owner: string, order: DateOrder): Map<string, string> {
  return findMenus(exportInputs(chats, owner, order));
}

/** Menu text -> priced items, via the model (same as the MENU command). */
export async function parseMenuText(llm: Llm, text: string): Promise<MenuItem[]> {
  return menuItemsFrom(await llm.parseMenu(text));
}

/** Who the chat is with: the one author who isn't the kitchen, else the file name. */
export function customerName(chat: ExportChat, owner: string): string {
  const others = [...new Set(chat.messages.map((m) => m.author))].filter((a) => a !== owner);
  if (others.length === 1) return others[0]!;
  return chat.file.replace(/\.txt$/i, "").replace(/^WhatsApp Chat (with|-) /i, "").trim() || others.join(" / ");
}

/**
 * Read one customer's messages for one day as the bot would: each order or
 * edit replaces the order (the parser returns the complete order), a cancel
 * clears it. Anything uncertain is kept and listed in `check`.
 */
export async function readDay(llm: Llm, menu: MenuItem[], texts: string[]): Promise<Pick<ExtractedOrder, "lines" | "cancelled" | "check">> {
  let lines: OrderLine[] = [];
  let cancelled = false;
  const check: string[] = [];
  for (const message of texts) {
    const input = { message, menu, currentOrder: lines.length ? toSimple(lines) : null, previousOrder: null, clarification: null };
    const it = ruleInterpret(input) ?? (await llm.interpret(input));
    if (it.intent === "cancel") {
      if (lines.length) cancelled = true;
      lines = [];
      continue;
    }
    if (it.intent === "payment") check.push(`payment mentioned${it.payment_cents ? `: ${money(it.payment_cents)}` : ""}`);
    if (it.intent === "handoff") check.push(`asked for you: "${message.slice(0, 80)}"`);
    if (it.intent !== "order" && it.intent !== "edit") continue;
    const priced = priceLines(it.lines, menu);
    const unclear = [...it.unmatched, ...priced.problems];
    if (unclear.length) check.push(`unclear: ${unclear.join(", ")}`);
    if (it.confidence < CONFIDENCE_MIN) check.push(`not sure about "${message.slice(0, 80)}"`);
    if (priced.lines.length) {
      lines = priced.lines;
      cancelled = false;
    }
  }
  return { lines, cancelled, check };
}

/**
 * All orders in the inputs for the given dates (default: every date that has
 * a menu), one per customer key per day, whichever chats they wrote in.
 * Customers who wrote that day but ordered nothing are listed only when
 * something needs a look. Inputs must be in time order.
 */
export async function extractFromInputs(
  llm: Llm,
  inputs: OrderInput[],
  menus: Map<string, MenuItem[]>,
  dates?: string[],
): Promise<ExtractedOrder[]> {
  const wanted = new Set(dates ?? menus.keys());
  const groups = new Map<string, OrderInput[]>();
  for (const m of inputs) {
    if (m.isOwner || !m.date || !wanted.has(m.date)) continue;
    const k = `${m.date}\u0000${m.key}`;
    groups.set(k, [...(groups.get(k) ?? []), m]);
  }
  const out: ExtractedOrder[] = [];
  for (const group of groups.values()) {
    const first = group[0]!;
    const date = first.date!;
    const texts = group.map((m) => m.text);
    const chats = [...new Set(group.map((m) => m.chat))];
    const notes = [...new Set(group.flatMap((m) => (m.note ? [m.note] : [])))];
    if (chats.length > 1) notes.push(`wrote in ${chats.length} chats: ${chats.join(", ")}`);
    const who = { date, key: first.key, phone: first.phone, customer: group.at(-1)!.name || first.name, chats, messages: texts };
    const menu = menus.get(date);
    if (!menu?.length) {
      out.push({ ...who, lines: [], totalCents: 0, cancelled: false, check: ["no menu found for this day", ...notes] });
      continue;
    }
    const r = await readDay(llm, menu, texts);
    if (!r.lines.length && !r.cancelled && !r.check.length) continue;
    out.push({ ...who, ...r, check: [...r.check, ...notes], totalCents: orderTotal(r.lines) });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.customer.localeCompare(b.customer));
}

/** Orders from chat exports (see extractFromInputs). */
export function extractOrders(
  llm: Llm,
  chats: ExportChat[],
  owner: string,
  menus: Map<string, MenuItem[]>,
  order: DateOrder,
  dates?: string[],
): Promise<ExtractedOrder[]> {
  return extractFromInputs(llm, exportInputs(chats, owner, order), menus, dates);
}

/** Kitchen totals for one day: portions per dish, order count, revenue, and what to check. */
export function daySummary(date: string, orders: ExtractedOrder[]): string {
  const day = orders.filter((o) => o.date === date);
  const real = day.filter((o) => o.lines.length);
  const dishes = new Map<string, number>();
  for (const o of real) for (const l of o.lines) dishes.set(l.name, (dishes.get(l.name) ?? 0) + l.qty);
  const out = [`${date}: ${real.length} orders, ${money(real.reduce((s, o) => s + o.totalCents, 0))}`];
  for (const [name, qty] of [...dishes].sort((a, b) => b[1] - a[1])) out.push(`  ${qty} × ${name}`);
  for (const o of real) out.push(`  - ${o.customer}: ${shortLines(o.lines)} = ${money(o.totalCents)}${o.check.length ? "  ⚠" : ""}`);
  const look = day.filter((o) => o.check.length || o.cancelled);
  if (look.length) {
    out.push("  Check:");
    for (const o of look) out.push(`    ${o.customer}: ${[...(o.cancelled ? ["cancelled"] : []), ...o.check].join("; ")}`);
  }
  return out.join("\n");
}

/** Spreadsheet-safe CSV cell: quoted, and a leading = + - @ can't run as a formula. */
export function csvCell(v: unknown): string {
  let s = String(v ?? "");
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

/** ok / check / cancelled, as the owner reads it. */
export const orderStatus = (o: ExtractedOrder) => (o.lines.length ? (o.check.length ? "check" : "ok") : o.cancelled ? "cancelled" : "check");

const toCsv = (rows: unknown[][]) => rows.map((r) => r.map(csvCell).join(",")).join("\n") + "\n";
const dollars = (cents: number) => (cents / 100).toFixed(2);

/** One row per order: date, customer, items, total, status, what to check, the raw messages. */
export function ordersCsv(orders: ExtractedOrder[]): string {
  const head = ["date", "customer", "items", "total", "status", "check", "messages"];
  const rows = orders.map((o) => [o.date, o.customer, shortLines(o.lines), dollars(o.totalCents), orderStatus(o), o.check.join("; "), o.messages.join(" | ")]);
  return toCsv([head, ...rows]);
}

/** Columns of the running "All orders" sheet (fixed: dishes change every day). */
export const ALL_ORDERS_HEAD = ["date", "phone", "name", "chat", "items", "total", "status", "check", "messages"];

/** One "All orders" row per order, matching ALL_ORDERS_HEAD. */
export const allOrdersRow = (o: ExtractedOrder): string[] => [
  o.date,
  o.phone ?? o.key,
  o.customer,
  o.chats.join(", "),
  shortLines(o.lines),
  dollars(o.totalCents),
  orderStatus(o),
  o.check.join("; "),
  o.messages.join(" | "),
];

/** One day's sheet: phone first, one quantity column per dish on the menu, then items and total. */
export function dailyCsv(orders: ExtractedOrder[], menu: MenuItem[]): string {
  const head = ["phone", "name", "chat", ...menu.map((i) => i.name), "items", "total", "status", "check", "messages"];
  const rows = orders.map((o) => [
    o.phone ?? o.key,
    o.customer,
    o.chats.join(", "),
    ...menu.map((i) => o.lines.filter((l) => l.item_id === i.id).reduce((s, l) => s + l.qty, 0) || ""),
    shortLines(o.lines),
    dollars(o.totalCents),
    orderStatus(o),
    o.check.join("; "),
    o.messages.join(" | "),
  ]);
  return toCsv([head, ...rows]);
}

/** Rewrite rows of the running sheet: drop every row for `date`, append the new ones, keep the file sorted by date. */
export function mergeAllOrders(existing: string[][], date: string, orders: ExtractedOrder[]): string {
  const kept = existing.filter((r) => r[0] !== date && r.length > 1);
  const rows = [...kept, ...orders.map(allOrdersRow)].sort((a, b) => (a[0] ?? "").localeCompare(b[0] ?? ""));
  return toCsv([ALL_ORDERS_HEAD, ...rows]);
}
