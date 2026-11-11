import { createHash } from "node:crypto";
import { formatInTimeZone } from "date-fns-tz";
import { and, asc, desc, eq, gte, lt, ne } from "drizzle-orm";
import type { Ctx } from "../ctx";
import type { Q } from "../db/client";
import { kvGet, kvSet } from "../db/kv";
import { kv, menus, products, type Menu, type Product } from "../db/schema";
import { formatFormBroadcast, ownerMenu } from "../domain/menu";
import {
  addPicks,
  cleanParsedProducts,
  describePicks,
  formatProductList,
  formatSizes,
  menuItemsFromPicks,
  nameKey,
  parseProductsText,
  picksFromMenu,
  removePicks,
  resolvePicks,
  type MenuPick,
  type ProductDraft,
} from "../domain/products";
import { errFields, log } from "../lib/log";
import { addDays, formatClock, formatDay, localDate, parseClock, resolveMenuDate, zonedInstant } from "../lib/time";
import { send, sendLongText, sendText } from "../wa/send";
import { ownerCtxKey, saveDraftMenu, type OwnerCtx } from "./menuDraft";

export { kvGet, kvSet };

const ADD_EXAMPLE = "/add-product Dal makhani 8oz 6, 16oz 10\n/add-product Roti 1 each";

/** Active products in list order; PRODUCTS numbers are positions in this list. */
export async function activeProducts(db: Q): Promise<Product[]> {
  return db.select().from(products).where(eq(products.active, true)).orderBy(asc(products.id));
}

export async function cmdProducts(ctx: Ctx, phone: string) {
  const list = await activeProducts(ctx.db);
  if (!list.length) return sendText(ctx, phone, `Your product list is empty. Add dishes like this:\n${ADD_EXAMPLE}`);
  await sendLongText(
    ctx,
    phone,
    `*Your dishes*\n\n${formatProductList(list)}\n\nType today's dishes to make the menu, e.g. *today 1 3 5* or *today dal, roti*`,
  );
}

/** Owner text -> product drafts: code parser first, the model only when it can't. */
async function parseDrafts(ctx: Ctx, text: string): Promise<{ products: ProductDraft[]; rejected: string[] } | null> {
  const ruled = parseProductsText(text);
  if (ruled) return { products: ruled, rejected: [] };
  try {
    return cleanParsedProducts(await ctx.llm.parseProducts(text), text);
  } catch (e) {
    log.error("parseProducts failed", errFields(e));
    return null;
  }
}

/**
 * ADD-PRODUCT / EDIT-PRODUCT: parse, then preview with Save / Cancel. Nothing is
 * stored in the product list until the owner taps Save. EDIT also accepts the
 * product's number from PRODUCTS in place of its name.
 */
