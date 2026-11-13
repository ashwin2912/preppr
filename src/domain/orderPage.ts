import { createHash, randomBytes } from "node:crypto";
import type { MenuItem } from "../db/schema";
import { MAX_QTY } from "./order";

/** Pure helpers for the /order page: device tokens, masking, form fields. */

/** 256-bit random device token for the cookie; only its hash is stored. */
export const newDeviceToken = () => randomBytes(32).toString("base64url");
export const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");

/** "Priya" -> "P***a": enough for a customer to recognise, not enough to learn a name. */
export function maskName(name: string | null): string | null {
  const t = name?.trim();
  if (!t) return null;
  if (t.length <= 2) return `${t[0]}*`;
  return `${t[0]}***${t[t.length - 1]}`;
}

/** "12 Oak St Apt 4" -> "…Apt 4": the last two words only (one for short addresses), never a house number alone. */
export function maskAddress(address: string | null): string | null {
  const words = address?.trim().split(/\s+/).filter(Boolean) ?? [];
  if (!words.length) return null;
  const tail = words.slice(words.length > 3 ? -2 : -1);
  if (tail.every((w) => /^\d+$/.test(w))) return "…";
  return `…${tail.join(" ")}`;
}

/** Last 4 digits of a phone, for "ending 0123". */
export const phoneTail = (e164: string) => e164.replace(/\D/g, "").slice(-4);

/** Trim, fold whitespace, cap length; empty -> null. */
export function cleanText(s: string | undefined, max: number): string | null {
  const t = (s ?? "").replace(/\s+/g, " ").trim().slice(0, max);
  return t ? t : null;
}

/**
 * Quantity fields (`q_<item id>`) -> raw lines for priceLines. Blank and 0 are
 * skipped; anything else that isn't a whole number in range is a problem.
 * Prices never come from the form.
 */
export function linesFromForm(form: Record<string, string>, items: MenuItem[]) {
  const raw: { item_id: string; qty: number; note: null }[] = [];
  const problems: string[] = [];
  for (const [k, v] of Object.entries(form)) {
    if (!k.startsWith("q_")) continue;
    const id = k.slice(2);
    const t = v.trim();
    if (!t || t === "0") continue;
    const qty = /^\d{1,3}$/.test(t) ? Number(t) : NaN;
    const item = items.find((i) => i.id === id);
    if (!item) problems.push("A dish on the page isn't on today's menu any more. Reload and try again.");
    else if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) problems.push(`${item.name}: pick between 1 and ${MAX_QTY}.`);
    else raw.push({ item_id: id, qty, note: null });
  }
  return { raw, problems: [...new Set(problems)] };
}
