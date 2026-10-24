import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  serial,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import type { InboundMessage, Outbound } from "../wa/types";

export type MenuItem = {
  id: string;
  name: string;
  price_cents: number;
  aliases: string[];
};

export type OrderLine = {
  item_id: string;
  name: string;
  qty: number;
  unit_cents: number;
  note: string | null;
};

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const customers = pgTable("customers", {
  phone: text("phone").primaryKey(),
  name: text("name"),
  area: text("area"),
  addressNote: text("address_note"),
  createdAt: ts("created_at").notNull().defaultNow(),
  lastInboundAt: ts("last_inbound_at"),
  humanTakeoverUntil: ts("human_takeover_until"),
  /** blocked: bot ignores them silently. */
  status: text("status", { enum: ["active", "blocked"] }).notNull().default("active"),
  /** Owner's free-text notes ("leave at side door"). */
  notes: text("notes"),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const PAYMENT_METHODS = ["zelle", "venmo", "cash", "card", "other"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

/**
 * Payment ledger. Balance owed = confirmed order totals − verified payments
 * (negative = prepaid credit). Customer-reported payments start as pending
 * until the owner verifies them.
 */
export const payments = pgTable(
  "payments",
  {
    id: serial("id").primaryKey(),
    customerPhone: text("customer_phone")
      .notNull()
      .references(() => customers.phone),
    amountCents: integer("amount_cents").notNull(),
    method: text("method", { enum: PAYMENT_METHODS }).notNull(),
    status: text("status", { enum: ["pending", "verified", "rejected"] }).notNull().default("pending"),
    source: text("source", { enum: ["customer", "owner"] }).notNull(),
    /** The customer's message that reported it, if any. */
    messageId: text("message_id").unique(),
    note: text("note"),
    createdAt: ts("created_at").notNull().defaultNow(),
    verifiedAt: ts("verified_at"),
    /** Owner number that verified or rejected it. */
    verifiedBy: text("verified_by"),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("payments_customer").on(t.customerPhone), index("payments_status").on(t.status)],
);

export const menus = pgTable("menus", {
  id: serial("id").primaryKey(),
  date: text("date").notNull().unique(),
  items: jsonb("items_json").$type<MenuItem[]>().notNull(),
  cutoffAt: ts("cutoff_at").notNull(),
  status: text("status", { enum: ["draft", "active", "closed"] }).notNull().default("draft"),
  summarySentAt: ts("summary_sent_at"),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const orders = pgTable(
  "orders",
  {
    id: serial("id").primaryKey(),
    menuId: integer("menu_id")
      .notNull()
      .references(() => menus.id),
    customerPhone: text("customer_phone")
      .notNull()
      .references(() => customers.phone),
    lines: jsonb("lines_json").$type<OrderLine[]>().notNull(),
    totalCents: integer("total_cents").notNull(),
    status: text("status", { enum: ["draft", "confirmed", "cancelled"] })
      .notNull()
      .default("draft"),
    confidence: real("confidence"),
    flagged: boolean("flagged").notNull().default(false),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [unique("orders_menu_customer").on(t.menuId, t.customerPhone)],
);

export const messages = pgTable(
  "messages",
  {
    waMessageId: text("wa_message_id").primaryKey(),
    phone: text("phone").notNull(),
    direction: text("direction", { enum: ["in", "out"] }).notNull(),
    type: text("type").notNull(),
    body: text("body"),
    raw: jsonb("raw_json"),
    intent: text("intent"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("messages_phone_dir_created").on(t.phone, t.direction, t.createdAt)],
);

export const conversationState = pgTable("conversation_state", {
  phone: text("phone").primaryKey(),
  state: text("state").notNull().default("idle"),
  context: jsonb("context_json").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

/** Status + retry bookkeeping shared by the inbox and outbox queues. */
const queueColumns = () => ({
  status: text("status", { enum: ["pending", "processing", "done", "failed"] }).notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  nextAttemptAt: ts("next_attempt_at").notNull().defaultNow(),
  /** Lease while processing; an expired lease means the worker died and the row is claimable again. */
  lockedUntil: ts("locked_until"),
  lastError: text("last_error"),
  createdAt: ts("created_at").notNull().defaultNow(),
});

/** Every inbound WhatsApp message, saved before the webhook returns 200. */
export const inbox = pgTable(
  "inbox",
  {
    id: serial("id").primaryKey(),
    waMessageId: text("wa_message_id").notNull().unique(),
    phone: text("phone").notNull(),
    payload: jsonb("payload_json").$type<InboundMessage>().notNull(),
    ...queueColumns(),
  },
  (t) => [index("inbox_status_next").on(t.status, t.nextAttemptAt), index("inbox_phone_created").on(t.phone, t.createdAt)],
);

/** Every outbound WhatsApp message, sent by the worker with retries. */
export const outbox = pgTable(
  "outbox",
  {
    id: serial("id").primaryKey(),
    /** `<inbound wamid>:<n>` etc., so a retried handler can't queue the same reply twice. */
    idemKey: text("idem_key").notNull().unique(),
    to: text("to").notNull(),
    payload: jsonb("payload_json").$type<Outbound>().notNull(),
    ...queueColumns(),
    waMessageId: text("wa_message_id"),
    sentAt: ts("sent_at"),
  },
  (t) => [
    index("outbox_status_next").on(t.status, t.nextAttemptAt),
    index("outbox_to_created").on(t.to, t.createdAt),
    index("outbox_wa_message_id").on(t.waMessageId),
  ],
);

/**
 * Latest delivery status Meta reported for each outbound message. Its own
 * table (not outbox columns) because a status can arrive before the worker
 * has recorded the message id.
 */
export const waStatuses = pgTable("wa_statuses", {
  waMessageId: text("wa_message_id").primaryKey(),
  recipient: text("recipient").notNull(),
  status: text("status", { enum: ["sent", "delivered", "read", "failed"] }).notNull(),
  errorCode: integer("error_code"),
  errorText: text("error_text"),
  statusAt: ts("status_at").notNull(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

/** Small shared key/value store: sync markers, alert dedupe. */
export const kv = pgTable("kv", {
  key: text("key").primaryKey(),
  value: jsonb("value_json").notNull(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export type Customer = typeof customers.$inferSelect;
export type Menu = typeof menus.$inferSelect;
export type Order = typeof orders.$inferSelect;
export type Payment = typeof payments.$inferSelect;
export type InboxRow = typeof inbox.$inferSelect;
export type OutboxRow = typeof outbox.$inferSelect;
