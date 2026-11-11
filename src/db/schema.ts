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
  /** Set when the menu was built from the product list: which product and size this line is. */
  product_id?: number;
  size?: string;
};

/** One size of a product with its price. A dish without sizes has one, labelled with its unit ("each"). */
export type ProductSize = { label: string; price_cents: number };

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
  /** Wants the daily "ordering is open" message (coexistence menu push). Null = never asked. */
  menuOptIn: boolean("menu_opt_in"),
  menuOptInAt: ts("menu_opt_in_at"),
  menuOptInAskedAt: ts("menu_opt_in_asked_at"),
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

/** The kitchen's standing product list (dishes and their sizes); daily menus are picked from it. */
export const products = pgTable("products", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  /** Lowercased, single-spaced name: one product per name. */
  nameKey: text("name_key").notNull().unique(),
  sizes: jsonb("sizes_json").$type<ProductSize[]>().notNull(),
  aliases: jsonb("aliases").$type<string[]>().notNull().default([]),
  active: boolean("active").notNull().default(true),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
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

/**
 * One WhatsForm submission (webhook on Submit). Separate from `orders`: a customer
 * can send several forms a day, and lines are matched from form question keys.
 */
export const formResponses = pgTable(
  "form_responses",
  {
    id: serial("id").primaryKey(),
    /** WhatsForm's response number when sent, else a hash of the body: redeliveries dedupe. */
    responseKey: text("response_key").notNull().unique(),
    menuId: integer("menu_id").references(() => menus.id),
    customerPhone: text("customer_phone").references(() => customers.phone),
    name: text("name"),
    area: text("area"),
    address: text("address"),
    note: text("note"),
    lines: jsonb("lines_json").$type<OrderLine[]>().notNull(),
    totalCents: integer("total_cents").notNull(),
    /** Form fields that matched nothing (shown to the owner so the form can be fixed). */
    unmatched: jsonb("unmatched").$type<string[]>().notNull().default([]),
    raw: jsonb("raw").notNull(),
    status: text("status", { enum: ["active", "cancelled"] }).notNull().default("active"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("form_responses_menu").on(t.menuId)],
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
    /** Who read an inbound customer message: the code rules or the model. */
    parser: text("parser", { enum: ["rules", "model"] }),
    /**
     * Outbound: "bot", or "app" when the owner typed it in the WhatsApp
     * Business app (coexistence echo). "history": imported by the one-time
     * history sync, either direction. Null on rows from before this column.
     */
    source: text("source", { enum: ["bot", "app", "history"] }),
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
  /** suppressed (outbox only): blocked by BOT_MODE / BOT OFF; kept for REVIEW, never sent. */
  status: text("status", { enum: ["pending", "processing", "done", "failed", "suppressed"] }).notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  nextAttemptAt: ts("next_attempt_at").notNull().defaultNow(),
  /** Lease while processing; an expired lease means the worker died and the row is claimable again. */
  lockedUntil: ts("locked_until"),
  lastError: text("last_error"),
  createdAt: ts("created_at").notNull().defaultNow(),
});

/**
 * Every webhook body exactly as received, saved before the 200. The worker
 * normalizes it into inbox rows, statuses, echoes, history and contacts.
 * Unknown shapes stay here (shape "unknown") for a person to look at.
 */
export const rawWebhooks = pgTable(
  "raw_webhooks",
  {
    id: serial("id").primaryKey(),
    /** `event:<id>` for 360dialog events, else `sha256:<body hash>` (Meta redelivers identical bodies). */
    dedupeKey: text("dedupe_key").notNull().unique(),
    provider: text("provider").notNull(),
    shape: text("shape", { enum: ["meta_entry", "d360_event", "unknown"] }).notNull(),
    body: jsonb("body_json").notNull(),
    receivedAt: ts("received_at").notNull().defaultNow(),
    ...queueColumns(),
  },
  (t) => [index("raw_webhooks_status_next").on(t.status, t.nextAttemptAt), index("raw_webhooks_received").on(t.receivedAt)],
);

/** Every inbound WhatsApp message, normalized from raw_webhooks by the worker. */
export const inbox = pgTable(
  "inbox",
  {
    id: serial("id").primaryKey(),
    waMessageId: text("wa_message_id").notNull().unique(),
    phone: text("phone").notNull(),
    payload: jsonb("payload_json").$type<InboundMessage>().notNull(),
    /** Sender's WhatsApp profile name, from the webhook's `contacts`. */
    profileName: text("profile_name"),
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

/** The owner's WhatsApp Business app contacts, from the coexistence contact sync. Not customers. */
export const waContacts = pgTable("wa_contacts", {
  phone: text("phone").primaryKey(),
  name: text("name"),
  syncedAt: ts("synced_at").notNull().defaultNow(),
});

/** Small shared key/value store: sync markers, alert dedupe. */
export const kv = pgTable("kv", {
  key: text("key").primaryKey(),
  value: jsonb("value_json").notNull(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export type Customer = typeof customers.$inferSelect;
export type Menu = typeof menus.$inferSelect;
export type Product = typeof products.$inferSelect;
export type FormResponse = typeof formResponses.$inferSelect;
export type Order = typeof orders.$inferSelect;
export type Payment = typeof payments.$inferSelect;
export type InboxRow = typeof inbox.$inferSelect;
export type RawWebhookRow = typeof rawWebhooks.$inferSelect;
export type OutboxRow = typeof outbox.$inferSelect;
