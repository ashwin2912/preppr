import { and, desc, eq, lt } from "drizzle-orm";
import { menus, orders, type Customer, type Menu, type Order, type OrderLine } from "../db/schema";
import type { Ctx } from "../ctx";
import { currentMenu, formatMenuForCustomer, ordersOpen } from "../domain/menu";
import { formatLines, money, orderTotal, priceLines, remapLines, toSimple } from "../domain/order";
import { errFields, log } from "../lib/log";
import { formatClock, formatDay, localDate } from "../lib/time";
import type { InterpretInput, Interpretation } from "../llm/types";
import { send, sendText } from "../wa/send";
import { MEDIA_TYPES, type Incoming } from "../wa/types";
import { balance } from "../domain/ledger";
import { forwardToOwner, handoff } from "./handoff";
import { answerBalance, balanceText, handlePaymentReport } from "./payments";
import { type ConvState, clearState, setState, tagIntent } from "./state";

export const CONFIDENCE_MIN = 0.8;
const MAX_CLARIFY = 1;

const dayPhrase = (m: Menu, ctx: Ctx) =>
  m.date === localDate(ctx.now(), ctx.cfg.tz) ? "today" : `on ${formatDay(m.date, ctx.cfg.tz)}`;

export async function sendMenu(ctx: Ctx, phone: string, menu: Menu) {
  await sendText(ctx, phone, formatMenuForCustomer(menu, ctx.cfg));
}

async function findOrder(ctx: Ctx, menuId: number, phone: string): Promise<Order | null> {
  const [o] = await ctx.db
    .select()
    .from(orders)
    .where(and(eq(orders.menuId, menuId), eq(orders.customerPhone, phone)));
  return o ?? null;
}

/** Last confirmed order from an earlier menu ("same as yesterday"). */
async function previousOrder(ctx: Ctx, phone: string, menu: Menu): Promise<Order | null> {
  const [row] = await ctx.db
    .select({ order: orders })
    .from(orders)
    .innerJoin(menus, eq(orders.menuId, menus.id))
    .where(and(eq(orders.customerPhone, phone), eq(orders.status, "confirmed"), lt(menus.date, menu.date)))
    .orderBy(desc(menus.date))
    .limit(1);
  return row?.order ?? null;
}

async function upsertDraft(ctx: Ctx, menu: Menu, phone: string, lines: OrderLine[], confidence: number, flagged = false) {
  const now = ctx.now();
  const values = { lines, totalCents: orderTotal(lines), status: "draft" as const, confidence, flagged, updatedAt: now };
  const [o] = await ctx.db
    .insert(orders)
    .values({ menuId: menu.id, customerPhone: phone, createdAt: now, ...values })
    .onConflictDoUpdate({ target: [orders.menuId, orders.customerPhone], set: values })
    .returning();
  return o!;
}

/** Button ids carry the order version so a stale summary can't confirm a newer edit. */
const confirmId = (o: Order) => `confirm:${o.id}:${o.updatedAt.getTime()}`;

async function sendOrderSummary(ctx: Ctx, customer: Customer, menu: Menu, o: Order, wasConfirmed: boolean) {
  const body =
    (wasConfirmed ? "Updated your order — tap Confirm to lock in the change.\n\n" : "") +
    `*Your order — ${formatDay(menu.date, ctx.cfg.tz)}*\n\n${formatLines(o.lines)}\n\n` +
    `*Total: ${money(o.totalCents)}*\nDelivery: ${customer.area ?? "—"}` +
    (ctx.cfg.paymentInstructions ? `\n\n${ctx.cfg.paymentInstructions}` : "");
  await send(ctx, {
    kind: "buttons",
    to: customer.phone,
    body,
    buttons: [
      { id: confirmId(o), title: "Confirm ✅" },
      { id: `change:${o.id}`, title: "Change ✏️" },
    ],
  });
  await setState(ctx, customer.phone, "awaiting_confirm", { orderId: o.id });
}

async function closedReply(ctx: Ctx, phone: string) {
  // Today's published menu tells us whether this is "after cutoff" or "no menu yet".
  const today = localDate(ctx.now(), ctx.cfg.tz);
  const [m] = await ctx.db.select().from(menus).where(eq(menus.date, today));
  if (m && m.status !== "draft") {
    await sendText(
      ctx,
      phone,
      `Orders for today closed at ${formatClock(m.cutoffAt, ctx.cfg.tz)}. Tomorrow's menu comes out in the morning 🙏`,
    );
    return true;
  }
  await sendText(ctx, phone, "Today's menu isn't out yet — it comes out in the morning. We'll see you then 🙏");
  return false;
}

