import { and, count, eq, isNull, ne, or } from "drizzle-orm";
import { customers, kv, type Menu } from "../db/schema";
import type { Ctx } from "../ctx";
import { formatMenuForCustomer } from "../domain/menu";
import { formatClock, formatDay } from "../lib/time";
import { send, sendTemplate, windowOpen } from "../wa/send";

/** Meta's starting limit on business-initiated conversations per 24 h, until the portfolio is upgraded. */
export const STARTER_LIMIT = 250;

export type PushResult = { inChat: number; template: number; notOptedIn: number; already: boolean };

/**
 * Coexistence replacement for broadcast lists: send the published menu to
 * every opted-in customer. Inside their 24 h window they get the menu itself
 * (free); outside it, the utility template, whose "See menu" button opens the
 * window. One send per menu and customer, whatever retries or repeat taps.
 */
export async function pushMenu(ctx: Ctx, menu: Menu): Promise<PushResult> {
  const now = ctx.now();
  const marker = await ctx.db.insert(kv).values({ key: `menu_pushed:${menu.id}`, value: now.toISOString(), updatedAt: now }).onConflictDoNothing().returning();
  const res: PushResult = { inChat: 0, template: 0, notOptedIn: 0, already: !marker.length };

  const [{ n }] = (await ctx.db
    .select({ n: count() })
    .from(customers)
    .where(and(eq(customers.status, "active"), or(isNull(customers.menuOptIn), ne(customers.menuOptIn, true))))) as [{ n: number }];
  res.notOptedIn = n;

  const list = await ctx.db.select().from(customers).where(and(eq(customers.status, "active"), eq(customers.menuOptIn, true)));
  const day = formatDay(menu.date, ctx.cfg.tz);
  const cutoff = formatClock(menu.cutoffAt, ctx.cfg.tz);
  for (const c of list) {
    const key = `menu:${menu.id}:${c.phone}`;
    if (await windowOpen(ctx, c.phone)) {
      await send(ctx, { kind: "text", to: c.phone, body: formatMenuForCustomer(menu, ctx.cfg) }, key);
      res.inChat++;
      continue;
    }
    const name = c.name?.split(" ")[0] || "there";
    await sendTemplate(
      ctx,
      {
        kind: "template",
        to: c.phone,
        name: ctx.cfg.menuTemplate,
        language: ctx.cfg.menuTemplateLang,
        params: [name, day, cutoff],
        buttons: [`menu_see:${menu.id}`, `menu_skip:${menu.id}`],
        body: `Hi ${name}, ordering for ${day} is open until ${cutoff}. [See menu] [Skip today]`,
      },
      key,
    );
    res.template++;
  }
  return res;
}
