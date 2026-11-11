import { and, asc, eq, gt, gte } from "drizzle-orm";
import { formatInTimeZone } from "date-fns-tz";
import type { Hono } from "hono";
import type { Q } from "../db/client";
import { menus, type Menu, type MenuItem } from "../db/schema";
import { shortMoney } from "../domain/products";
import { formatDay, localDate } from "../lib/time";
import { errFields, log } from "../lib/log";
import type { Deps } from "./router";
import { FORM_SCRIPT } from "./formScript";

/** The menu the order form shows: the earliest published menu, today or later, still before its cutoff. */
export async function orderableMenu(db: Q, now: Date, tz: string): Promise<Menu | null> {
  const [m] = await db
    .select()
    .from(menus)
    .where(and(eq(menus.status, "active"), gte(menus.date, localDate(now, tz)), gt(menus.cutoffAt, now)))
    .orderBy(asc(menus.date))
    .limit(1);
  return m ?? null;
}

const dishName = (i: MenuItem) => (i.size && i.name.endsWith(` ${i.size}`) ? i.name.slice(0, -i.size.length - 1) : i.name);

export type PublicMenu = {
  kitchen: string;
  open: boolean;
  date: string | null;
  day: string | null;
  cutoff: string | null;
  dishes: { name: string; sizes: { id: string; label: string | null; name: string; price_cents: number; price: string }[] }[];
};

/** What the order form needs, and nothing else: no customer data. Sizes keep menu order; `name` is what the form writes back. */
export function publicMenu(m: Menu | null, kitchen: string, tz: string): PublicMenu {
  if (!m) return { kitchen, open: false, date: null, day: null, cutoff: null, dishes: [] };
  const groups = new Map<string, PublicMenu["dishes"][number]>();
  for (const i of m.items) {
    const key = i.product_id !== undefined ? `p${i.product_id}` : i.id;
    const g = groups.get(key) ?? { name: dishName(i), sizes: [] };
    // "Roti" with size "each" is one line with no size to pick.
    const plain = !i.size || !i.name.endsWith(` ${i.size}`);
    g.sizes.push({ id: i.id, label: plain ? null : i.size!, name: i.name, price_cents: i.price_cents, price: shortMoney(i.price_cents) });
    groups.set(key, g);
  }
  // Menus from the kitchen page run to 23:59: no cutoff worth showing.
  const clock = formatInTimeZone(m.cutoffAt, tz, "HH:mm");
  return {
    kitchen,
    open: true,
    date: m.date,
    day: formatDay(m.date, tz),
    cutoff: clock === "23:59" ? null : formatInTimeZone(m.cutoffAt, tz, "h:mm a"),
    dishes: [...groups.values()],
  };
}

/**
 * Public, read-only routes for the WhatsForm order form: GET /public/menu.json
 * (today's dishes, sizes, prices) and GET /wf.js (the script pasted once into
 * WhatsForm's Custom Script, which draws the menu and fills the "Your order" question).
 */
export function registerFormMenu(app: Hono, deps: Deps) {
  app.get("/public/menu.json", async (c) => {
    c.header("access-control-allow-origin", "*");
    c.header("cache-control", "no-store");
    try {
      const m = await orderableMenu(deps.db, deps.now(), deps.cfg.tz);
      return c.json(publicMenu(m, deps.cfg.kitchenName, deps.cfg.tz));
    } catch (e) {
      log.error("public menu failed", errFields(e));
      return c.json({ error: "unavailable" }, 503);
    }
  });
  app.get("/wf.js", (c) => {
    c.header("content-type", "application/javascript; charset=utf-8");
    c.header("cache-control", "public, max-age=300");
    c.header("access-control-allow-origin", "*");
    return c.body(FORM_SCRIPT);
  });
}