async function handleButton(ctx: Ctx, msg: Incoming, customer: Customer, replyId: string) {
  const [kind, idStr, version] = replyId.split(":");
  const orderId = Number(idStr);
  const [o] = await ctx.db
    .select()
    .from(orders)
    .where(and(eq(orders.id, orderId), eq(orders.customerPhone, customer.phone)));
  if (!o) return;
  const [menu] = await ctx.db.select().from(menus).where(eq(menus.id, o.menuId));
  if (!menu || !ordersOpen(menu, ctx.now())) {
    await tagIntent(ctx, msg.id, `${kind}_late`);
    await closedReply(ctx, customer.phone);
    return;
  }
  await tagIntent(ctx, msg.id, kind!);

  if (kind === "change") {
    await clearState(ctx, customer.phone);
    await sendText(ctx, customer.phone, "Sure — tell me what to change (e.g. *add 2 roti*, *no paneer*, *make it 3 dal*).");
    return;
  }
  // confirm
  if (o.status === "cancelled") {
    await sendText(ctx, customer.phone, "That order was cancelled. Send me what you'd like to order 🙂");
    return;
  }
  if (version !== String(o.updatedAt.getTime())) {
    await sendText(ctx, customer.phone, "That summary is out of date — here's your latest order:");
    await sendOrderSummary(ctx, customer, menu, o, false);
    return;
  }
  if (o.status === "confirmed") {
    await sendText(ctx, customer.phone, "Already confirmed ✅");
    return;
  }
  await ctx.db.update(orders).set({ status: "confirmed", updatedAt: ctx.now() }).where(eq(orders.id, o.id));
  await clearState(ctx, customer.phone);
  const b = await balance(ctx.db, customer.phone);
  await sendText(
    ctx,
    customer.phone,
    `You're in! ✅ Delivery to ${customer.area ?? "you"} ${dayPhrase(menu, ctx)}.\nTo change or cancel, just message me before ${formatClock(menu.cutoffAt, ctx.cfg.tz)}.` +
      (b.owedCents > 0 ? `\n\n${balanceText(b)}` : ""),
  );
}

async function answerQuestion(ctx: Ctx, msg: Incoming, customer: Customer, menu: Menu | null, it: Interpretation) {
  const topic = it.question_topic ?? "other";
  if (topic === "balance") {
    await answerBalance(ctx, customer);
  } else if (menu && topic === "cutoff") {
    await sendText(ctx, customer.phone, `Orders close at ${formatClock(menu.cutoffAt, ctx.cfg.tz)} ${dayPhrase(menu, ctx)}.`);
  } else if (menu && (topic === "menu" || topic === "price")) {
    await sendMenu(ctx, customer.phone, menu);
  } else if (!menu && topic !== "other") {
    await closedReply(ctx, customer.phone);
  } else {
    await handoff(ctx, customer, msg, "Question the bot can't answer");
  }
}

