import { and, count, eq, gte } from "drizzle-orm";
import type { DB } from "../db/client";
import { customers, inbox, messages, type InboxRow } from "../db/schema";
import type { Ctx } from "../ctx";
import { log } from "../lib/log";
import { normalizePhone } from "../lib/phone";
import { sendText } from "../wa/send";
import { recordStatuses } from "../wa/statuses";
import { InboundMessageSchema, WebhookPayloadSchema, type Incoming, type InboundMessage } from "../wa/types";
import { handleCustomer, sendMenu } from "./customer";
import { handleOnboarding, needsOnboarding } from "./onboarding";
import { handleOwner } from "./owner";
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
 * Webhook side: save every inbound message to the inbox. Must finish before
 * the webhook returns 200; a throw means "not saved" and the webhook returns
 * 500 so Meta redelivers. Duplicate deliveries stop at the unique wamid.
 */
export async function enqueuePayload(deps: Deps, payload: unknown): Promise<number> {
  const parsed = WebhookPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    log.warn("unrecognized webhook payload", { issues: parsed.error.issues.slice(0, 3) });
    return 0;
  }
  let queued = 0;
  for (const entry of parsed.data.entry) {
    for (const change of entry.changes) {
      if (change.value.statuses?.length) await recordStatuses(deps, change.value.statuses);
      for (const raw of change.value.messages ?? []) {
        const m = InboundMessageSchema.safeParse(raw);
        if (!m.success) {
          log.warn("unparseable message", { raw });
          continue;
        }
        const phone = normalizePhone(m.data.from);
        if (!phone) {
          log.warn("bad sender number", { from: m.data.from });
          continue;
        }
        const now = deps.now();
        const profileName = change.value.contacts?.find((c) => c.wa_id === m.data.from)?.profile?.name?.trim().slice(0, 60) || null;
        const inserted = await deps.db
          .insert(inbox)
          .values({ waMessageId: m.data.id, phone, payload: m.data, profileName, createdAt: now, nextAttemptAt: now })
          .onConflictDoNothing()
          .returning({ id: inbox.id });
        if (inserted.length) queued++;
        else log.info("duplicate delivery ignored", { id: m.data.id });
      }
    }
  }
  return queued;
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

  if (row.attempts === 1) void deps.wa.markReadTyping(msg.id);
  await route(ctx, msg, row.profileName);
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

async function route(ctx: Ctx, msg: Incoming, profileName: string | null = null) {
  if (ctx.cfg.ownerNumbers.includes(msg.phone)) return handleOwner(ctx, msg);

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

  // Known customers imported without a name get their WhatsApp profile name.
  if (customer && !customer.name && profileName) {
    [customer] = await ctx.db
      .update(customers)
      .set({ name: profileName, updatedAt: now })
      .where(eq(customers.phone, msg.phone))
      .returning();
  }

  const st = await getState(ctx, msg.phone);
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
