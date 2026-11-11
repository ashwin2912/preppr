import { formatInTimeZone } from "date-fns-tz";
import type { Ctx } from "../ctx";
import { ruleOwner } from "../domain/ownerRules";
import { cleanParsedProducts, describePicks, formatSizes, parseProductsText, picksFromMenu, resolvePicks } from "../domain/products";
import type { OwnerAction } from "../llm/types";
import { errFields, log } from "../lib/log";
import { localDate } from "../lib/time";
import { sendText } from "../wa/send";
import {
  activeProducts,
  chatCopyMenu,
  chatEditMenu,
  chatSetCutoff,
  chatSetMenu,
  chatShowMenu,
  cmdProducts,
  cmdRemoveProduct,
  earlierMenu,
  mergeIntoExisting,
  picksFromNumbers,
  previewProducts,
  workingMenu,
} from "./catalog";

/** Read-only commands the chat can land on; the owner router runs them. */
export type ChatCommand = "HOW" | "WHAT" | "ORDERS" | "MESSAGE" | "HELP";

export const CHAT_EXAMPLES = `Just type it, for example:
• *add samosa 2 each* or *add dal 8oz 6, 16oz 10*
• *dal 16oz is 11 now*
• *today dal, paneer and roti* (or *today 1 3 5*)
• *same as yesterday but no rice*
• *add kheer* / *no roti* / *cutoff 11*
• *remove samosa from my dishes*`;

const NOT_READ = `Sorry, I couldn't read that right now. Please try again in a minute.\n\n${CHAT_EXAMPLES}`;

/**
 * The owner's plain chat about dishes and menus. Strict code rules first
 * (src/domain/ownerRules.ts), the model only when they can't answer. Every
 * change ends in a preview with buttons; nothing is saved before she taps.
 * Returns a read-only command for the caller to run, or null when handled.
 */
export async function handleOwnerChat(ctx: Ctx, phone: string, text: string, msgId: string): Promise<ChatCommand | null> {
  const rule = ruleOwner(text);
  if (rule?.action === "help") return "HELP";
  if (rule?.action === "ack") {
    await sendText(ctx, phone, "👍");
    return null;
  }
  if (rule?.action === "set_cutoff") {
    await chatSetCutoff(ctx, phone, null, rule.cutoff);
    return null;
  }
  if (rule?.action === "copy_menu") {
    await chatCopyMenu(ctx, phone, rule.from, null);
    return null;
  }
  const list = await activeProducts(ctx.db);
  if (rule?.action === "set_menu") {
    const { picks, unknown } = resolvePicks(rule.dishes, list);
    if (picks.length && !unknown.length) {
      await chatSetMenu(ctx, phone, rule.day, picks, rule.cutoff);
      return null;
    }
  }
  // Dish lines with prices ("samosa 2 each", "dal 16oz 11"): a dish she has keeps the sizes she didn't mention.
  const body = text.replace(/^(?:add|new)\s+(?:dish(?:es)?\s*:?\s*)?/i, "");
  // A comma before the first number is a list of dishes ("dal, biryani, 9"), not one dish's name.
  const dishLines = !/^\//.test(text) && body.split(/\n+/).every((l) => !/^[^\d$]*,/.test(l));
  const ruled = dishLines ? parseProductsText(body) : null;
  if (ruled) {
    await previewProducts(ctx, phone, mergeIntoExisting(ruled, list), [], msgId, false, list);
    return null;
  }

  let a: OwnerAction;
  try {
    a = await ctx.llm.interpretOwner(await ownerInput(ctx, phone, text, list));
  } catch (e) {
    log.error("interpretOwner failed", errFields(e));
    await sendText(ctx, phone, NOT_READ);
    return null;
  }
  return runAction(ctx, phone, text, msgId, a, list);
}

