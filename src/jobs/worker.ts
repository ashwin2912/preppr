import { eq } from "drizzle-orm";
import { inbox, messages, outbox, type InboxRow, type OutboxRow } from "../db/schema";
import { handleInbound, inboundFailed, type Deps } from "../flows/router";
import { errFields, log } from "../lib/log";
import { WaSendError } from "../wa/client";
import { claimInbox, claimOutbox } from "./queue";
import { sheetSyncer } from "./sheetSync";
import { runWatchdog } from "./watchdog";

/** Delay before attempt n+1, indexed by attempts so far. Past the end: give up. */
export const INBOX_BACKOFF_MS = [5_000, 30_000];
export const OUTBOX_BACKOFF_MS = [2_000, 5_000, 15_000, 60_000, 180_000];

export const SHEET_SYNC_MS = 30_000;
export const WATCHDOG_MS = 60_000;

export type WorkerOptions = { concurrency?: number; pollMs?: number };

/** Background chores run from the worker loop (not from tick/drain). */
type Periodic = { name: string; everyMs: number; run: () => Promise<void>; last: number };

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 1000);

/**
 * Drains the inbox (customer messages) and outbox (replies) in-process.
 * Everything it needs is in Postgres, so a restart or crash loses nothing:
 * unfinished rows are picked up again once their lease expires.
 */
export function createWorker(deps: Deps, opts: WorkerOptions = {}) {
  const concurrency = opts.concurrency ?? 5;
  const pollMs = opts.pollMs ?? 1000;
  let running = false;
  let loop: Promise<void> | null = null;
  let wake: (() => void) | null = null;
  let kicked = false;

  const periodic: Periodic[] = [];
  const kick = () => {
    kicked = true;
    wake?.();
  };
  const d: Deps = { ...deps, kick };
  periodic.push({ name: "watchdog", everyMs: WATCHDOG_MS, run: async () => void (await runWatchdog(d)), last: 0 });
  if (d.sheets) periodic.push({ name: "sheet_sync", everyMs: SHEET_SYNC_MS, run: sheetSyncer(d), last: 0 });

  async function runPeriodic() {
    const t = Date.now();
    for (const p of periodic) {
      if (t - p.last < p.everyMs) continue;
      p.last = t;
      await p.run().catch((e) => log.error("periodic task failed", { task: p.name, ...errFields(e) }));
    }
  }

  async function inboxRow(row: InboxRow) {
    try {
      await handleInbound(d, row);
      await d.db.update(inbox).set({ status: "done", lockedUntil: null }).where(eq(inbox.id, row.id));
    } catch (e) {
      const delay = INBOX_BACKOFF_MS[row.attempts - 1];
      if (delay !== undefined) {
        log.warn("inbound failed, will retry", { id: row.waMessageId, phone: row.phone, attempt: row.attempts, ...errFields(e) });
        await d.db
          .update(inbox)
          .set({ status: "pending", lockedUntil: null, lastError: errText(e), nextAttemptAt: new Date(d.now().getTime() + delay) })
          .where(eq(inbox.id, row.id));
        return;
      }
      log.error("inbound dead-lettered", { alert: "inbound_dead", id: row.waMessageId, phone: row.phone, attempts: row.attempts, ...errFields(e) });
      await d.db.update(inbox).set({ status: "failed", lockedUntil: null, lastError: errText(e) }).where(eq(inbox.id, row.id));
      await inboundFailed(d, row).catch((e2) => log.error("failure notice not queued", errFields(e2)));
    }
  }

  async function outboxRow(row: OutboxRow) {
    let waId: string;
    try {
      waId = await d.wa.send(row.payload);
    } catch (e) {
      // Network errors (fetch TypeError) are worth retrying; Graph 4xx mostly aren't.
      const retryable = e instanceof WaSendError ? e.retryable : true;
      const delay = retryable ? OUTBOX_BACKOFF_MS[row.attempts - 1] : undefined;
      if (delay !== undefined) {
        log.warn("send failed, will retry", { to: row.to, key: row.idemKey, attempt: row.attempts, ...errFields(e) });
        await d.db
          .update(outbox)
          .set({ status: "pending", lockedUntil: null, lastError: errText(e), nextAttemptAt: new Date(d.now().getTime() + delay) })
          .where(eq(outbox.id, row.id));
      } else {
        log.error("send dead-lettered", { alert: "send_dead", to: row.to, key: row.idemKey, attempts: row.attempts, retryable, ...errFields(e) });
        await d.db.update(outbox).set({ status: "failed", lockedUntil: null, lastError: errText(e) }).where(eq(outbox.id, row.id));
      }
      return;
    }
    const now = d.now();
    await d.db
      .update(outbox)
      .set({ status: "done", lockedUntil: null, waMessageId: waId, sentAt: now })
      .where(eq(outbox.id, row.id));
    const msg = row.payload;
    await d.db
      .insert(messages)
      .values({ waMessageId: waId, phone: msg.to, direction: "out", type: msg.kind, body: msg.body, raw: msg, createdAt: now })
      .onConflictDoNothing();
  }

  /** One round: claim and process what's due. Returns how many rows it handled. */
  async function tick(): Promise<number> {
    const now = d.now();
    const ins = await claimInbox(d.db, now, concurrency);
    await Promise.all(ins.map(inboxRow));
    const outs = await claimOutbox(d.db, d.now(), concurrency);
    await Promise.all(outs.map(outboxRow));
    return ins.length + outs.length;
  }

  /** Process until nothing is due (tests, simulator). */
  async function drain() {
    while ((await tick()) > 0);
  }

  function start() {
    if (running) return;
    running = true;
    loop = (async () => {
      while (running) {
        let n = 0;
        kicked = false;
        try {
          n = await tick();
        } catch (e) {
          log.error("worker tick failed", errFields(e));
        }
        await runPeriodic();
        if (n === 0 && running && !kicked)
          await new Promise<void>((resolve) => {
            const t = setTimeout(resolve, pollMs);
            wake = () => {
              clearTimeout(t);
              resolve();
            };
          });
        wake = null;
      }
    })();
  }

  /** Stop claiming new rows and wait for in-flight work to finish. */
  async function stop() {
    running = false;
    kick();
    await loop;
  }

  return { tick, drain, start, stop, kick };
}

export type Worker = ReturnType<typeof createWorker>;
