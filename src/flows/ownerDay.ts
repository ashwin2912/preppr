import { eq } from "drizzle-orm";
import { formatInTimeZone } from "date-fns-tz";
import type { Ctx } from "../ctx";
import { menus, type Menu } from "../db/schema";
import { prepTotals } from "../domain/formOrders";
import { formatFormBroadcast } from "../domain/menu";
import { money } from "../domain/order";
import { formatDay, localDate } from "../lib/time";
import { sendLongText, sendText } from "../wa/send";
import { orderLink } from "./catalog";
import { dayOrders } from "./dayOrders";

/** Read-only day commands for the owner (WhatsForm / order page flow): HOW, WHAT, ORDERS, MESSAGE. */

const NO_MENU = "No menu for today yet. Tell me the dishes, e.g. *today dal, paneer, roti* (or *same as yesterday*).";

async function todayMenu(ctx: Ctx): Promise<Menu | null> {
  const [m] = await ctx.db.select().from(menus).where(eq(menus.date, localDate(ctx.now(), ctx.cfg.tz)));
  return m ?? null;
}

/** Dish names on the menu, sizes folded ("Dal 8oz", "Dal 16oz" -> "Dal"). */
const dishNames = (m: Menu) => [...new Set(m.items.map((i) => (i.size && i.name.endsWith(` ${i.size}`) ? i.name.slice(0, -i.size.length - 1) : i.name)))];

/** Menus set on the kitchen page run to 23:59: no cutoff worth showing. */
const realCutoff = (m: Menu, tz: string) => formatInTimeZone(m.cutoffAt, tz, "HH:mm") !== "23:59";

/** HOW: today at a glance. */
export async function cmdHow(ctx: Ctx, phone: string) {
  const m = await todayMenu(ctx);
  if (!m) return sendText(ctx, phone, NO_MENU);
  const rs = await dayOrders(ctx.db, m.id);
  const sales = rs.reduce((s, r) => s + r.totalCents, 0);
  const link = await orderLink(ctx);
  const check = rs.filter((r) => r.check.length).length;
  const lines = [
    `*${formatDay(m.date, ctx.cfg.tz)}*`,
    `${rs.length} order${rs.length === 1 ? "" : "s"} · ${money(sales)}`,
    `Menu: ${dishNames(m).join(", ")}`,
    link ? "Order form link ✓" : "Order form link not saved yet (send /link <form link>)",
  ];
  if (check) lines.push(`⚠️ ${check} order${check === 1 ? "" : "s"} need a look (/app)`);
  await sendText(ctx, phone, lines.join("\n"));
}

/** WHAT: how much of each dish to make. */
export async function cmdWhat(ctx: Ctx, phone: string) {
  const m = await todayMenu(ctx);
  if (!m) return sendText(ctx, phone, NO_MENU);
  const rows = prepTotals(
    m.items,
    (await dayOrders(ctx.db, m.id)).flatMap((r) => r.lines),
  );
  if (!rows.length) return sendText(ctx, phone, "No orders yet today.");
  await sendText(ctx, phone, `*What to make*\n\n${rows.map((r) => `• ${r.name}: *${r.amount}*${r.detail ? ` (${r.detail})` : ""}`).join("\n")}`);
}

/** ORDERS: today's orders, numbered. */
export async function cmdFormOrders(ctx: Ctx, phone: string) {
  const m = await todayMenu(ctx);
  if (!m) return sendText(ctx, phone, NO_MENU);
  const rs = await dayOrders(ctx.db, m.id);
  if (!rs.length) return sendText(ctx, phone, "No orders yet today.");
  const rows = rs.map((r, i) => {
    const who = r.name ?? r.phone ?? "Someone";
    const what = r.lines.map((l) => `${l.qty}× ${l.name}`).join(", ") || "⚠️ no dishes matched";
    return `${i + 1}. *${who}*${r.area ? ` (${r.area})` : ""}: ${what} — ${money(r.totalCents)}${r.note ? `\n   📝 ${r.note}` : ""}${r.check.length ? `\n   ⚠️ ${r.check.join("; ")}` : ""}`;
  });
  const total = rs.reduce((s, r) => s + r.totalCents, 0);
  await sendLongText(ctx, phone, `*Orders today (${rs.length})*\n\n${rows.join("\n")}\n\nTotal: ${money(total)}`);
}

/** MESSAGE: today's broadcast, ready to forward. */
export async function cmdMessage(ctx: Ctx, phone: string) {
  const m = await todayMenu(ctx);
  if (!m) return sendText(ctx, phone, NO_MENU);
  const link = await orderLink(ctx);
  if (!link) await sendText(ctx, phone, "Your order form link isn't saved yet, so the message has [LINK]. Send it once with /link <form link>.");
  await sendText(ctx, phone, formatFormBroadcast(m, ctx.cfg, link || null, realCutoff(m, ctx.cfg.tz)));
}
