import { and, eq, isNull } from "drizzle-orm";
import type { Q } from "../db/client";
import { customerDevices, customers, formResponses, orders, type OrderLine } from "../db/schema";
import { responsesFor } from "./formOrders";

/** One order for the owner's views, whichever way it came in. */
export type DayOrder = {
  /** `o:<orders.id>` or `f:<form_responses.id>`: what the kitchen page's remove/trust buttons post. */
  key: string;
  source: "bot" | "page" | "form";
  name: string | null;
  phone: string | null;
  area: string | null;
  address: string | null;
  note: string | null;
  lines: OrderLine[];
  totalCents: number;
  createdAt: Date;
  /** Reasons the owner should look at it; empty = fine. */
  check: string[];
  /** Page orders from an untrusted device: the kitchen page offers "trust". */
  canTrust: boolean;
};

/**
 * A menu's live orders for the owner (kitchen page, /how /what /orders):
 * confirmed chat/page orders plus active WhatsForm responses, oldest first.
 */
export async function dayOrders(db: Q, menuId: number): Promise<DayOrder[]> {
  const rows = await db
    .select({ order: orders, customer: customers })
    .from(orders)
    .innerJoin(customers, eq(orders.customerPhone, customers.phone))
    .where(and(eq(orders.menuId, menuId), eq(orders.status, "confirmed")));
  const fromOrders: DayOrder[] = rows.map(({ order: o, customer: c }) => ({
    key: `o:${o.id}`,
    source: o.source,
    name: c.name,
    phone: c.phone,
    area: c.area,
    address: o.address ?? c.addressNote,
    note: o.note,
    lines: o.lines,
    totalCents: o.totalCents,
    createdAt: o.createdAt,
    check: o.flagged ? [o.flagReason ?? "flagged by the parser"] : [],
    canTrust: o.flagged && o.source === "page",
  }));
  const fromForms: DayOrder[] = (await responsesFor({ db }, menuId)).map((r) => ({
    key: `f:${r.id}`,
    source: "form",
    name: r.name,
    phone: r.customerPhone,
    area: r.area,
    address: r.address,
    note: r.note,
    lines: r.lines,
    totalCents: r.totalCents,
    createdAt: r.createdAt,
    check: [...r.unmatched, ...(r.lines.length ? [] : ["no dishes matched"])],
    canTrust: false,
  }));
  return [...fromOrders, ...fromForms].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
}

const parseKey = (key: string): { kind: "o" | "f"; id: number } | null => {
  // A bare number is a WhatsForm response (links from before page orders).
  const m = key.match(/^(?:([of]):)?(\d+)$/);
  return m ? { kind: (m[1] as "o" | "f" | undefined) ?? "f", id: Number(m[2]) } : null;
};

/** Owner removes an order from the day. */
export async function cancelDayOrder(db: Q, key: string, now: Date): Promise<boolean> {
  const k = parseKey(key);
  if (!k) return false;
  if (k.kind === "f") {
    const r = await db.update(formResponses).set({ status: "cancelled" }).where(eq(formResponses.id, k.id)).returning({ id: formResponses.id });
    return r.length > 0;
  }
  const r = await db.update(orders).set({ status: "cancelled", updatedAt: now }).where(eq(orders.id, k.id)).returning({ id: orders.id });
  return r.length > 0;
}

/**
 * Owner vouches for a flagged page order: its flag is cleared and the customer's
 * untrusted devices become trusted (they then see their saved details).
 */
export async function trustDayOrder(db: Q, key: string, now: Date): Promise<boolean> {
  const k = parseKey(key);
  if (!k || k.kind !== "o") return false;
  const [o] = await db
    .update(orders)
    .set({ flagged: false, flagReason: null, updatedAt: now })
    .where(and(eq(orders.id, k.id), eq(orders.source, "page")))
    .returning();
  if (!o) return false;
  await db
    .update(customerDevices)
    .set({ trusted: true })
    .where(and(eq(customerDevices.customerPhone, o.customerPhone), eq(customerDevices.trusted, false), isNull(customerDevices.revokedAt)));
  return true;
}
