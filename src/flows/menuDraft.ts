import { count, eq } from "drizzle-orm";
import type { Ctx } from "../ctx";
import type { Q } from "../db/client";
import { menus, orders, type Menu } from "../db/schema";
import { formatMenuPreview, type BuiltMenu } from "../domain/menu";
import { kvSet } from "../db/kv";
import { formatDay } from "../lib/time";
import { send, sendText } from "../wa/send";

/**
 * Store a menu for its date with the given status. A published menu that
 * already has orders is never replaced: returns how many orders block it.
 */
export async function upsertMenu(db: Q, built: BuiltMenu, status: "draft" | "active", now: Date): Promise<{ menu: Menu } | { blockedBy: number }> {
  const [existing] = await db.select().from(menus).where(eq(menus.date, built.date));
  if (existing && existing.status !== "draft") {
    const [{ n }] = (await db.select({ n: count() }).from(orders).where(eq(orders.menuId, existing.id))) as [{ n: number }];
    if (n > 0) return { blockedBy: n };
  }
  const values = { items: built.items, cutoffAt: built.cutoffAt, status, summarySentAt: null };
  const [m] = await db
    .insert(menus)
    .values({ date: built.date, createdAt: now, ...values })
    .onConflictDoUpdate({ target: menus.date, set: values })
    .returning();
  return { menu: m! };
}

/** kv key of the menu the owner is working on in chat (set by each preview, cleared on Publish). */
export const ownerCtxKey = (phone: string) => `owner_ctx:${phone}`;
export type OwnerCtx = { menuId: number; at: string };

/** Store a built menu as the draft for its date and send the owner the preview with Publish / Edit. */
export async function saveDraftMenu(ctx: Ctx, phone: string, built: BuiltMenu) {
  const r = await upsertMenu(ctx.db, built, "draft", ctx.now());
  if ("blockedBy" in r) {
    await sendText(
      ctx,
      phone,
      `The menu for ${formatDay(built.date, ctx.cfg.tz)} is already published and has ${r.blockedBy} order(s), so I can't replace it. Use OPEN/CLOSE to change the cutoff.`,
    );
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
