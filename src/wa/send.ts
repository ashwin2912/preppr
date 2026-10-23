import { and, desc, eq } from "drizzle-orm";
import { messages } from "../db/schema";
import type { Q } from "../db/client";
import { errFields, log } from "../lib/log";
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

export async function windowOpen(ctx: Ctx, phone: string): Promise<boolean> {
  const at = await lastInboundAt(ctx.db, phone);
  return !!at && ctx.now().getTime() - at.getTime() < WINDOW_MS;
}

/**
 * The only way the bot sends anything. Refuses (and logs) when the
 * recipient's 24h customer-service window is closed, since the MVP sends
 * no templates. Returns true if sent.
 */
export async function send(ctx: Ctx, msg: Outbound): Promise<boolean> {
  if (!(await windowOpen(ctx, msg.to))) {
    log.warn("window_closed: send blocked", { to: msg.to, kind: msg.kind, body: msg.body.slice(0, 200) });
    return false;
  }
  try {
    const id = await ctx.wa.send(msg);
    await ctx.db
      .insert(messages)
      .values({
        waMessageId: id,
        phone: msg.to,
        direction: "out",
        type: msg.kind,
        body: msg.body,
        raw: msg,
        createdAt: ctx.now(),
      })
      .onConflictDoNothing();
    return true;
  } catch (e) {
    log.error("send failed", { to: msg.to, ...errFields(e) });
    return false;
  }
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

/** Send to every owner number (each gated by its own window). */
export async function notifyOwners(ctx: Ctx, body: string): Promise<void> {
  for (const owner of ctx.cfg.ownerNumbers) await sendLongText(ctx, owner, body);
}
