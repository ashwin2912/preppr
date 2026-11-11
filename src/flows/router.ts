import { and, count, eq, gte } from "drizzle-orm";
import type { DB } from "../db/client";
import { customers, inbox, messages, rawWebhooks, type InboxRow, type RawWebhookRow } from "../db/schema";
import type { Ctx } from "../ctx";
import { log } from "../lib/log";
import { normalizePhone } from "../lib/phone";
import { effectiveMode, isStaff, notifyOps, sendText } from "../wa/send";
import { recordStatuses } from "../wa/statuses";
import { type Incoming, type InboundMessage } from "../wa/types";
import { dedupeKey, detectShape, normalizeInbound, type InboundEvent } from "../wa/normalize";
import { handleCustomer, sendMenu } from "./customer";
import { asksToOrder, handleOnboarding, needsOnboarding } from "./onboarding";
import { recordContacts, recordEchoes, recordHistory } from "./coexistence";
import { handleOwner } from "./owner";
import { pingHeld } from "./review";
import { forwardToOwner } from "./handoff";
import { getState, tagIntent } from "./state";
import { ParserUnavailable } from "../llm/types";
import { currentMenu, ordersOpen } from "../domain/menu";

export type Deps = Omit<Ctx, "db"> & { db: DB };

export function toIncoming(m: InboundMessage, phone: string): Incoming {
  const reply = m.interactive?.button_reply ?? m.interactive?.list_reply;
  return {
    id: m.id,
    phone,
    type: m.type,
    text: m.text?.body ?? reply?.title ?? m.button?.text ?? "",
    replyId: reply?.id ?? m.button?.payload ?? null,
    raw: m,
  };
}

/**
 * Webhook side: save the body exactly as received. Must finish before the
 * webhook returns 200; a throw means "not saved" and the webhook returns 500
 * so the provider redelivers. Duplicate deliveries stop at the dedupe key.
 * Returns true if this delivery is new.
 */
export async function storeWebhook(deps: Deps, raw: string, body: unknown): Promise<boolean> {
  const now = deps.now();
  const inserted = await deps.db
    .insert(rawWebhooks)
    .values({ dedupeKey: dedupeKey(body, raw), provider: deps.cfg.waProvider, shape: detectShape(body), body: body as object, receivedAt: now, createdAt: now, nextAttemptAt: now })
    .onConflictDoNothing()
    .returning({ id: rawWebhooks.id });
  if (!inserted.length) log.info("duplicate webhook ignored");
  return inserted.length > 0;
}

/** Worker side: one stored webhook body → inbox rows, statuses, echoes, history, contacts. */
export async function processWebhook(deps: Deps, row: RawWebhookRow): Promise<number> {
  return applyEvents(deps, normalizeInbound(row.body), row.receivedAt, row.id);
}

/**
 * Acts on normalized events. Every step is idempotent (unique wamids, upserts),
 * so a retried webhook row or a re-imported file changes nothing twice.
 * Returns how many customer messages were queued.
 */
export async function applyEvents(deps: Deps, events: InboundEvent[], receivedAt: Date, rawId?: number): Promise<number> {
  let queued = 0;
  for (const ev of events) {
    switch (ev.kind) {
      case "message":
        if (await enqueueMessage(deps, ev.message, ev.profileName, receivedAt)) queued++;
        break;
      case "status":
        await recordStatuses(deps, ev.statuses);
        break;
      case "echo":
        await recordEchoes(deps, ev.echoes);
        break;
      case "history_batch":
        await recordHistory(deps, ev.chunks);
        break;
      case "contacts_sync":
        await recordContacts(deps, ev.items);
        break;
      case "history_declined":
        await notifyOps(
          { ...deps, out: { prefix: `ops:history_declined:${rawId ?? receivedAt.getTime()}`, n: 0 } },
          "history_declined",
          "⚠️ WhatsApp history sync was declined in the Business app (error 2593109). Past chats won't be imported; use pnpm import:chat-export if needed.",
        );
        break;
      case "ignored":
        log.info("ignored webhook field", { field: ev.field });
        break;
      case "unknown":
        log.error("unrecognized webhook payload kept in raw_webhooks", { alert: "webhook_unknown_shape", rawId, reason: ev.reason });
        break;
    }
  }
  return queued;
}

/** One customer message into the inbox, stamped with webhook receipt time (exact 24 h window). */
async function enqueueMessage(deps: Deps, m: InboundMessage, profileName: string | null, receivedAt: Date): Promise<boolean> {
  const phone = normalizePhone(m.from);
  if (!phone) {
    log.warn("bad sender number", { from: m.from });
    return false;
  }
  const inserted = await deps.db
    .insert(inbox)
    .values({ waMessageId: m.id, phone, payload: m, profileName, createdAt: receivedAt, nextAttemptAt: deps.now() })
    .onConflictDoNothing()
    .returning({ id: inbox.id });
  if (!inserted.length) log.info("duplicate delivery ignored", { id: m.id });
  return inserted.length > 0;
}

export const RATE_LIMIT = { max: 20, windowMs: 10 * 60 * 1000 };

/**
 * Worker side: handle one claimed inbox row. The worker guarantees one row per
 * phone at a time, in arrival order, so no long transaction or lock is held
 * here (the model call can take seconds). Throws to ask the worker to retry.
 */
