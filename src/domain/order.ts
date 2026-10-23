import type { MenuItem, OrderLine } from "../db/schema";
import type { SimpleLine } from "../llm/types";

export const MAX_QTY = 50;

export const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

export const orderTotal = (lines: OrderLine[]) => lines.reduce((s, l) => s + l.qty * l.unit_cents, 0);

const cleanNote = (n: string | null | undefined) => {
  const t = n?.trim();
  return t ? t : null;
};

/**
 * Turn LLM lines into priced order lines using menu data only. Unknown item
 * ids or out-of-range quantities are returned as problems, never guessed.
 */
export function priceLines(
  raw: { item_id: string; qty: number; note: string | null }[],
  menu: MenuItem[],
): { lines: OrderLine[]; problems: string[] } {
  const byId = new Map(menu.map((i) => [i.id, i]));
  const lines: OrderLine[] = [];
  const problems: string[] = [];
  for (const r of raw) {
    const item = byId.get(r.item_id);
    if (!item) {
      problems.push(`unknown item ${r.item_id}`);
      continue;
    }
    if (!Number.isInteger(r.qty) || r.qty < 1 || r.qty > MAX_QTY) {
      problems.push(`${r.qty} × ${item.name}`);
      continue;
    }
    const note = cleanNote(r.note);
    const same = lines.find((l) => l.item_id === item.id && l.note === note);
    if (same) same.qty += r.qty;
    else lines.push({ item_id: item.id, name: item.name, qty: r.qty, unit_cents: item.price_cents, note });
  }
  return { lines, problems };
}

export function formatLines(lines: OrderLine[]): string {
  return lines
    .map((l) => `${l.qty} × ${l.name} — ${money(l.qty * l.unit_cents)}${l.note ? `\n    _${l.note}_` : ""}`)
    .join("\n");
}

/** Compact one-liner for owner lists: "2 Dal Makhani (no onion), 3 Roti". */
export const shortLines = (lines: OrderLine[]) =>
  lines.map((l) => `${l.qty} ${l.name}${l.note ? ` (${l.note})` : ""}`).join(", ");

export const toSimple = (lines: OrderLine[]): SimpleLine[] =>
  lines.map(({ item_id, name, qty, note }) => ({ item_id, name, qty, note }));

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();

/** Find today's menu item matching a dish name from another day. */
export function matchItem(name: string, menu: MenuItem[]): MenuItem | null {
  const n = norm(name);
  return (
    menu.find((i) => norm(i.name) === n) ??
    menu.find((i) => i.aliases.some((a) => norm(a) === n)) ??
    null
  );
}

/** Remap a previous order's lines onto today's menu ids by name/alias. */
export function remapLines(prev: OrderLine[], menu: MenuItem[]): { lines: SimpleLine[]; unavailable: string[] } {
  const lines: SimpleLine[] = [];
  const unavailable: string[] = [];
  for (const l of prev) {
    const item = matchItem(l.name, menu);
    if (item) lines.push({ item_id: item.id, name: item.name, qty: l.qty, note: l.note });
    else unavailable.push(l.name);
  }
  return { lines, unavailable };
}