export async function cmdAddProducts(ctx: Ctx, phone: string, arg: string, msgId: string, edit: boolean) {
  if (!arg) {
    return sendText(
      ctx,
      phone,
      edit ? "Send the dish and its new sizes and prices, e.g.\n/edit-product 3 8oz 7, 16oz 11" : `Send the dish with its sizes and prices, one dish per line, e.g.\n${ADD_EXAMPLE}`,
    );
  }
  const list = await activeProducts(ctx.db);
  let text = arg;
  if (edit) {
    const n = arg.match(/^#?(\d+)\s+/);
    if (n) {
      const p = list[Number(n[1]) - 1];
      if (!p) return sendText(ctx, phone, `There's no product #${n[1]}. Send /products to see the numbers.`);
      text = `${p.name} ${arg.slice(n[0].length)}`;
    }
  }
  const parsed = await parseDrafts(ctx, text);
  if (!parsed) return sendText(ctx, phone, "Sorry, I couldn't read that right now. Please try again in a minute.");
  await previewProducts(ctx, phone, parsed.products, parsed.rejected, msgId, edit, list);
}

/**
 * Show product drafts with Save / Cancel and park them in kv until the tap.
 * With `edit`, every draft must match an existing product (exact name or a unique partial match).
 */
export async function previewProducts(ctx: Ctx, phone: string, drafts: ProductDraft[], rejected: string[], msgId: string, edit: boolean, list: Product[]) {
  if (!drafts.length) {
    const why = rejected.length ? `I couldn't find a price for ${rejected.join(", ")}.` : "I couldn't find any dishes with prices.";
    return sendText(ctx, phone, `${why} Write it like this:\n*add dal 8oz 6, 16oz 10*\n*add roti 1 each*`);
  }

  const byKey = new Map(list.map((p) => [p.nameKey, p]));
  if (edit) {
    for (const d of drafts) {
      const { picks } = resolvePicks(d.name, list);
      const target = byKey.get(nameKey(d.name)) ?? (picks.length === 1 ? picks[0]!.product : null);
      if (!target) return sendText(ctx, phone, `"${d.name}" isn't in your dishes. Send it with prices to add it, e.g. *add ${d.name.toLowerCase()} 8oz 6*`);
      d.name = target.name;
    }
  }

  const lines = drafts.map((d) => {
    const old = byKey.get(nameKey(d.name));
    return `• ${d.name} — ${formatSizes(d.sizes)}${old ? `\n   _replaces ${formatSizes(old.sizes)}_` : ""}`;
  });
  const notes = rejected.length ? `\n\n⚠️ Left out (no price I could find): ${rejected.join(", ")}` : "";
  const draftId = createHash("sha256").update(msgId).digest("hex").slice(0, 16);
  await kvSet(ctx.db, `product_draft:${draftId}`, drafts, ctx.now());
  await send(ctx, {
    kind: "buttons",
    to: phone,
    body: `*Save ${drafts.length === 1 ? "this dish" : `these ${drafts.length} dishes`}?*\n\n${lines.join("\n")}${notes}`,
    buttons: [
      { id: `prod_save:${draftId}`, title: "Save" },
      { id: `prod_cancel:${draftId}`, title: "Cancel" },
    ],
  });
}

/**
 * Plain-chat product text ("dal 16oz 11") for a dish she already has: change the
 * sizes she wrote and keep the others, instead of replacing the whole list.
 */
export function mergeIntoExisting(drafts: ProductDraft[], list: Product[]): ProductDraft[] {
  return drafts.map((d) => {
    const old = list.find((p) => p.nameKey === nameKey(d.name));
    if (!old) return d;
    const sizes = old.sizes.map((s) => d.sizes.find((x) => x.label.toLowerCase() === s.label.toLowerCase()) ?? s);
    for (const x of d.sizes) if (!sizes.some((s) => s.label.toLowerCase() === x.label.toLowerCase())) sizes.push(x);
    return { ...d, name: old.name, sizes };
  });
}

async function saveDrafts(ctx: Ctx, phone: string, draftId: string) {
  const key = `product_draft:${draftId}`;
  const drafts = await kvGet<ProductDraft[]>(ctx.db, key);
  if (!drafts) return sendText(ctx, phone, "Already saved (or cancelled). Send /products to see your list.");
  const now = ctx.now();
  for (const d of drafts) {
    const set = { name: d.name, sizes: d.sizes, active: true, updatedAt: now, ...(d.aliases.length ? { aliases: d.aliases } : {}) };
    await ctx.db
      .insert(products)
      .values({ nameKey: nameKey(d.name), aliases: d.aliases, createdAt: now, ...set })
      .onConflictDoUpdate({ target: products.nameKey, set });
  }
  await ctx.db.delete(kv).where(eq(kv.key, key));
  const total = (await activeProducts(ctx.db)).length;
  await sendText(ctx, phone, `Saved ✅ ${drafts.map((d) => d.name).join(", ")}. You have ${total} dish${total === 1 ? "" : "es"}: /products`);
}

/** REMOVE-PRODUCT <#|name>: asks first, then hides it from the list (old menus keep it). */
export async function cmdRemoveProduct(ctx: Ctx, phone: string, arg: string) {
  const list = await activeProducts(ctx.db);
  const n = arg.match(/^#?(\d+)$/);
  const target = n ? list[Number(n[1]) - 1] : (() => {
    const { picks } = resolvePicks(arg, list);
    return picks.length === 1 ? picks[0]!.product : undefined;
  })();
  if (!arg || !target) return sendText(ctx, phone, "Which one? Send e.g. /remove-product 3 (the number from /products).");
  await send(ctx, {
    kind: "buttons",
    to: phone,
    body: `Remove *${target.name}* (${formatSizes(target.sizes)}) from your products?`,
    buttons: [
      { id: `prod_rm:${target.id}`, title: "Remove" },
      { id: `prod_keep:${target.id}`, title: "Keep" },
    ],
  });
}

/** Product buttons; returns false for button kinds that aren't ours. */
export async function handleCatalogButton(ctx: Ctx, phone: string, kind: string, id: string): Promise<boolean> {
  if (kind === "prod_save") await saveDrafts(ctx, phone, id);
  else if (kind === "prod_cancel") {
    await ctx.db.delete(kv).where(eq(kv.key, `product_draft:${id}`));
    await sendText(ctx, phone, "OK, not saved.");
  } else if (kind === "prod_rm") {
    const [p] = await ctx.db.update(products).set({ active: false, updatedAt: ctx.now() }).where(eq(products.id, Number(id))).returning();
    await sendText(ctx, phone, p ? `Removed ${p.name}. Send /products to see the list.` : "That product doesn't exist any more.");
  } else if (kind === "prod_keep") await sendText(ctx, phone, "OK, kept.");
  else return false;
  return true;
}

const DAY_RE = /^\s*(today|tomorrow|tmrw|sun(?:day)?|mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:r|rs|rsday)?|fri(?:day)?|sat(?:urday)?)\b\s*:?/i;
const CUTOFF_RE = /[.,]?\s*\b(?:cut-?off|by|till|until|before)\s*(?:at\s*)?:?\s*(\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm)?)\s*\.?\s*$/i;