export async function handleInbound(deps: Deps, row: InboxRow) {
  const msg = toIncoming(row.payload, row.phone);
  const phone = row.phone;

  // Retries find this row already there. Stamped with receipt time so the 24h window is exact.
  await deps.db
    .insert(messages)
    .values({
      waMessageId: msg.id,
      phone,
      direction: "in",
      type: msg.type,
      body: msg.text || null,
      raw: row.payload,
      createdAt: row.createdAt,
    })
    .onConflictDoNothing();

  const ctx: Ctx = { ...deps, out: { prefix: msg.id, n: 0 } };

  if (!ctx.cfg.ownerNumbers.includes(phone)) {
    const since = new Date(row.createdAt.getTime() - RATE_LIMIT.windowMs);
    const [{ n }] = (await deps.db
      .select({ n: count() })
      .from(messages)
      .where(and(eq(messages.phone, phone), eq(messages.direction, "in"), gte(messages.createdAt, since)))) as [{ n: number }];
    if (n > RATE_LIMIT.max) {
      log.warn("rate limited", { phone, n });
      await tagIntent(ctx, msg.id, "rate_limited");
      return;
    }
  }

  await route(ctx, msg, row.profileName, row.attempts === 1);
  await pingHeld(ctx, phone, msg.id);
}

/** Called once an inbox row has used up its retries. */
export async function inboundFailed(deps: Deps, row: InboxRow, error?: unknown) {
  const ctx: Ctx = { ...deps, out: { prefix: `${row.waMessageId}:failed`, n: 0 } };
  if (error instanceof ParserUnavailable) {
    // The model is down: a person reads it instead of the customer retyping into the void.
    const [c] = await deps.db.select().from(customers).where(eq(customers.phone, row.phone));
    await forwardToOwner(ctx, c ?? null, toIncoming(row.payload, row.phone), "Bot couldn't read this (parser down), please reply by hand");
    await sendText(ctx, row.phone, "Sorry, I'm having trouble reading messages right now. I've passed yours to the kitchen and they'll reply shortly 🙏");
    return;
  }
  await sendText(ctx, row.phone, "Sorry, something went wrong on our side. Please try again in a minute 🙏");
}

async function route(ctx: Ctx, msg: Incoming, profileName: string | null, firstAttempt: boolean) {
  // Only once the bot will answer: with a shared number, an unread chat is the owner's cue.
  const markRead = async () => {
    if (!firstAttempt) return;
    // Shadow/assist/BOT OFF: leave the chat unread so the owner sees it in the app.
    if (!isStaff(ctx, msg.phone) && (await effectiveMode(ctx)) !== "live") return;
    void ctx.wa.markReadTyping(msg.id);
  };
  if (ctx.cfg.ownerNumbers.includes(msg.phone)) {
    await markRead();
    return handleOwner(ctx, msg);
  }

  if (ctx.cfg.ownerOnly) {
    log.info("owner-only mode, not an owner", { phone: msg.phone });
    await tagIntent(ctx, msg.id, "owner_only_ignored");
    return;
  }

  const now = ctx.now();
  await ctx.db.update(customers).set({ lastInboundAt: now }).where(eq(customers.phone, msg.phone));
  let [customer] = await ctx.db.select().from(customers).where(eq(customers.phone, msg.phone));

  if (customer?.status === "blocked") {
    await ctx.db.update(messages).set({ intent: "blocked" }).where(eq(messages.waMessageId, msg.id));
    return;
  }

  if (customer?.humanTakeoverUntil && customer.humanTakeoverUntil > now) {
    log.info("takeover active, bot silent", { phone: msg.phone });
    await ctx.db.update(messages).set({ intent: "takeover_silent" }).where(eq(messages.waMessageId, msg.id));
    return;
  }

  const st = await getState(ctx, msg.phone);
  // On a shared number, friends and suppliers write too: only numbers asking to order get sign-up.
  if (!customer && ctx.cfg.unknownSenders === "order_only" && !st.state.startsWith("onboarding_") && !asksToOrder(msg)) {
    log.info("unknown sender, bot silent", { phone: msg.phone });
    await tagIntent(ctx, msg.id, "unknown_silent");
    return;
  }
  await markRead();

  // Known customers imported without a name get their WhatsApp profile name.
  if (customer && !customer.name && profileName) {
    [customer] = await ctx.db
      .update(customers)
      .set({ name: profileName, updatedAt: now })
      .where(eq(customers.phone, msg.phone))
      .returning();
  }

  if (needsOnboarding(customer ?? null) || st.state.startsWith("onboarding_")) {
    const done = await handleOnboarding(ctx, msg, customer ?? null, st);
    if (!done) return;
    const menu = await currentMenu(ctx.db, now, ctx.cfg.tz);
    if (menu && ordersOpen(menu, now)) await sendMenu(ctx, msg.phone, menu);
    else await sendText(ctx, msg.phone, "Ordering is closed right now — the menu comes out each morning 🙏");
    return;
  }
  [customer] = await ctx.db.select().from(customers).where(eq(customers.phone, msg.phone));
  await handleCustomer(ctx, msg, customer!, st);
}
