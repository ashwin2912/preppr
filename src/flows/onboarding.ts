import { eq } from "drizzle-orm";
import { customers, type Customer } from "../db/schema";
import type { Ctx } from "../ctx";
import { send, sendText } from "../wa/send";
import { MEDIA_TYPES, type Incoming } from "../wa/types";
import { type ConvState, clearState, setState } from "./state";

/** Imported or returning customers skip onboarding once name and area are known. */
export const needsOnboarding = (c: Customer | null) => !c || !c.name || !c.area;

export function matchArea(input: string, areas: string[]): string | null {
  const s = input.trim().toLowerCase();
  if (!s) return null;
  return (
    areas.find((a) => a.toLowerCase() === s) ??
    areas.find((a) => a.toLowerCase().startsWith(s) || s.includes(a.toLowerCase())) ??
    null
  );
}

async function askArea(ctx: Ctx, phone: string, context: Record<string, unknown>) {
  const areas = ctx.cfg.areas;
  const body = "Which area should we deliver to?";
  if (areas.length <= 3) {
    await send(ctx, { kind: "buttons", to: phone, body, buttons: areas.map((a, i) => ({ id: `area:${i}`, title: a })) });
  } else {
    await send(ctx, {
      kind: "list",
      to: phone,
      body,
      button: "Choose area",
      rows: areas.map((a, i) => ({ id: `area:${i}`, title: a })),
    });
  }
  await setState(ctx, phone, "onboarding_area", context);
}

/**
 * Returns true when onboarding finished on this message (caller then shows
 * the menu). False means we're still collecting details.
 */
export async function handleOnboarding(ctx: Ctx, msg: Incoming, customer: Customer | null, st: ConvState): Promise<boolean> {
  const phone = msg.phone;
  const update = (set: Partial<Customer>) =>
    ctx.db.update(customers).set({ ...set, updatedAt: ctx.now() }).where(eq(customers.phone, phone));

  if (!st.state.startsWith("onboarding_")) {
    const isNew = !customer;
    if (isNew) await ctx.db.insert(customers).values({ phone, createdAt: ctx.now(), updatedAt: ctx.now(), lastInboundAt: ctx.now() }).onConflictDoNothing();
    // Only brand-new customers are asked for an address note; imported ones fill gaps only.
    const context = { askAddress: isNew };
    if (!customer?.name) {
      await sendText(ctx, phone, `Welcome to ${ctx.cfg.kitchenName}! 🙏\nWhat name should we put on your orders?`);
      await setState(ctx, phone, "onboarding_name", context);
    } else {
      await askArea(ctx, phone, context);
    }
    return false;
  }

  if (MEDIA_TYPES.has(msg.type)) {
    await sendText(ctx, phone, "Please type your reply 🙏");
    return false;
  }

  const fresh = (await ctx.db.select().from(customers).where(eq(customers.phone, phone)))[0] ?? null;

  if (st.state === "onboarding_name") {
    const name = msg.replyId ? "" : msg.text.trim().replace(/\s+/g, " ");
    if (!name || name.length > 60) {
      await sendText(ctx, phone, "Please type the name for your orders 🙏");
      return false;
    }
    await update({ name });
    if (!fresh?.area) {
      await askArea(ctx, phone, st.context);
      return false;
    }
    return finish(ctx, phone, name);
  }

  if (st.state === "onboarding_area") {
    const idx = msg.replyId?.startsWith("area:") ? Number(msg.replyId.slice(5)) : NaN;
    const area = Number.isInteger(idx) ? (ctx.cfg.areas[idx] ?? null) : matchArea(msg.text, ctx.cfg.areas);
    if (!area) {
      await askArea(ctx, phone, st.context);
      return false;
    }
    await update({ area });
    if (st.context.askAddress) {
      await sendText(ctx, phone, "Got it! Any delivery note? (building, apt no., landmark) — or type *skip*");
      await setState(ctx, phone, "onboarding_address", st.context);
      return false;
    }
    return finish(ctx, phone, fresh?.name ?? "");
  }

  // onboarding_address
  const note = msg.text.trim();
  await update({ addressNote: /^(skip|no|none|na|n\/a|-)$/i.test(note) || !note ? null : note.slice(0, 300) });
  return finish(ctx, phone, fresh?.name ?? "");
}

async function finish(ctx: Ctx, phone: string, name: string): Promise<boolean> {
  await clearState(ctx, phone);
  await sendText(ctx, phone, `Thanks${name ? ` ${name}` : ""}! You're all set ✅`);
  return true;
}
