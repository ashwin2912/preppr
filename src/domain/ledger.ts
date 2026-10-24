import { and, eq, sql } from "drizzle-orm";
import type { Q } from "../db/client";
import { customers, orders, payments, PAYMENT_METHODS, type PaymentMethod } from "../db/schema";

export type Balance = {
  /** Confirmed orders minus verified payments. Negative = prepaid credit. */
  owedCents: number;
  /** Reported by the customer, not yet verified by the owner. */
  pendingCents: number;
};

const ordersSum = sql<number>`coalesce(sum(${orders.totalCents}), 0)::int`;
const paySum = sql<number>`coalesce(sum(${payments.amountCents}), 0)::int`;

export async function balance(db: Q, phone: string): Promise<Balance> {
  const [o] = await db
    .select({ cents: ordersSum })
    .from(orders)
    .where(and(eq(orders.customerPhone, phone), eq(orders.status, "confirmed")));
  const rows = await db
    .select({ status: payments.status, cents: paySum })
    .from(payments)
    .where(eq(payments.customerPhone, phone))
    .groupBy(payments.status);
  const by = (s: string) => rows.find((r) => r.status === s)?.cents ?? 0;
  return { owedCents: (o?.cents ?? 0) - by("verified"), pendingCents: by("pending") };
}

export type BalanceRow = { phone: string; name: string | null; area: string | null } & Balance;

/** Every customer's balance in one query (DUES, Sheet export). */
export async function allBalances(db: Q): Promise<BalanceRow[]> {
  const res = await db.execute(sql`
    select c.phone, c.name, c.area,
      coalesce((select sum(total_cents) from ${orders} o where o.customer_phone = c.phone and o.status = 'confirmed'), 0)::int
        - coalesce((select sum(amount_cents) from ${payments} p where p.customer_phone = c.phone and p.status = 'verified'), 0)::int as owed,
      coalesce((select sum(amount_cents) from ${payments} p where p.customer_phone = c.phone and p.status = 'pending'), 0)::int as pending
    from ${customers} c
    order by c.name nulls last, c.phone`);
  return ((res as unknown as { rows: unknown[] }).rows as { phone: string; name: string | null; area: string | null; owed: number; pending: number }[]).map((r) => ({
    phone: r.phone,
    name: r.name,
    area: r.area,
    owedCents: Number(r.owed),
    pendingCents: Number(r.pending),
  }));
}

export const dues = async (db: Q) => (await allBalances(db)).filter((b) => b.owedCents > 0);

/** "$20", "20", "20.50", "$1,200" → cents. Null if not a sane amount. */
export function parseAmount(s: string): number | null {
  const m = s.replace(/,/g, "").match(/^\$?(\d{1,5})(?:\.(\d{1,2}))?$/);
  if (!m) return null;
  const cents = Number(m[1]) * 100 + Number((m[2] ?? "0").padEnd(2, "0"));
  return cents > 0 ? cents : null;
}

export function parseMethod(s: string | undefined): PaymentMethod | null {
  const t = s?.trim().toLowerCase();
  if (!t) return null;
  return (PAYMENT_METHODS as readonly string[]).includes(t) ? (t as PaymentMethod) : null;
}

export const methodLabel = (m: PaymentMethod) => (m === "zelle" || m === "venmo" ? m[0]!.toUpperCase() + m.slice(1) : m);