/**
 * MENU from the product list: "/menu 1 3 5", "/menu tomorrow: dal, roti (each) cutoff 10:30".
 * Returns false when the product list is empty, so the caller can fall back to free-text MENU,
 * and "chat" when the dishes don't all resolve, so the caller can read it as plain chat.
 */
export async function cmdCatalogMenu(ctx: Ctx, phone: string, arg: string): Promise<boolean | "chat"> {
  const list = await activeProducts(ctx.db);
  if (!list.length) return false;
  if (!arg) {
    await sendLongText(ctx, phone, `*Your dishes*\n\n${formatProductList(list)}\n\nType today's dishes, e.g. *today 1 3 5 cutoff 10:30* or *today dal, roti*`);
    return true;
  }
  let text = arg;
  const day = text.match(DAY_RE);
  if (day) text = text.slice(day[0].length);
  const cut = text.match(CUTOFF_RE);
  if (cut) text = text.slice(0, cut.index);
  const cutoff = cut ? parseClock(cut[1]!.replace(".", ":")) : null;
  if (cut && !cutoff) {
    await sendText(ctx, phone, `I couldn't read the cutoff "${cut[1]}". Use e.g. cutoff 10:30 or cutoff 11am.`);
    return true;
  }

  const { picks, unknown } = resolvePicks(text, list);
  if (unknown.length || !picks.length) return "chat";
  const date = resolveMenuDate(day ? day[1]!.replace(/^tmrw$/i, "tomorrow") : null, ctx.now(), ctx.cfg.tz);
  await saveDraftMenu(ctx, phone, {
    date,
    cutoffAt: zonedInstant(date, cutoff ?? parseClock(ctx.cfg.cutoffTime)!, ctx.cfg.tz),
    items: menuItemsFromPicks(picks),
    cutoffWasDefault: !cutoff,
  });
  return true;
}

const FORM_LINK_KEY = "form_link";

/** The order form's link. One permanent form: it shows whatever menu is published (src/flows/formMenu.ts). */
export async function getFormLink(db: Ctx["db"]): Promise<string | null> {
  return (await kvGet<string>(db, FORM_LINK_KEY)) || null;
}

