import { and, eq, ne } from "drizzle-orm";
import type { Ctx } from "../ctx";
import type { Q } from "../db/client";
import { formResponses, menus, orders, type Menu } from "../db/schema";
import { keepItemIds } from "../domain/products";
import { formatMenuPreview, type BuiltMenu } from "../domain/menu";
import { kvSet } from "../db/kv";
import { formatDay } from "../lib/time";
import { send, sendText } from "../wa/send";

/**
 * Store a menu for its date with the given status. A published menu that
 * already has orders (chat/page orders or WhatsForm responses) is only changed
 * by a direct save ("active", kitchen page) that keeps every ordered dish at its
 * price: ids are carried over so stored order lines still point at the right
 * dish. A draft would hide the menu until Publish, so drafts are refused.
 */
export async function upsertMenu(
  db: Q,
  built: BuiltMenu,
  status: "draft" | "active",
  now: Date,
): Promise<{ menu: Menu } | { blockedBy: number; dishes: string[] }> {
  const [existing] = await db.select().from(menus).where(eq(menus.date, built.date));
  let items = built.items;
  if (existing && existing.status !== "draft") {
    const ordered = await orderedLines(db, existing.id);
    if (ordered.count > 0) {
      items = keepItemIds(existing.items, built.items);
      const kept = new Map(items.map((i) => [i.id, i]));
      const lost = existing.items.filter((i) => ordered.ids.has(i.id) && kept.get(i.id)?.price_cents !== i.price_cents);
      if (status === "draft" || lost.length) return { blockedBy: ordered.count, dishes: lost.map((i) => i.name) };
    }
  }
  const values = { items, cutoffAt: built.cutoffAt, status, summarySentAt: null };
  const [m] = await db
    .insert(menus)
    .values({ date: built.date, createdAt: now, ...values })
    .onConflictDoUpdate({ target: menus.date, set: values })
    .returning();
  return { menu: m! };
}

/** How many live orders a menu has, and which item ids they use. */
async function orderedLines(db: Q, menuId: number) {
  const rows = [
    ...(await db.select({ lines: orders.lines }).from(orders).where(and(eq(orders.menuId, menuId), ne(orders.status, "cancelled")))),
    ...(await db.select({ lines: formResponses.lines }).from(formResponses).where(and(eq(formResponses.menuId, menuId), eq(formResponses.status, "active")))),
  ];
  return { count: rows.length, ids: new Set(rows.flatMap((r) => r.lines.map((l) => l.item_id))) };
}

/** Why a menu change was refused, for the owner. */
export function blockedText(r: { blockedBy: number; dishes: string[] }): string {
  const n = `${r.blockedBy} order${r.blockedBy === 1 ? "" : "s"}`;
  return r.dishes.length
    ? `This menu already has ${n} for ${r.dishes.join(", ")}, so those can't be removed or repriced. You can still add dishes.`
    : `This menu already has ${n}, so it can't be replaced here. Add dishes on the kitchen page (/app), or use OPEN/CLOSE to change the cutoff.`;
}

/** kv key of the menu the owner is working on in chat (set by each preview, cleared on Publish). */
export const ownerCtxKey = (phone: string) => `owner_ctx:${phone}`;
export type OwnerCtx = { menuId: number; at: string };

/** Store a built menu as the draft for its date and send the owner the preview with Publish / Edit. */
export async function saveDraftMenu(ctx: Ctx, phone: string, built: BuiltMenu) {
  const r = await upsertMenu(ctx.db, built, "draft", ctx.now());
  if ("blockedBy" in r) {
    await sendText(ctx, phone, `${formatDay(built.date, ctx.cfg.tz)}: ${blockedText(r)}`);
    return;
  }
  const m = r.menu;
  await kvSet(ctx.db, ownerCtxKey(phone), { menuId: m.id, at: ctx.now().toISOString() } satisfies OwnerCtx, ctx.now());
  await send(ctx, {
    kind: "buttons",
    to: phone,
    body: formatMenuPreview(m, ctx.cfg, built.cutoffWasDefault),
    buttons: [
      { id: `menu_publish:${m.id}`, title: "Publish" },
      { id: `menu_edit:${m.id}`, title: "Edit" },
    ],
  });
}
