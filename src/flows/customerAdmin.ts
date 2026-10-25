import { eq } from "drizzle-orm";
import { customers } from "../db/schema";
import type { Ctx } from "../ctx";
import { normalizePhone } from "../lib/phone";
import { sendText } from "../wa/send";
import { matchArea } from "./onboarding";

/** "<number> <rest…>" → [E.164, rest] */
function splitTarget(arg: string): [string | null, string] {
  const [first = "", ...rest] = arg.trim().split(/\s+/);
  return [normalizePhone(first), rest.join(" ").trim()];
}

/** ADD <number> [name]: a known customer who will skip onboarding. */
export async function cmdAdd(ctx: Ctx, owner: string, arg: string) {
  const [phone, name] = splitTarget(arg);
  if (!phone) return sendText(ctx, owner, "Use ADD +12015551234 Priya");
  const now = ctx.now();
  const [c] = await ctx.db
    .insert(customers)
    .values({ phone, name: name || null, createdAt: now, updatedAt: now })
    .onConflictDoNothing()
    .returning();
  if (!c) return sendText(ctx, owner, `${phone} is already a customer.`);
  await sendText(ctx, owner, `Added ${name || phone}. They can order straight away.`);
}

type Field = "name" | "area" | "addressNote";
const USAGE: Record<Field, string> = {
  name: "Use NAME +12015551234 Priya",
  area: "Use AREA +12015551234 <area>",
  addressNote: "Use NOTE +12015551234 Apt 4B, ring twice",
};

/** NAME / AREA / NOTE <number> <value>: fill in a customer's details. */
export async function cmdSetField(ctx: Ctx, owner: string, arg: string, field: Field) {
  const [phone, raw] = splitTarget(arg);
  if (!phone || !raw) return sendText(ctx, owner, field === "area" ? `${USAGE.area}. Areas: ${ctx.cfg.areas.join(", ")}` : USAGE[field]);
  let value = raw.slice(0, field === "addressNote" ? 300 : 60);
  if (field === "area") {
    const area = matchArea(raw, ctx.cfg.areas);
    if (!area) return sendText(ctx, owner, `"${raw}" isn't one of the areas: ${ctx.cfg.areas.join(", ")}`);
    value = area;
  }
  const res = await ctx.db
    .update(customers)
    .set({ [field]: value, updatedAt: ctx.now() })
    .where(eq(customers.phone, phone))
    .returning({ name: customers.name });
  if (!res.length) return sendText(ctx, owner, `No customer with number ${phone}. Use ADD first.`);
  const label = { name: "Name", area: "Area", addressNote: "Delivery note" }[field];
  await sendText(ctx, owner, `${label} for ${res[0]!.name ?? phone}: ${value}`);
}