export const setFormLink = (db: Ctx["db"], url: string, now: Date) => kvSet(db, FORM_LINK_KEY, url, now);

/** After Publish (WhatsForm flow): the order form already shows the new menu, so only the broadcast is left. */
export async function sendFormKit(ctx: Ctx, phone: string, m: Menu) {
  const link = await getFormLink(ctx.db);
  await sendText(
    ctx,
    phone,
    link
      ? "✅ Published. Your order form shows this menu now. Send this to your broadcast list 👇"
      : "✅ Published. Here's your broadcast 👇 Send me your order form link once with /link <link> and I'll put it in every day.",
  );
  await sendText(ctx, phone, formatFormBroadcast(m, ctx.cfg, link));
}

/** LINK <url>: the order form's link, saved once and put into every broadcast. */
export async function cmdLink(ctx: Ctx, phone: string, arg: string) {
  const url = arg.match(/https?:\/\/\S+/)?.[0];
  if (!url) return sendText(ctx, phone, "Send the form link like this: /link https://whatsform.com/abc123");
  const today = localDate(ctx.now(), ctx.cfg.tz);
  const m = await ownerMenu(ctx.db, ctx.now(), ctx.cfg.tz);
  await setFormLink(ctx.db, url, ctx.now());
  if (m && m.date >= today) {
    await sendText(ctx, phone, "Link saved ✅ Here's the broadcast to send 👇");
    await sendText(ctx, phone, formatFormBroadcast(m, ctx.cfg, url));
    return;
  }
  await sendText(ctx, phone, "Link saved ✅ It goes into the broadcast when you publish today's menu.");
}

// ---- Menus by plain chat: "today dal, roti", "add samosa", "same as Monday", "cutoff 11" ----

const OWNER_CTX_MS = 2 * 60 * 60 * 1000;

/** A dish number + size labels (from the model) -> a pick; anything that doesn't resolve comes back in `unknown`. */
export function picksFromNumbers(specs: { n: number; sizes: string[] }[], list: Product[]): { picks: MenuPick[]; unknown: string[] } {
  const found: MenuPick[] = [];
  const unknown: string[] = [];
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, "");
  for (const spec of specs) {
    const product = list[spec.n - 1];
    if (!product) {
      unknown.push(`#${spec.n}`);
      continue;
    }
    const sizes = spec.sizes.length ? product.sizes.filter((s) => spec.sizes.some((w) => norm(w) === norm(s.label))) : product.sizes;
    if (!sizes.length || sizes.length < new Set(spec.sizes.map(norm)).size) unknown.push(`${product.name} ${spec.sizes.join("/")}`.trim());
    if (sizes.length) found.push({ product, sizes });
  }
  return { picks: addPicks([], found), unknown };
}

/** The menu she is working on: the draft from her last preview (2 h), else the next menu from today on. */
export async function workingMenu(ctx: Ctx, phone: string): Promise<Menu | null> {
  const today = localDate(ctx.now(), ctx.cfg.tz);
  const c = await kvGet<OwnerCtx>(ctx.db, ownerCtxKey(phone));
  if (c && ctx.now().getTime() - Date.parse(c.at) < OWNER_CTX_MS) {
    const [m] = await ctx.db.select().from(menus).where(eq(menus.id, c.menuId));
    if (m && m.date >= today) return m;
  }
  const [m] = await ctx.db.select().from(menus).where(gte(menus.date, today)).orderBy(asc(menus.date)).limit(1);
  return m ?? null;
}

const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/**
 * The published menu "same as …" points at, before `before`: `null`/"last" =
 * the latest, "yesterday" = the day before, "today", or a weekday = the latest on that weekday.
 */
