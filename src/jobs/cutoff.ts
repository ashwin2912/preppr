import { and, eq, gte, isNull, lte } from "drizzle-orm";
import { menus } from "../db/schema";
import type { Deps } from "../flows/router";
import { sendSummary } from "../flows/owner";
import { errFields, log } from "../lib/log";
import { addDays, localDate } from "../lib/time";

/**
 * Runs every few minutes from Cloud Scheduler. Closes menus past their
 * cutoff and sends the owner summary once per menu. Safe to run repeatedly.
 */
export async function runCutoff(deps: Deps) {
  const now = deps.now();
  const closed = await deps.db
    .update(menus)
    .set({ status: "closed" })
    .where(and(eq(menus.status, "active"), lte(menus.cutoffAt, now)))
    .returning({ id: menus.id, date: menus.date });
  if (closed.length) log.info("menus closed", { menus: closed });

  // Recent closed menus whose summary hasn't reached an owner yet.
  const pending = await deps.db
    .select()
    .from(menus)
    .where(
      and(
        eq(menus.status, "closed"),
        isNull(menus.summarySentAt),
        gte(menus.date, addDays(localDate(now, deps.cfg.tz), -1)),
      ),
    );

  const results: { menuId: number; sent: boolean }[] = [];
  for (const m of pending) {
    await deps.db.transaction(async (tx) => {
      // Claim the menu so overlapping runs don't double-send.
      const [claimed] = await tx
        .update(menus)
        .set({ summarySentAt: now })
        .where(and(eq(menus.id, m.id), isNull(menus.summarySentAt)))
        .returning();
      if (!claimed) return;
      const ctx = { ...deps, db: tx, out: { prefix: `cutoff:${m.id}:${now.getTime()}`, n: 0 } };
      let sent = false;
      for (const owner of deps.cfg.ownerNumbers) {
        try {
          sent = (await sendSummary(ctx, owner, claimed)) || sent;
        } catch (e) {
          log.error("summary send failed", { owner, ...errFields(e) });
        }
      }
      // Owner window closed: leave it unsent so a later run (or SUMMARY) can deliver it.
      if (!sent) {
        await tx.update(menus).set({ summarySentAt: null }).where(eq(menus.id, m.id));
        log.warn("cutoff summary not delivered (owner window closed?)", { menuId: m.id });
      }
      results.push({ menuId: m.id, sent });
    });
  }
  return { closed: closed.length, summaries: results };
}
