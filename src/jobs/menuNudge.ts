import { formatInTimeZone } from "date-fns-tz";
import { and, desc, eq, lt, ne } from "drizzle-orm";
import { kvFirstTime } from "../db/kv";
import { menus, products } from "../db/schema";
import type { Deps } from "../flows/router";
import { log } from "../lib/log";
import { formatDay, localDate, zonedInstant } from "../lib/time";
import { send, windowOpen } from "../wa/send";
import { picksFromMenu, describePicks } from "../domain/products";

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/** Only nudge in the first hours after MENU_EXPECTED_BY, never late in the evening. */
const NUDGE_FOR_MS = 3 * 60 * 60 * 1000;

/**
 * Kitchen day, MENU_EXPECTED_BY passed and no menu (not even a draft): ask each
 * owner whose 24 h window is open what's on today, with "Same as <day>". Once
 * per owner per day; owners whose window is closed are skipped (no template).
 * Returns the owners nudged.
 */
export async function runMenuNudge(deps: Deps): Promise<string[]> {
  const { db, cfg } = deps;
  const now = deps.now();
  const today = localDate(now, cfg.tz);
  const dow = DAY_NAMES[Number(formatInTimeZone(now, cfg.tz, "i")) % 7]!;
  const from = zonedInstant(today, cfg.menuExpectedBy, cfg.tz);
  if (!cfg.kitchenDays.includes(dow) || now < from || now.getTime() - from.getTime() > NUDGE_FOR_MS) return [];
  const [exists] = await db.select({ id: menus.id }).from(menus).where(eq(menus.date, today));
  if (exists) return [];

  const [last] = await db.select().from(menus).where(and(lt(menus.date, today), ne(menus.status, "draft"))).orderBy(desc(menus.date)).limit(1);
  const list = await db.select().from(products).where(eq(products.active, true));
  const lastDishes = last ? describePicks(picksFromMenu(last.items, list).picks) : "";
  const lastDay = last ? formatInTimeZone(new Date(`${last.date}T12:00:00Z`), "UTC", "EEE") : "";

  const nudged: string[] = [];
  for (const owner of cfg.ownerNumbers) {
    const ctx = { ...deps, out: { prefix: `menu_nudge:${today}:${owner}`, n: 0 } };
    if (!(await windowOpen(ctx, owner))) {
      log.info("menu nudge skipped: window closed", { date: today });
      continue;
    }
    if (!(await kvFirstTime(db, `menu_nudge:${today}:${owner}`, now))) continue;
    if (lastDishes) {
      await send(ctx, {
        kind: "buttons",
        to: owner,
        body: `Good morning! What's on today (${formatDay(today, cfg.tz)})?\n\nLast time (${lastDay}): ${lastDishes}\n\nTap *Same as ${lastDay}*, or type the dishes, e.g. *today dal, paneer, roti*.`,
        buttons: [
          { id: `menu_copy:${last!.id}`, title: `Same as ${lastDay}` },
          { id: "show_products:", title: "Show my dishes" },
        ],
      });
    } else if (list.length) {
      await send(ctx, {
        kind: "buttons",
        to: owner,
        body: `Good morning! What's on today (${formatDay(today, cfg.tz)})? Type the dishes, e.g. *today dal, paneer, roti*, or the numbers from your list.`,
        buttons: [{ id: "show_products:", title: "Show my dishes" }],
      });
    } else {
      await send(ctx, {
        kind: "text",
        to: owner,
        body: `Good morning! What's on today? First tell me your dishes with prices, e.g. *add dal 8oz 6, 16oz 10*, then *today dal, roti*.`,
      });
    }
    nudged.push(owner);
  }
  deps.kick?.();
  return nudged;
}