export async function earlierMenu(ctx: Ctx, before: string, word: string | null): Promise<Menu | null> {
  const w = word?.trim().toLowerCase() ?? null;
  const rows = await ctx.db
    .select()
    .from(menus)
    .where(and(lt(menus.date, before), ne(menus.status, "draft")))
    .orderBy(desc(menus.date))
    .limit(30);
  if (!w || w === "last") return rows[0] ?? null;
  const today = localDate(ctx.now(), ctx.cfg.tz);
  if (w === "yesterday") return rows.find((m) => m.date === addDays(today, -1)) ?? null;
  if (w === "today") return rows.find((m) => m.date === today) ?? null;
  const dow = DAYS.findIndex((d) => w.length >= 3 && w.startsWith(d));
  if (dow < 0) return null;
  return rows.find((m) => new Date(`${m.date}T12:00:00Z`).getUTCDay() === dow) ?? null;
}

/** Save picks as the draft for `date` and show the preview. `keepClock` keeps an earlier menu's cutoff time of day. */
async function draftFromPicks(ctx: Ctx, phone: string, date: string, picks: MenuPick[], cutoff: string | null, keepClock: string | null, notes: string[]) {
  if (!picks.length) return sendText(ctx, phone, "That leaves nothing on the menu. Tell me the dishes, e.g. *today dal, paneer, roti*.");
  const hhmm = cutoff ? parseClock(cutoff.replace(".", ":")) : null;
  if (cutoff && !hhmm) return sendText(ctx, phone, `I couldn't read the cutoff "${cutoff}". Say e.g. *cutoff 10:30* or *cutoff 11am*.`);
  if (notes.length) await sendText(ctx, phone, notes.join("\n"));
  await saveDraftMenu(ctx, phone, {
    date,
    cutoffAt: zonedInstant(date, hhmm ?? keepClock ?? parseClock(ctx.cfg.cutoffTime)!, ctx.cfg.tz),
    items: menuItemsFromPicks(picks),
    cutoffWasDefault: !hhmm && !keepClock,
  });
}

const unknownNote = (unknown: string[]) =>
  unknown.length ? [`⚠️ Not in your dishes: ${unknown.join(", ")}. To add one, send it with a price, e.g. *add ${unknown[0]!.toLowerCase()} 8oz 6*`] : [];

/** SET MENU: the full menu for a day. */
export async function chatSetMenu(ctx: Ctx, phone: string, day: string | null, picks: MenuPick[], cutoff: string | null, unknown: string[] = []) {
  if (!picks.length) return sendText(ctx, phone, `${unknownNote(unknown)[0] ?? "Which dishes?"}\nSend /products to see your dishes.`);
  const date = resolveMenuDate(day, ctx.now(), ctx.cfg.tz);
  await draftFromPicks(ctx, phone, date, picks, cutoff, null, unknownNote(unknown));
}

/** Lines of a menu that are no longer on the product list (removed dish or size, or a free-text menu). */
const missingNote = (missing: string[]) => (missing.length ? [`⚠️ Left out (not in your dishes any more): ${missing.join(", ")}`] : []);

/** EDIT MENU: add/remove dishes or sizes on the menu she's working on (or the one for `day`). */
export async function chatEditMenu(ctx: Ctx, phone: string, day: string | null, add: MenuPick[], remove: MenuPick[], cutoff: string | null, unknown: string[] = []) {
  const list = await activeProducts(ctx.db);
  let m: Menu | null;
  if (day) [m = null] = await ctx.db.select().from(menus).where(eq(menus.date, resolveMenuDate(day, ctx.now(), ctx.cfg.tz)));
  else m = await workingMenu(ctx, phone);
  if (!m) {
    if (add.length) return chatSetMenu(ctx, phone, day, add, cutoff, unknown);
    return sendText(ctx, phone, "There's no menu to change yet. Tell me the dishes, e.g. *today dal, paneer, roti*.");
  }
  const { picks, missing } = picksFromMenu(m.items, list);
  const next = removePicks(addPicks(picks, add), remove);
  const clock = formatInTimeZone(m.cutoffAt, ctx.cfg.tz, "HH:mm");
  await draftFromPicks(ctx, phone, m.date, next, cutoff, clock, [...missingNote(missing), ...unknownNote(unknown)]);
}

