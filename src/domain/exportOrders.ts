/**
 * Orders from WhatsApp "Export chat" files: find each day's menu in the
 * kitchen's own messages, then read every customer's messages that day with
 * the same parser the bot uses. Read-only; nothing is sent or stored.
 */
import type { MenuItem, OrderLine } from "../db/schema";
import { CONFIDENCE_MIN } from "../flows/customer";
import { ruleInterpret } from "../llm/rules";
import type { Llm } from "../llm/types";
import type { ExportedMessage } from "./chatExport";
import { menuItemsFrom } from "./menu";
import { money, orderTotal, priceLines, shortLines, toSimple } from "./order";

export type DateOrder = "mdy" | "dmy";
export type ExportChat = { file: string; messages: ExportedMessage[] };

export type ExtractedOrder = {
  date: string;
  customer: string;
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
 * The kitchen's menu message for each date: an owner message with at least
 * two priced lines. A broadcast lands in every chat, so the text seen in the
 * most chats that day wins; ties go to the longest.
 */
export function findMenuTexts(chats: ExportChat[], owner: string, order: DateOrder): Map<string, string> {
  const seen = new Map<string, Map<string, number>>();
  for (const c of chats)
    for (const m of c.messages) {
      if (m.author !== owner) continue;
      const priced = m.text.split("\n").filter((l) => PRICE.test(l)).length;
      if (priced < 2) continue;
      const date = exportDate(m.at, order);
      if (!date) continue;
      const byText = seen.get(date) ?? new Map<string, number>();
      byText.set(m.text, (byText.get(m.text) ?? 0) + 1);
      seen.set(date, byText);
    }
  const out = new Map<string, string>();
  for (const [date, byText] of seen) {
    const [best] = [...byText].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length);
    if (best) out.set(date, best[0]);
  }
  return out;
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
 * All orders in the exports for the given dates (default: every date that
 * has a menu). Customers who wrote that day but ordered nothing are listed
 * only when something needs a look.
 */
export async function extractOrders(
  llm: Llm,
  chats: ExportChat[],
  owner: string,
  menus: Map<string, MenuItem[]>,
  order: DateOrder,
  dates?: string[],
): Promise<ExtractedOrder[]> {
  const wanted = new Set(dates ?? menus.keys());
  const out: ExtractedOrder[] = [];
  for (const chat of chats) {
    const customer = customerName(chat, owner);
    const byDate = new Map<string, string[]>();
    for (const m of chat.messages) {
      if (m.author === owner) continue;
      const date = exportDate(m.at, order);
      if (!date || !wanted.has(date)) continue;
      byDate.set(date, [...(byDate.get(date) ?? []), m.text]);
    }
    for (const [date, texts] of byDate) {
      const menu = menus.get(date);
      if (!menu?.length) {
        out.push({ date, customer, lines: [], totalCents: 0, cancelled: false, check: ["no menu found for this day"], messages: texts });
        continue;
      }
      const r = await readDay(llm, menu, texts);
      if (!r.lines.length && !r.cancelled && !r.check.length) continue;
      out.push({ date, customer, ...r, totalCents: orderTotal(r.lines), messages: texts });
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.customer.localeCompare(b.customer));
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

/** One row per order: date, customer, items, total, status, what to check, the raw messages. */
export function ordersCsv(orders: ExtractedOrder[]): string {
  const head = ["date", "customer", "items", "total", "status", "check", "messages"];
  const rows = orders.map((o) => [
    o.date,
    o.customer,
    shortLines(o.lines),
    (o.totalCents / 100).toFixed(2),
    o.lines.length ? (o.check.length ? "check" : "ok") : o.cancelled ? "cancelled" : "check",
    o.check.join("; "),
    o.messages.join(" | "),
  ]);
  return [head, ...rows].map((r) => r.map(csvCell).join(",")).join("\n") + "\n";
}
