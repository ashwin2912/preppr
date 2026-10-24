import { and, count, eq, gt, gte, isNull, like, lt, lte, ne, notExists, or, inArray } from "drizzle-orm";
import { formatInTimeZone } from "date-fns-tz";
import type { Q } from "../db/client";
import { inbox, kv, menus, outbox, payments, waStatuses } from "../db/schema";
import type { Deps } from "../flows/router";
import { log } from "../lib/log";
import { addDays, localDate, zonedInstant } from "../lib/time";
import { send } from "../wa/send";

export const BACKLOG_MS = 2 * 60 * 1000;
export const SUMMARY_GRACE_MS = 30 * 60 * 1000;
export const UNVERIFIED_MS = 24 * 60 * 60 * 1000;
export const UNDELIVERED_MS = 15 * 60 * 1000;

/** Rows that are due but nobody has picked up for a while: the worker is stuck or down. */
export async function backlog(db: Q, now: Date) {
  const old = new Date(now.getTime() - BACKLOG_MS);
  const stuck = (t: typeof inbox | typeof outbox) =>
    and(
      lt(t.createdAt, old),
      or(
        and(eq(t.status, "pending"), lte(t.nextAttemptAt, old)),
        and(eq(t.status, "processing"), lt(t.lockedUntil, old)),
      ),
    );
  const [i] = (await db.select({ n: count() }).from(inbox).where(stuck(inbox))) as [{ n: number }];
  const [o] = (await db.select({ n: count() }).from(outbox).where(stuck(outbox))) as [{ n: number }];
  return { inbox: Number(i.n), outbox: Number(o.n) };
}

/** True the first time `key` is seen; used to fire each alert once. */
async function firstTime(db: Q, key: string, now: Date): Promise<boolean> {
  const rows = await db.insert(kv).values({ key, value: now.toISOString(), updatedAt: now }).onConflictDoNothing().returning();
  return rows.length > 0;
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * Checks that something should have happened by now. Each problem is logged
 * once as an ERROR tagged `alert=<name>` (Sentry turns that into an alert).
 * Returns the alerts fired on this run.
 */
export async function runWatchdog(deps: Deps): Promise<string[]> {
  const { db, cfg } = deps;
  const now = deps.now();
  const today = localDate(now, cfg.tz);
  const fired: string[] = [];
  const alert = async (name: string, key: string, message: string, fields: Record<string, unknown> = {}) => {
    if (!(await firstTime(db, `alert:${name}:${key}`, now))) return;
    log.error(message, { alert: name, ...fields });
    fired.push(name);
  };

  // Summary not delivered well after cutoff (owner's 24h window probably closed).
  const late = await db
    .select({ id: menus.id, date: menus.date })
    .from(menus)
    .where(
      and(
        eq(menus.status, "closed"),
        isNull(menus.summarySentAt),
        lte(menus.cutoffAt, new Date(now.getTime() - SUMMARY_GRACE_MS)),
        gte(menus.date, addDays(today, -1)),
      ),
    );
  for (const m of late)
    await alert("summary_late", String(m.id), "cutoff summary not delivered 30 min after cutoff", { menuId: m.id, date: m.date });

  // Summary handed to WhatsApp but never reached the owner's phone.
  const [{ n: undelivered }] = (await db
    .select({ n: count() })
    .from(outbox)
    .where(
      and(
        like(outbox.idemKey, "cutoff:%"),
        eq(outbox.status, "done"),
        lt(outbox.sentAt, new Date(now.getTime() - UNDELIVERED_MS)),
        gt(outbox.sentAt, new Date(now.getTime() - UNVERIFIED_MS)),
        notExists(
          db
            .select({ x: waStatuses.waMessageId })
            .from(waStatuses)
            .where(and(eq(waStatuses.waMessageId, outbox.waMessageId), inArray(waStatuses.status, ["delivered", "read"]))),
        ),
      ),
    )) as [{ n: number }];
  if (Number(undelivered) > 0)
    await alert("summary_undelivered", today, "cutoff summary sent but not delivered to the owner's phone after 15 min", {
      messages: Number(undelivered),
    });

  // No menu published by the expected time on a kitchen day.
  const dow = DAY_NAMES[Number(formatInTimeZone(now, cfg.tz, "i")) % 7]!;
  if (cfg.kitchenDays.includes(dow) && now >= zonedInstant(today, cfg.menuExpectedBy, cfg.tz)) {
    const [m] = await db.select({ id: menus.id }).from(menus).where(and(eq(menus.date, today), ne(menus.status, "draft")));
    if (!m) await alert("no_menu", today, `no menu published by ${cfg.menuExpectedBy}`, { date: today });
  }

  // Worker stuck or down.
  const b = await backlog(db, now);
  if (b.inbox || b.outbox) {
    const hour = formatInTimeZone(now, cfg.tz, "yyyy-MM-dd'T'HH");
    await alert("queue_backlog", hour, "messages waiting more than 2 minutes", b);
  }

  // Reported payments nobody has verified for a day: nudge the owner on WhatsApp, once a day.
  const [{ n: unverified }] = (await db
    .select({ n: count() })
    .from(payments)
    .where(and(eq(payments.status, "pending"), lt(payments.createdAt, new Date(now.getTime() - UNVERIFIED_MS))))) as [{ n: number }];
  if (Number(unverified) > 0 && (await firstTime(db, `nudge:payments_unverified:${today}`, now))) {
    for (const owner of cfg.ownerNumbers)
      await send(
        { ...deps, out: { prefix: `watchdog:payments:${today}:${owner}`, n: 0 } },
        { kind: "text", to: owner, body: `💵 ${unverified} reported payment(s) waiting more than a day for you to verify. Send *PENDING* to see them.` },
      );
    fired.push("payments_unverified");
  }
  return fired;
}

