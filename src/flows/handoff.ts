import { eq } from "drizzle-orm";
import { customers, type Customer } from "../db/schema";
import type { Ctx } from "../ctx";
import { waLink } from "../lib/phone";
import { notifyOwners, sendText } from "../wa/send";
import type { Incoming } from "../wa/types";
import { clearState, tagIntent } from "./state";

export const TAKEOVER_MS = 4 * 60 * 60 * 1000;

const who = (c: Customer | null, phone: string) =>
  `${c?.name ?? "New customer"} (${c?.area ?? "no area"})\n${phone}`;

/** Pause the bot for this customer and bring in the owner. */
export async function handoff(ctx: Ctx, customer: Customer | null, msg: Incoming, reason: string) {
  const until = new Date(ctx.now().getTime() + TAKEOVER_MS);
  await ctx.db.update(customers).set({ humanTakeoverUntil: until }).where(eq(customers.phone, msg.phone));
  await clearState(ctx, msg.phone);
  await tagIntent(ctx, msg.id, "handoff");
  await notifyOwners(
    ctx,
    `🙋 *Needs you:* ${who(customer, msg.phone)}\n` +
      `Reason: ${reason}\n` +
      `Last message: "${msg.text}"\n\n` +
      `Chat: ${waLink(msg.phone)}\n` +
      `Bot is paused for them for 4h. Send *RESUME ${msg.phone}* to turn it back on.`,
  );
  await sendText(ctx, msg.phone, "No problem — I've let the kitchen know and someone will message you shortly 🙏");
}

/** FYI to the owner without pausing the bot. */
export async function forwardToOwner(ctx: Ctx, customer: Customer | null, msg: Incoming, label: string) {
  await notifyOwners(
    ctx,
    `📨 *${label}:* ${who(customer, msg.phone)}\n` +
      (msg.text ? `"${msg.text}"\n` : "") +
      `Chat: ${waLink(msg.phone)}`,
  );
}