/** COPY MENU: "same as yesterday / Monday", with optional changes, for today (or tomorrow when copying today's). */
export async function chatCopyMenu(
  ctx: Ctx,
  phone: string,
  from: string | null,
  day: string | null,
  add: MenuPick[] = [],
  remove: MenuPick[] = [],
  cutoff: string | null = null,
  unknown: string[] = [],
) {
  const today = localDate(ctx.now(), ctx.cfg.tz);
  const target = day ? resolveMenuDate(day, ctx.now(), ctx.cfg.tz) : from?.toLowerCase() === "today" ? addDays(today, 1) : today;
  const src = await earlierMenu(ctx, target, from);
  if (!src) return sendText(ctx, phone, `I can't find ${from && from !== "last" ? `a menu for ${from}` : "an earlier menu"}. Tell me the dishes, e.g. *today dal, paneer, roti*.`);
  await copyMenuTo(ctx, phone, src, target, add, remove, cutoff, unknown);
}

/** Copy `src` (current prices) to `target`, apply changes, show the preview. Also behind the morning nudge's button. */
export async function copyMenuTo(ctx: Ctx, phone: string, src: Menu, target: string, add: MenuPick[] = [], remove: MenuPick[] = [], cutoff: string | null = null, unknown: string[] = []) {
  const list = await activeProducts(ctx.db);
  const { picks, missing } = picksFromMenu(src.items, list);
  const next = removePicks(addPicks(picks, add), remove);
  const clock = formatInTimeZone(src.cutoffAt, ctx.cfg.tz, "HH:mm");
  await draftFromPicks(ctx, phone, target, next, cutoff, clock, [...missingNote(missing), ...unknownNote(unknown)]);
}

/** SET CUTOFF: a draft gets a new preview; a published menu changes in place (it may already have orders). */
export async function chatSetCutoff(ctx: Ctx, phone: string, day: string | null, cutoff: string) {
  let m: Menu | null;
  if (day) [m = null] = await ctx.db.select().from(menus).where(eq(menus.date, resolveMenuDate(day, ctx.now(), ctx.cfg.tz)));
  else m = await workingMenu(ctx, phone);
  if (!m) return sendText(ctx, phone, "There's no menu yet. Tell me the dishes first, e.g. *today dal, paneer, roti cutoff 11*.");
  const hhmm = parseClock(cutoff.replace(".", ":"));
  if (!hhmm) return sendText(ctx, phone, `I couldn't read the cutoff "${cutoff}". Say e.g. *cutoff 10:30* or *cutoff 11am*.`);
  const cutoffAt = zonedInstant(m.date, hhmm, ctx.cfg.tz);
  if (cutoffAt <= ctx.now()) return sendText(ctx, phone, `${formatClock(cutoffAt, ctx.cfg.tz)} has already passed.`);
  if (m.status === "draft") return saveDraftMenu(ctx, phone, { date: m.date, cutoffAt, items: m.items, cutoffWasDefault: false });
  await ctx.db.update(menus).set({ cutoffAt, status: "active", summarySentAt: null }).where(eq(menus.id, m.id));
  const tail = ctx.cfg.orderChannel === "whatsform" ? " Send /message for the updated broadcast." : "";
  await sendText(ctx, phone, `Cutoff for ${formatDay(m.date, ctx.cfg.tz)} is now ${formatClock(cutoffAt, ctx.cfg.tz)} ✅${tail}`);
}

/** SHOW MENU: the menu she's working on, as dishes and sizes. */
export async function chatShowMenu(ctx: Ctx, phone: string) {
  const m = await workingMenu(ctx, phone);
  if (!m) return sendText(ctx, phone, "No menu yet. Tell me the dishes, e.g. *today dal, paneer, roti*.");
  const { picks, missing } = picksFromMenu(m.items, await activeProducts(ctx.db));
  const dishes = [describePicks(picks), ...missing].filter(Boolean).join(", ");
  const state = m.status === "draft" ? "draft, not published" : m.status === "active" ? "published" : m.status;
  await sendText(ctx, phone, `*${formatDay(m.date, ctx.cfg.tz)}* (${state})\n${dishes}\nCutoff ${formatClock(m.cutoffAt, ctx.cfg.tz)}`);
}