async function ownerInput(ctx: Ctx, phone: string, text: string, list: Awaited<ReturnType<typeof activeProducts>>) {
  const now = ctx.now();
  const open = await workingMenu(ctx, phone);
  const before = open?.date ?? localDate(now, ctx.cfg.tz);
  const last = await earlierMenu(ctx, before, null);
  const dishes = (items: NonNullable<typeof open>["items"]) => {
    const { picks, missing } = picksFromMenu(items, list);
    return [describePicks(picks), ...missing].filter(Boolean).join(", ");
  };
  return {
    message: text,
    today: formatInTimeZone(now, ctx.cfg.tz, "EEE yyyy-MM-dd"),
    products: list.map((p, i) => ({ n: i + 1, name: p.name, sizes: formatSizes(p.sizes) })),
    openMenu: open ? { date: open.date, status: open.status, dishes: dishes(open.items) } : null,
    lastMenu: last ? { date: last.date, dishes: dishes(last.items) } : null,
  };
}

async function runAction(ctx: Ctx, phone: string, text: string, msgId: string, a: OwnerAction, list: Awaited<ReturnType<typeof activeProducts>>): Promise<ChatCommand | null> {
  const add = picksFromNumbers(a.dishes, list);
  const remove = picksFromNumbers(a.remove_dishes, list);
  const unknown = [...a.unknown, ...add.unknown, ...remove.unknown];
  switch (a.action) {
    case "add_products": {
      const { products, rejected } = cleanParsedProducts({ products: a.products }, text, list);
      await previewProducts(ctx, phone, mergeIntoExisting(products, list), rejected, msgId, false, list);
      return null;
    }
    case "edit_product": {
      // Name each draft after the dish she meant (by number), so the edit can't create a new dish.
      const named = a.products.map((p, i) => ({ ...p, name: list[(a.product_ns[i] ?? 0) - 1]?.name ?? p.name }));
      const { products, rejected } = cleanParsedProducts({ products: named }, text, list);
      await previewProducts(ctx, phone, products, rejected, msgId, true, list);
      return null;
    }
    case "remove_product": {
      const targets = a.product_ns.filter((n) => list[n - 1]);
      if (!targets.length) {
        await sendText(ctx, phone, "Which dish? Send /products to see the numbers, then e.g. *remove 3 from my dishes*.");
        return null;
      }
      for (const n of targets) await cmdRemoveProduct(ctx, phone, String(n));
      return null;
    }
    case "set_menu":
      await chatSetMenu(ctx, phone, a.day, add.picks, a.cutoff, unknown);
      return null;
    case "edit_menu":
      if (!add.picks.length && !remove.picks.length) {
        if (a.cutoff) await chatSetCutoff(ctx, phone, a.day, a.cutoff);
        else await sendText(ctx, phone, unknown.length ? `⚠️ Not in your dishes: ${unknown.join(", ")}. Send /products to see them.` : "What should I change on the menu?");
        return null;
      }
      await chatEditMenu(ctx, phone, a.day, add.picks, remove.picks, a.cutoff, unknown);
      return null;
    case "copy_menu":
      await chatCopyMenu(ctx, phone, a.copy_from, a.day, add.picks, remove.picks, a.cutoff, unknown);
      return null;
    case "set_cutoff":
      if (!a.cutoff) {
        await sendText(ctx, phone, "What time should orders close? e.g. *cutoff 10:30*");
        return null;
      }
      await chatSetCutoff(ctx, phone, a.day, a.cutoff);
      return null;
    case "show_products":
      await cmdProducts(ctx, phone);
      return null;
    case "show_menu":
      await chatShowMenu(ctx, phone);
      return null;
    case "how":
      return "HOW";
    case "what":
      return "WHAT";
    case "orders":
      return "ORDERS";
    case "message":
      return "MESSAGE";
    case "help":
      return "HELP";
    default:
      if (!a.reply?.trim()) return "HELP";
      await sendText(ctx, phone, a.reply.trim().slice(0, 500));
      return null;
  }
}
