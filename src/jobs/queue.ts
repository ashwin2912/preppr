import { sql } from "drizzle-orm";
import type { DB } from "../db/client";
import { inbox, outbox, type InboxRow, type OutboxRow } from "../db/schema";

export const LEASE_MS = 2 * 60 * 1000;

type Queue = typeof inbox | typeof outbox;

// One advisory lock per queue serializes claiming across instances. Claims are a
// single short UPDATE, so this costs nothing and keeps the per-key rule exact.
const CLAIM_LOCK = { inbox: 7_401_001, outbox: 7_401_002 } as const;

/**
 * Claim up to `limit` due rows, at most one per key (phone for the inbox,
 * recipient for the outbox), and only the oldest unfinished row for that key.
 * That keeps each customer's messages strictly in order and never handled
 * twice at once. A row whose lease expired (worker crashed) is claimable again.
 */
async function claim(db: DB, table: Queue, name: keyof typeof CLAIM_LOCK, key: string, now: Date, limit: number) {
  const t = sql.identifier(name);
  const k = sql.identifier(key);
  const lease = new Date(now.getTime() + LEASE_MS);
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${CLAIM_LOCK[name]})`);
    return tx
      .update(table)
      .set({ status: "processing", lockedUntil: lease, attempts: sql`${table.attempts} + 1` })
      .where(
        sql`${table.id} in (
          select id from (
            select distinct on (${k}) id, status, next_attempt_at, locked_until, created_at
            from ${t}
            where status in ('pending', 'processing')
            order by ${k}, created_at, id
          ) head
          where (head.status = 'pending' and head.next_attempt_at <= ${now.toISOString()}::timestamptz)
             or (head.status = 'processing' and head.locked_until <= ${now.toISOString()}::timestamptz)
          order by head.created_at, head.id
          limit ${limit}
        )`,
      )
      .returning();
  });
}

export const claimInbox = (db: DB, now: Date, limit: number) =>
  claim(db, inbox, "inbox", "phone", now, limit) as Promise<InboxRow[]>;

export const claimOutbox = (db: DB, now: Date, limit: number) =>
  claim(db, outbox, "outbox", "to", now, limit) as Promise<OutboxRow[]>;
