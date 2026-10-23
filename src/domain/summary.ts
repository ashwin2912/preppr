import { and, eq, gte } from "drizzle-orm";
import type { Config } from "../config";
import type { Q } from "../db/client";
import { customers, messages, orders, type Customer, type Menu, type Order } from "../db/schema";
import { formatClock, formatDay, zonedInstant } from "../lib/time";
import { money, shortLines } from "./order";

export type SummaryRow = { order: Order; customer: Customer };
export type HandoffRow = { phone: string; name: string | null; body: string | null };

export async function loadSummaryData(db: Q, menu: Menu, tz: string) {
  const rows = await db
    .select({ order: orders, customer: customers })
    .from(orders)
    .innerJoin(customers, eq(orders.customerPhone, customers.phone))
    .where(eq(orders.menuId, menu.id));
  // A handoff tags the customer's inbound message with intent=handoff.
  const since = zonedInstant(menu.date, "00:00", tz);
  const handoffs = await db
    .select({ phone: messages.phone, name: customers.name, body: messages.body })
    .from(messages)
    .leftJoin(customers, eq(messages.phone, customers.phone))
    .where(and(eq(messages.intent, "handoff"), eq(messages.direction, "in"), gte(messages.createdAt, since)));
  return { rows, handoffs };
}

const UNASSIGNED = "No area";
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/** Owner's cutoff report. Pure: amounts only from stored order lines. */
export function buildSummary(menu: Menu, rows: SummaryRow[], handoffs: HandoffRow[], cfg: Config): string {
  const confirmed = rows.filter((r) => r.order.status === "confirmed");
  const drafts = rows.filter((r) => r.order.status === "draft");
  const flagged = rows.filter((r) => r.order.flagged && r.order.status !== "cancelled");
  const cancelled = rows.filter((r) => r.order.status === "cancelled");

  const out: string[] = [];
  out.push(`*${cfg.kitchenName} — ${formatDay(menu.date, cfg.tz)}*`);
  out.push(`Cutoff ${formatClock(menu.cutoffAt, cfg.tz)} · status ${menu.status}`);

  // Kitchen totals, in menu order.
  const qty = new Map<string, number>();
  for (const r of confirmed) for (const l of r.order.lines) qty.set(l.item_id, (qty.get(l.item_id) ?? 0) + l.qty);
  out.push("", "*🍳 Kitchen totals*");
  const kitchen = menu.items.filter((i) => qty.get(i.id)).map((i) => `${qty.get(i.id)} × ${i.name}`);
  out.push(kitchen.length ? kitchen.join("\n") : "No confirmed orders.");

  // Delivery list by area (configured order first, then anything else).
  const byArea = new Map<string, SummaryRow[]>();
  for (const r of confirmed) {
    const a = r.customer.area ?? UNASSIGNED;
    byArea.set(a, [...(byArea.get(a) ?? []), r]);
  }
  const areaOrder = [...cfg.areas, ...[...byArea.keys()].filter((a) => !cfg.areas.includes(a))];
  out.push("", "*🛵 Delivery list*");
  for (const area of areaOrder) {
    const list = byArea.get(area);
    if (!list?.length) continue;
    const sub = list.reduce((s, r) => s + r.order.totalCents, 0);
    out.push("", `*${area}* (${plural(list.length, "order")}, ${money(sub)})`);
    list
      .sort((a, b) => (a.customer.name ?? "").localeCompare(b.customer.name ?? ""))
      .forEach((r, i) => {
        out.push(
          `${i + 1}. ${r.customer.name ?? r.customer.phone} — ${money(r.order.totalCents)}\n` +
            `   ${shortLines(r.order.lines)}` +
            (r.customer.addressNote ? `\n   📍 ${r.customer.addressNote}` : "") +
            `\n   ${r.customer.phone}`,
        );
      });
  }

  const grand = confirmed.reduce((s, r) => s + r.order.totalCents, 0);
  out.push("", `*Total: ${plural(confirmed.length, "order")} · ${money(grand)}*`);

  if (drafts.length) {
    out.push("", `*⏳ Not confirmed (${drafts.length})* — not counted above`);
    for (const r of drafts)
      out.push(`• ${r.customer.name ?? r.customer.phone} (${r.customer.area ?? UNASSIGNED}): ${shortLines(r.order.lines)} — ${r.customer.phone}`);
  }
  if (cancelled.length) out.push("", `Cancelled: ${cancelled.length}`);

  const flaggedPhones = new Set(flagged.map((r) => r.customer.phone));
  const handoffList = [...new Map(handoffs.map((h) => [h.phone, h])).values()].filter((h) => !flaggedPhones.has(h.phone));
  if (flagged.length || handoffList.length) {
    out.push("", "*🚩 Needs attention*");
    for (const r of flagged) out.push(`• ${r.customer.name ?? r.customer.phone} — order flagged — ${r.customer.phone}`);
    for (const h of handoffList) out.push(`• ${h.name ?? h.phone} — asked for you: "${(h.body ?? "").slice(0, 80)}" — ${h.phone}`);
  }
  return out.join("\n");
}

/** Short live list for the ORDERS command. */
export function buildOrdersList(menu: Menu, rows: SummaryRow[], cfg: Config): string {
  const active = rows.filter((r) => r.order.status !== "cancelled");
  if (!active.length) return `No orders yet for ${formatDay(menu.date, cfg.tz)}.`;
  const conf = active.filter((r) => r.order.status === "confirmed");
  return (
    `*Orders — ${formatDay(menu.date, cfg.tz)}* (${conf.length} confirmed, ${active.length - conf.length} unconfirmed)\n\n` +
    active
      .map(
        (r) =>
          `${r.order.status === "confirmed" ? "✅" : "⏳"} ${r.customer.name ?? r.customer.phone} (${r.customer.area ?? UNASSIGNED}): ${shortLines(r.order.lines)} — ${money(r.order.totalCents)}`,
      )
      .join("\n")
  );
}
