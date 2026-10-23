import { eq, sql } from "drizzle-orm";
import type { DB } from "../db/client";
import { customers, messages } from "../db/schema";
import type { Ctx } from "../ctx";
import { errFields, log } from "../lib/log";
import { normalizePhone } from "../lib/phone";
import { sendText } from "../wa/send";
import { InboundMessageSchema, WebhookPayloadSchema, type Incoming, type InboundMessage } from "../wa/types";
import { handleCustomer, sendMenu } from "./customer";
import { handleOnboarding, needsOnboarding } from "./onboarding";
import { handleOwner } from "./owner";
import { getState } from "./state";
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

/** Entry point for one verified webhook body. Never throws. */
export async function processPayload(deps: Deps, payload: unknown) {
  const parsed = WebhookPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    log.warn("unrecognized webhook payload", { issues: parsed.error.issues.slice(0, 3) });
    return;
  }
  for (const entry of parsed.data.entry) {
    for (const change of entry.changes) {
      for (const s of change.value.statuses ?? []) log.info("status", { status: s });
      for (const raw of change.value.messages ?? []) {
        const m = InboundMessageSchema.safeParse(raw);
        if (!m.success) {
          log.warn("unparseable message", { raw });
          continue;
        }
        try {
          await handleInbound(deps, m.data);
        } catch (e) {
          log.error("handleInbound failed", { id: m.data.id, ...errFields(e) });
        }
      }
    }
  }
}

export async function handleInbound(deps: Deps, m: InboundMessage) {
  const phone = normalizePhone(m.from);
  if (!phone) {
    log.warn("bad sender number", { from: m.from });
    return;
  }
  const msg = toIncoming(m, phone);

  await deps.db.transaction(async (tx) => {
    // Serialize all handling per phone so rapid messages can't race on state/orders.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${phone}))`);

    // Idempotency gate: Meta may deliver the same message more than once.
    const inserted = await tx
      .insert(messages)
      .values({
        waMessageId: msg.id,
        phone,
        direction: "in",
        type: msg.type,
        body: msg.text || null,
        raw: m,
        createdAt: deps.now(),
      })
      .onConflictDoNothing()
      .returning({ id: messages.waMessageId });
    if (!inserted.length) {
      log.info("duplicate delivery ignored", { id: msg.id });
      return;
    }

    const ctx: Ctx = { ...deps, db: tx };
    void deps.wa.markReadTyping(msg.id);
    try {
      await route(ctx, msg);
    } catch (e) {
      // Keep the inbound row (commit) so duplicates stay deduped, and tell the sender.
      log.error("route failed", { id: msg.id, phone, ...errFields(e) });
      await sendText(ctx, phone, "Sorry, something went wrong on our side. Please try again in a minute 🙏");
    }
  });
}

async function route(ctx: Ctx, msg: Incoming) {
  if (ctx.cfg.ownerNumbers.includes(msg.phone)) return handleOwner(ctx, msg);

  const now = ctx.now();
  await ctx.db.update(customers).set({ lastInboundAt: now }).where(eq(customers.phone, msg.phone));
  let [customer] = await ctx.db.select().from(customers).where(eq(customers.phone, msg.phone));

  if (customer?.humanTakeoverUntil && customer.humanTakeoverUntil > now) {
    log.info("takeover active, bot silent", { phone: msg.phone });
    await ctx.db.update(messages).set({ intent: "takeover_silent" }).where(eq(messages.waMessageId, msg.id));
    return;
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