export async function handleCustomer(ctx: Ctx, msg: Incoming, customer: Customer, st: ConvState) {
  const phone = customer.phone;

  if (MEDIA_TYPES.has(msg.type)) {
    await tagIntent(ctx, msg.id, "media");
    await sendText(ctx, phone, "Please type your order 🙏");
    await forwardToOwner(ctx, customer, msg, `Sent a ${msg.type === "audio" ? "voice note" : msg.type}`);
    return;
  }

  if (msg.replyId && /^(confirm|change):/.test(msg.replyId)) {
    await handleButton(ctx, msg, customer, msg.replyId);
    return;
  }

  const text = msg.text.trim();
  if (!text) {
    await sendText(ctx, phone, "Please type your order 🙏");
    return;
  }

  const menu = await currentMenu(ctx.db, ctx.now(), ctx.cfg.tz);
  const open = !!menu && ordersOpen(menu, ctx.now());
  const current = open ? await findOrder(ctx, menu.id, phone) : null;
  const prev = open ? await previousOrder(ctx, phone, menu) : null;
  const clarifying = st.state === "awaiting_clarification";
  const payClarifying = st.state === "awaiting_payment_details";

  const input: InterpretInput = {
    message: text,
    menu: open ? menu.items : [],
    currentOrder: current && current.status !== "cancelled" ? toSimple(current.lines) : null,
    previousOrder: prev && open ? remapLines(prev.lines, menu.items) : null,
    clarification: clarifying || payClarifying
      ? { previousMessage: String(st.context.previousMessage ?? ""), question: String(st.context.question ?? "") }
      : null,
  };

  let it: Interpretation;
  try {
    it = await ctx.llm.interpret(input);
  } catch (e) {
    log.error("interpret failed", { phone, ...errFields(e) });
    await sendText(ctx, phone, "Sorry, I didn't catch that — could you type it again? 🙏");
    return;
  }
  await tagIntent(ctx, msg.id, it.intent);
  log.info("interpreted", { phone, intent: it.intent, confidence: it.confidence, lines: it.lines.length, unmatched: it.unmatched });

  if (it.intent === "handoff") return handoff(ctx, customer, msg, "Asked for a person");
  // Payments come in any time, including after cutoff and delivery.
  if (it.intent === "payment" || (payClarifying && it.payment_cents)) return handlePaymentReport(ctx, msg, customer, it, st);
  if (payClarifying) await clearState(ctx, phone); // they moved on to something else

  if (!open) {
    if (it.intent === "question") return answerQuestion(ctx, msg, customer, null, it);
    const afterCutoff = await closedReply(ctx, phone);
    if (afterCutoff && (it.intent === "order" || it.intent === "edit" || it.intent === "cancel"))
      await forwardToOwner(ctx, customer, msg, "Late order attempt");
    return;
  }

  switch (it.intent) {
    case "menu":
      await clearState(ctx, phone);
      await sendMenu(ctx, phone, menu);
      if (current && current.status !== "cancelled")
        await sendText(ctx, phone, `Your order so far: ${current.lines.map((l) => `${l.qty} ${l.name}`).join(", ")} (${current.status === "confirmed" ? "confirmed ✅" : "not confirmed yet"})`);
      return;

    case "question":
      return answerQuestion(ctx, msg, customer, menu, it);

    case "cancel":
      await clearState(ctx, phone);
      if (!current || current.status === "cancelled") {
        await sendText(ctx, phone, `You don't have an order ${dayPhrase(menu, ctx)}.`);
        return;
      }
      await ctx.db.update(orders).set({ status: "cancelled", updatedAt: ctx.now() }).where(eq(orders.id, current.id));
      await sendText(ctx, phone, `Done — your order for ${formatDay(menu.date, ctx.cfg.tz)} is cancelled.`);
      return;

    case "order":
    case "edit": {
      const { lines, problems } = priceLines(it.lines, menu.items);
      const unclear = [...it.unmatched, ...problems];
      if (lines.length && !unclear.length && it.confidence >= CONFIDENCE_MIN) {
        const wasConfirmed = current?.status === "confirmed";
        const o = await upsertDraft(ctx, menu, phone, lines, it.confidence);
        await sendOrderSummary(ctx, customer, menu, o, wasConfirmed);
        return;
      }
      const attempts = clarifying ? Number(st.context.attempts ?? 0) + 1 : 1;
      if (attempts > MAX_CLARIFY) {
        if (lines.length) await upsertDraft(ctx, menu, phone, lines, it.confidence, true);
        return handoff(ctx, customer, msg, `Bot couldn't understand the order${unclear.length ? ` (unclear: ${unclear.join(", ")})` : ""}`);
      }
      const question =
        it.clarify_question?.trim() ||
        (unclear.length
          ? `Sorry, I couldn't match: ${unclear.join(", ")}. Today we have ${menu.items.map((i) => i.name).join(", ")}. What would you like?`
          : `Could you tell me exactly what you'd like? e.g. *2 ${menu.items[0]?.name.toLowerCase()}, 3 roti*`);
      await sendText(ctx, phone, question);
      await setState(ctx, phone, "awaiting_clarification", {
        attempts,
        question,
        previousMessage: clarifying ? `${st.context.previousMessage ?? ""} / ${text}` : text,
      });
      return;
    }

    default:
      if (st.state === "awaiting_confirm") {
        await sendText(ctx, phone, "Tap *Confirm ✅* on your order summary to place it, or tell me what to change.");
      } else if (current?.status === "confirmed") {
        await sendText(ctx, phone, "🙏 Your order is confirmed. Message me if you want to change anything.");
      } else {
        await sendMenu(ctx, phone, menu);
      }
  }
}
