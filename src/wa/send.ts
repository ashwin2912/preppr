import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { kv, messages, outbox } from "../db/schema";
import type { Q } from "../db/client";
import { log } from "../lib/log";
import type { Ctx } from "../ctx";
import { BODY_MAX } from "./client";
import type { Outbound } from "./types";

export const WINDOW_MS = 24 * 60 * 60 * 1000;

export async function lastInboundAt(db: Q, phone: string): Promise<Date | null> {
  const [row] = await db
    .select({ at: messages.createdAt })
    .from(messages)
    .where(and(eq(messages.phone, phone), eq(messages.direction, "in")))
    .orderBy(desc(messages.createdAt))
    .limit(1);
  return row?.at ?? null;
}

/** Owner and operator numbers: always get messages, whatever the mode. */
export const isStaff = (ctx: Ctx, phone: string) => ctx.cfg.ownerNumbers.includes(phone) || ctx.cfg.operatorNumbers.includes(phone);

export const BOT_OFF_KEY = "bot:off";

/** Owner's kill switch (BOT OFF / BOT ON). */
export async function botOff(ctx: Pick<Ctx, "db">): Promise<boolean> {
  const [row] = await ctx.db.select({ v: kv.value }).from(kv).where(eq(kv.key, BOT_OFF_KEY));
  return row?.v === true;
}

export async function setBotOff(ctx: Pick<Ctx, "db" | "now">, off: boolean) {
  const now = ctx.now();
  if (off) await ctx.db.insert(kv).values({ key: BOT_OFF_KEY, value: true, updatedAt: now }).onConflictDoUpdate({ target: kv.key, set: { value: true, updatedAt: now } });
  else await ctx.db.delete(kv).where(eq(kv.key, BOT_OFF_KEY));
}

/** BOT_MODE, forced to shadow while the owner has the bot off. */
export async function effectiveMode(ctx: Ctx): Promise<Ctx["cfg"]["botMode"]> {
  return (await botOff(ctx)) ? "shadow" : ctx.cfg.botMode;
}

/**
 * Rollout policy, applied to every queued send. Staff always get messages.
 * Customers: live = everything; assist = only what the handler marked safe
 * (`ctx.assist`: a high-confidence order summary and its confirm flow);
 * shadow / BOT OFF = nothing.
 */
export async function replyAllowed(ctx: Ctx, to: string): Promise<boolean> {
  if (isStaff(ctx, to)) return true;
  const mode = await effectiveMode(ctx);
  return mode === "live" || (mode === "assist" && ctx.assist === true);
}

export async function windowOpen(ctx: Ctx, phone: string): Promise<boolean> {
  const at = await lastInboundAt(ctx.db, phone);
  return !!at && ctx.now().getTime() - at.getTime() < WINDOW_MS;
}

/**
 * The only way the bot sends free-form messages. Refuses (and logs) when the
 * recipient's 24h customer-service window is closed. Otherwise queues the
 * message in the outbox, which the worker sends with retries
 * (src/jobs/worker.ts). `key` overrides the `ctx.out` idempotency key, for
 * sends that must dedupe across handlers (menu push). Returns true if queued.
 */
export async function send(ctx: Ctx, msg: Outbound, key?: string): Promise<boolean> {
  if (msg.kind === "template") throw new Error("templates go through sendTemplate");
  if (!(await windowOpen(ctx, msg.to))) {
    log.warn("window_closed: send blocked", { to: msg.to, kind: msg.kind, body: msg.body.slice(0, 200) });
    return false;
  }
  await enqueue(ctx, msg, key);
  return true;
}

/** Queue an approved template. The only send allowed outside the 24h window. */
export async function sendTemplate(ctx: Ctx, msg: Extract<Outbound, { kind: "template" }>, key: string): Promise<void> {
  await enqueue(ctx, msg, key);
}

/** Suppressed sends are stored too (status "suppressed"): REVIEW shows what the bot would have said. */
async function enqueue(ctx: Ctx, msg: Outbound, key?: string) {
  const idemKey = key ?? (ctx.out ? `${ctx.out.prefix}:${ctx.out.n++}` : `adhoc:${randomUUID()}`);
  const now = ctx.now();
  const allowed = await replyAllowed(ctx, msg.to);
  await ctx.db
    .insert(outbox)
    .values({ idemKey, to: msg.to, payload: msg, createdAt: now, nextAttemptAt: now, status: allowed ? "pending" : "suppressed" })
    .onConflictDoNothing();
  if (allowed) ctx.kick?.();
  else log.info("reply suppressed by bot mode", { to: msg.to, kind: msg.kind });
}

export const sendText = (ctx: Ctx, to: string, body: string) => send(ctx, { kind: "text", to, body });

/** Long text split on line boundaries to fit WhatsApp's body limit. */
export async function sendLongText(ctx: Ctx, to: string, body: string): Promise<boolean> {
  let ok = true;
  for (const chunk of splitText(body, BODY_MAX - 96)) ok = (await sendText(ctx, to, chunk)) && ok;
  return ok;
}

export function splitText(body: string, max: number): string[] {
  if (body.length <= max) return [body];
  const out: string[] = [];
  let cur = "";
  for (const line of body.split("\n")) {
    if (cur && cur.length + line.length + 1 > max) {
      out.push(cur);
      cur = "";
    }
    // A single overlong line gets hard-split.
    let l = line;
    while (l.length > max) {
      out.push(l.slice(0, max));
      l = l.slice(max);
    }
    cur = cur ? `${cur}\n${l}` : l;
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Ops alert: an ERROR tagged `alert=<name>` (Sentry), plus a WhatsApp to each
 * OPERATOR_NUMBERS entry whose 24 h window is open (best effort; outside the
 * window only Sentry sees it).
 */
export async function notifyOps(ctx: Ctx, alert: string, body: string, fields: Record<string, unknown> = {}): Promise<void> {
  log.error(body, { alert, ...fields });
  for (const op of ctx.cfg.operatorNumbers) {
    try {
      await sendLongText(ctx, op, `[ops] ${body}`);
    } catch (e) {
      log.warn("ops WhatsApp not queued", { op, error: String(e) });
    }
  }
}

/** Send to every owner number (each gated by its own window). */
export async function notifyOwners(ctx: Ctx, body: string): Promise<void> {
  for (const owner of ctx.cfg.ownerNumbers) await sendLongText(ctx, owner, body);
}
