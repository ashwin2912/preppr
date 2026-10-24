import { eq } from "drizzle-orm";
import { conversationState, messages } from "../db/schema";
import type { Ctx } from "../ctx";

export type StateName =
  | "idle"
  | "onboarding_name"
  | "onboarding_area"
  | "onboarding_address"
  | "awaiting_confirm"
  | "awaiting_clarification"
  | "awaiting_payment_details";

export type ConvState = { state: StateName; context: Record<string, unknown> };

export async function getState(ctx: Ctx, phone: string): Promise<ConvState> {
  const [row] = await ctx.db.select().from(conversationState).where(eq(conversationState.phone, phone));
  return row ? { state: row.state as StateName, context: row.context } : { state: "idle", context: {} };
}

export async function setState(ctx: Ctx, phone: string, state: StateName, context: Record<string, unknown> = {}) {
  await ctx.db
    .insert(conversationState)
    .values({ phone, state, context, updatedAt: ctx.now() })
    .onConflictDoUpdate({ target: conversationState.phone, set: { state, context, updatedAt: ctx.now() } });
}

export const clearState = (ctx: Ctx, phone: string) => setState(ctx, phone, "idle");

/** Tag the inbound message with what the bot decided it was (for debugging / eval sets). */
export async function tagIntent(ctx: Ctx, waMessageId: string, intent: string) {
  await ctx.db.update(messages).set({ intent }).where(eq(messages.waMessageId, waMessageId));
}
