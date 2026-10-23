import { and, asc, desc, eq, gte, ne } from "drizzle-orm";
import type { Config } from "../config";
import type { Q } from "../db/client";
import { menus, type Menu, type MenuItem } from "../db/schema";
import type { ParsedMenu } from "../llm/types";
import { waLink } from "../lib/phone";
import { formatClock, formatDay, localDate, parseClock, resolveMenuDate, zonedInstant } from "../lib/time";
import { money } from "./order";

export type BuiltMenu = { date: string; cutoffAt: Date; items: MenuItem[]; cutoffWasDefault: boolean };

/** Parsed LLM output -> clean menu with stable ids, real date and cutoff instant. */
export function buildMenu(parsed: ParsedMenu, now: Date, cfg: Config): BuiltMenu {
  const date = resolveMenuDate(parsed.day, now, cfg.tz);
  const parsedCutoff = parsed.cutoff ? parseClock(parsed.cutoff) : null;
  const cutoff = parsedCutoff ?? parseClock(cfg.cutoffTime)!;
  const items: MenuItem[] = [];
  for (const it of parsed.items) {
    const name = it.name.trim();
    if (!name || !Number.isInteger(it.price_cents) || it.price_cents <= 0) continue;
    const aliases = [...new Set([name.toLowerCase(), ...it.aliases.map((a) => a.trim().toLowerCase())])].filter(Boolean);
    items.push({ id: `i${items.length + 1}`, name, price_cents: it.price_cents, aliases });
  }
  return { date, cutoffAt: zonedInstant(date, cutoff, cfg.tz), items, cutoffWasDefault: !parsedCutoff };
}

const itemList = (items: MenuItem[]) => items.map((i) => `• ${i.name} — ${money(i.price_cents)}`).join("\n");

export function formatMenuPreview(m: Pick<Menu, "date" | "cutoffAt" | "items">, cfg: Config, cutoffWasDefault = false) {
  return (
    `*Menu preview — ${formatDay(m.date, cfg.tz)}*\n\n${itemList(m.items)}\n\n` +
    `Cutoff: ${formatClock(m.cutoffAt, cfg.tz)}${cutoffWasDefault ? " (default)" : ""}\n\n` +
    `Tap Publish to open ordering, or Edit to send a corrected MENU.`
  );
}

export function formatMenuForCustomer(m: Menu, cfg: Config) {
  return (
    `*${cfg.kitchenName} — ${formatDay(m.date, cfg.tz)}*\n\n${itemList(m.items)}\n\n` +
    `Order by ${formatClock(m.cutoffAt, cfg.tz)}.\n` +
    `Reply with what you'd like, e.g. *2 ${m.items[0]?.name.toLowerCase() ?? "dal"}, 3 roti*`
  );
}

export function formatBroadcast(m: Menu, cfg: Config) {
  return (
    `🍛 *${cfg.kitchenName} — ${formatDay(m.date, cfg.tz)}*\n\n${itemList(m.items)}\n\n` +
    `Order by ${formatClock(m.cutoffAt, cfg.tz)}.\n` +
    `Tap to order 👉 ${waLink(`+${cfg.botNumber}`, "Order")}`
  );
}

export const ordersOpen = (m: Menu, now: Date) => m.status === "active" && now < m.cutoffAt;

/** The menu customers order against: earliest active menu dated today or later. */
export async function currentMenu(db: Q, now: Date, tz: string): Promise<Menu | null> {
  const [m] = await db
    .select()
    .from(menus)
    .where(and(eq(menus.status, "active"), gte(menus.date, localDate(now, tz))))
    .orderBy(asc(menus.date))
    .limit(1);
  return m ?? null;
}

/** Most relevant published menu for owner commands: today's if any, else the latest. */
export async function ownerMenu(db: Q, now: Date, tz: string): Promise<Menu | null> {
  const today = localDate(now, tz);
  const [t] = await db
    .select()
    .from(menus)
    .where(and(eq(menus.date, today), ne(menus.status, "draft")))
    .limit(1);
  if (t) return t;
  const [latest] = await db.select().from(menus).where(ne(menus.status, "draft")).orderBy(desc(menus.date)).limit(1);
  return latest ?? null;
}
