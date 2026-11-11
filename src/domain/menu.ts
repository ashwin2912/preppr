import { and, asc, desc, eq, gte, ne } from "drizzle-orm";
import type { Config } from "../config";
import type { Q } from "../db/client";
import { menus, type Menu, type MenuItem } from "../db/schema";
import type { ParsedMenu } from "../llm/types";
import { waLink } from "../lib/phone";
import { formatClock, formatDay, localDate, parseClock, resolveMenuDate, zonedInstant } from "../lib/time";
import { money } from "./order";
import { formatSizes, shortMoney } from "./products";

export type BuiltMenu = { date: string; cutoffAt: Date; items: MenuItem[]; cutoffWasDefault: boolean };

/** Parsed LLM items -> clean menu items with stable ids; drops unnamed or unpriced items. */
export function menuItemsFrom(parsed: ParsedMenu): MenuItem[] {
  const items: MenuItem[] = [];
  for (const it of parsed.items) {
    const name = it.name.trim();
    if (!name || !Number.isInteger(it.price_cents) || it.price_cents <= 0) continue;
    const aliases = [...new Set([name.toLowerCase(), ...it.aliases.map((a) => a.trim().toLowerCase())])].filter(Boolean);
    items.push({ id: `i${items.length + 1}`, name, price_cents: it.price_cents, aliases });
  }
  return items;
}

/** Parsed LLM output -> clean menu with stable ids, real date and cutoff instant. */
export function buildMenu(parsed: ParsedMenu, now: Date, cfg: Config): BuiltMenu {
  const date = resolveMenuDate(parsed.day, now, cfg.tz);
  const parsedCutoff = parsed.cutoff ? parseClock(parsed.cutoff) : null;
  const cutoff = parsedCutoff ?? parseClock(cfg.cutoffTime)!;
  return { date, cutoffAt: zonedInstant(date, cutoff, cfg.tz), items: menuItemsFrom(parsed), cutoffWasDefault: !parsedCutoff };
}

const itemList = (items: MenuItem[]) => items.map((i) => `• ${i.name} — ${money(i.price_cents)}`).join("\n");

export function formatMenuPreview(m: Pick<Menu, "date" | "cutoffAt" | "items">, cfg: Config, cutoffWasDefault = false) {
  return (
    `*Menu preview — ${formatDay(m.date, cfg.tz)}*\n\n${itemList(m.items)}\n\n` +
    `Cutoff: ${formatClock(m.cutoffAt, cfg.tz)}${cutoffWasDefault ? " (default)" : ""}\n\n` +
    `Tap Publish, or tell me what to change (e.g. *add samosa*, *no rice*, *cutoff 11*).`
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
    // No prefilled text: the customer already has the menu, so they open the chat and type their order.
    `Tap 👉 ${waLink(`+${cfg.botNumber}`)} and type your order, e.g. *2 ${m.items[0]?.name.toLowerCase() ?? "dal"}, 3 roti*`
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

/** "Dal – 8oz" for a catalog line, the plain name otherwise. */
export const formLabel = (i: MenuItem) => {
  if (!i.size) return i.name;
  const product = i.name.endsWith(` ${i.size}`) ? i.name.slice(0, -i.size.length - 1) : i.name;
  return `${product} – ${i.size}`;
};

/** Broadcast for the WhatsForm flow: dishes grouped with their sizes, cutoff (unless left out), and the form link (or [LINK]). */
export function formatFormBroadcast(m: Pick<Menu, "date" | "cutoffAt" | "items">, cfg: Config, link: string | null, showCutoff = true): string {
  const groups = new Map<string, MenuItem[]>();
  for (const i of m.items) {
    const key = i.product_id !== undefined ? `p${i.product_id}` : i.id;
    groups.set(key, [...(groups.get(key) ?? []), i]);
  }
  const lines = [...groups.values()].map((g) => {
    const first = g[0]!;
    if (!first.size) return `• ${first.name} — ${shortMoney(first.price_cents)}`;
    const name = first.name.endsWith(` ${first.size}`) ? first.name.slice(0, -first.size.length - 1) : first.name;
    return `• ${name} — ${formatSizes(g.map((i) => ({ label: i.size!, price_cents: i.price_cents })))}`;
  });
  return (
    `🍛 *${cfg.kitchenName} — ${formatDay(m.date, cfg.tz)}*\n\n${lines.join("\n")}\n\n` +
    `${showCutoff ? `Order by ${formatClock(m.cutoffAt, cfg.tz)}` : "Order here"} 👉 ${link ?? "[LINK]"}`
  );
}
