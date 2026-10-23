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
});

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

export type Customer = typeof customers.$inferSelect;
export type Menu = typeof menus.$inferSelect;
export type Order = typeof orders.$inferSelect;
