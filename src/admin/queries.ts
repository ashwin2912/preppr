import { and, desc, eq, gte, inArray, lt } from "drizzle-orm";
import type { Q } from "../db/client";
import { customers, inbox, menus, messages, orders, outbox, payments, waStatuses, type Customer, type Order, type Payment } from "../db/schema";
import { balance, type Balance } from "../domain/ledger";
import { addDays, zonedInstant } from "../lib/time";
import type { Outbound } from "../wa/types";

export type Flag = "handoff" | "model" | "rate_limited" | "blocked" | "paused" | "delivery_failed" | "inbound_failed";

export const FLAG_LABEL: Record<Flag, string> = {
  handoff: "Asked for you",
  model: "Read by AI",
  rate_limited: "Rate-limited",
  blocked: "Blocked",
  paused: "Bot paused",
  delivery_failed: "Reply not delivered",
  inbound_failed: "Bot error",
};

export type ConversationRow = {
  phone: string;
  customer: Customer | null;
  lastAt: Date;
  lastText: string | null;
  inCount: number;
  order: Order | null;
  flags: Flag[];
};

const dayRange = (date: string, tz: string) => ({ from: zonedInstant(date, "00:00", tz), to: zonedInstant(addDays(date, 1), "00:00", tz) });

/** Everyone who messaged the bot on `date` (local), newest activity first. `exclude`: owner numbers. */
export async function listConversations(db: Q, date: string, tz: string, exclude: string[] = []): Promise<ConversationRow[]> {
  const { from, to } = dayRange(date, tz);
  const inbound = (
    await db
      .select()
      .from(messages)
      .where(and(eq(messages.direction, "in"), gte(messages.createdAt, from), lt(messages.createdAt, to)))
      .orderBy(messages.createdAt)
  ).filter((m) => !exclude.includes(m.phone));
  const phones = [...new Set(inbound.map((m) => m.phone))];
  if (!phones.length) return [];

  const custs = new Map((await db.select().from(customers).where(inArray(customers.phone, phones))).map((c) => [c.phone, c]));
  const dayOrders = await db
    .select({ order: orders })
    .from(orders)
    .innerJoin(menus, eq(orders.menuId, menus.id))
    .where(and(eq(menus.date, date), inArray(orders.customerPhone, phones)));
  const orderBy = new Map(dayOrders.map((r) => [r.order.customerPhone, r.order]));

  const outRows = await db
    .select({ to: outbox.to, status: outbox.status, delivery: waStatuses.status })
    .from(outbox)
    .leftJoin(waStatuses, eq(waStatuses.waMessageId, outbox.waMessageId))
    .where(and(inArray(outbox.to, phones), gte(outbox.createdAt, from), lt(outbox.createdAt, to)));
  const undelivered = new Set(outRows.filter((r) => r.status === "failed" || r.delivery === "failed").map((r) => r.to));
  const inboundFailed = new Set(
    (
      await db
        .select({ phone: inbox.phone })
        .from(inbox)
        .where(and(eq(inbox.status, "failed"), inArray(inbox.phone, phones), gte(inbox.createdAt, from), lt(inbox.createdAt, to)))
    ).map((r) => r.phone),
  );

  const rows = new Map<string, ConversationRow>();
  for (const m of inbound) {
    const r = rows.get(m.phone) ?? {
      phone: m.phone,
      customer: custs.get(m.phone) ?? null,
      lastAt: m.createdAt,
      lastText: null,
      inCount: 0,
      order: orderBy.get(m.phone) ?? null,
      flags: [],
    };
    r.inCount++;
    r.lastAt = m.createdAt;
    r.lastText = m.body;
    const add = (f: Flag) => !r.flags.includes(f) && r.flags.push(f);
    if (m.intent === "handoff") add("handoff");
    if (m.parser === "model") add("model");
    if (m.intent === "rate_limited") add("rate_limited");
    if (m.intent === "blocked") add("blocked");
    if (m.intent === "takeover_silent") add("paused");
    rows.set(m.phone, r);
  }
  for (const r of rows.values()) {
    if (undelivered.has(r.phone)) r.flags.push("delivery_failed");
    if (inboundFailed.has(r.phone)) r.flags.push("inbound_failed");
  }
  return [...rows.values()].sort((a, b) => b.lastAt.getTime() - a.lastAt.getTime());
}

/** Flags that mean "worth a human look" (reading by the model alone isn't one). */
export const needsLook = (r: ConversationRow) => r.flags.some((f) => f !== "model");

export type Bubble =
  | { dir: "in"; at: Date; text: string | null; type: string; intent: string | null; parser: string | null }
  | {
      dir: "out";
      at: Date;
      msg: Outbound;
      queue: "pending" | "processing" | "done" | "failed";
      delivery: "sent" | "delivered" | "read" | "failed" | null;
      error: string | null;
    };

export type Transcript = {
  phone: string;
  customer: Customer | null;
  bubbles: Bubble[];
  balance: Balance;
  payments: Payment[];
  recentOrders: { date: string; order: Order }[];
};

/** One customer's messages both ways over the last `days` days. */
export async function transcript(db: Q, phone: string, now: Date, days: number): Promise<Transcript> {
  const since = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const [customer] = await db.select().from(customers).where(eq(customers.phone, phone));
  const ins = await db
    .select()
    .from(messages)
    .where(and(eq(messages.phone, phone), eq(messages.direction, "in"), gte(messages.createdAt, since)));
  // Outbound comes from the outbox, so queued and failed replies show too.
  const outs = await db
    .select({ o: outbox, s: waStatuses })
    .from(outbox)
    .leftJoin(waStatuses, eq(waStatuses.waMessageId, outbox.waMessageId))
    .where(and(eq(outbox.to, phone), gte(outbox.createdAt, since)));
  const bubbles: Bubble[] = [
    ...ins.map((m) => ({ dir: "in" as const, at: m.createdAt, text: m.body, type: m.type, intent: m.intent, parser: m.parser })),
    ...outs.map(({ o, s }) => ({
      dir: "out" as const,
      at: o.createdAt,
      msg: o.payload,
      queue: o.status,
      delivery: s?.status ?? null,
      error: s?.errorText ?? (o.status === "failed" ? o.lastError : null),
    })),
  ].sort((a, b) => a.at.getTime() - b.at.getTime() || (a.dir === b.dir ? 0 : a.dir === "in" ? -1 : 1));

  const recentOrders = (
    await db
      .select({ date: menus.date, order: orders })
      .from(orders)
      .innerJoin(menus, eq(orders.menuId, menus.id))
      .where(eq(orders.customerPhone, phone))
      .orderBy(desc(menus.date))
      .limit(5)
  ).map((r) => ({ date: r.date, order: r.order }));
  const pays = await db.select().from(payments).where(eq(payments.customerPhone, phone)).orderBy(desc(payments.createdAt)).limit(5);
  return { phone, customer: customer ?? null, bubbles, balance: await balance(db, phone), payments: pays, recentOrders };
}
