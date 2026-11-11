import { createHash } from "node:crypto";
import type { MenuItem, OrderLine } from "../db/schema";
import { ruleInterpret } from "../llm/rules";
import { normalizePhone } from "../lib/phone";
import { formLabel } from "./menu";
import { nameKey, shortMoney } from "./products";

/** A WhatsForm submission read against the day's menu. Prices come from the menu, never the form. */
export type ParsedFormResponse = {
  responseKey: string;
  lines: OrderLine[];
  totalCents: number;
  phone: string | null;
  name: string | null;
  area: string | null;
  address: string | null;
  note: string | null;
  /** Fields that look like answers but matched nothing on the menu. */
  unmatched: string[];
};

/** Webhook body -> flat key/value pairs (nested objects and arrays are flattened). */
export function flattenFields(body: unknown, prefix = ""): [string, string][] {
  if (body === null || body === undefined) return [];
  if (typeof body !== "object") return prefix ? [[prefix, String(body)]] : [];
  if (Array.isArray(body)) {
    // [{question, answer}] / [{label, value}] shapes, or a plain list of values.
    const pairs: [string, string][] = [];
    for (const el of body) {
      if (el && typeof el === "object" && !Array.isArray(el)) {
        const o = el as Record<string, unknown>;
        const k = o.question ?? o.label ?? o.key ?? o.name ?? o.title;
        const v = o.answer ?? o.value ?? o.response;
        if (typeof k === "string" && v !== undefined && typeof v !== "object") {
          pairs.push([k, String(v)]);
          continue;
        }
      }
      pairs.push(...flattenFields(el, prefix));
    }
    return pairs;
  }
  return Object.entries(body as Record<string, unknown>).flatMap(([k, v]) => (v !== null && typeof v === "object" ? flattenFields(v, k) : [[k, String(v ?? "")]]));
}

const QTY_RE = /^\s*(\d{1,3})\s*$/;

/** Keys a menu item answers to: "Dal – 8oz – $6", "Dal – 8oz", "Dal 8oz", normalized. */
function itemKeys(i: MenuItem): string[] {
  const label = formLabel(i);
  return [...new Set([nameKey(`${label} ${shortMoney(i.price_cents)}`), nameKey(label), nameKey(i.name)])];
}

const FIELD: [keyof ParsedFormResponse, RegExp][] = [
  ["phone", /\b(phone|whatsapp|mobile|cell|contact number|number)\b/],
  ["name", /\bname\b/],
  ["area", /\b(area|locality|neighbou?rhood)\b/],
  ["address", /\b(address|pickup|delivery)\b/],
  ["note", /\b(note|notes|instruction|instructions|spice|allerg)/],
];
const RESPONSE_ID = /\bresponse (number|no|id)\b/;
/** The text question our form script fills ("Your order"), or the customer types into. */
const ORDER_TEXT = /^(your )?orders?( details)?$/;
const LINE_RE = /^(\d{1,3})\s*[×x*]\s*(.+)$/i;

/**
 * "2 × Dal 8oz, 4 × Roti (total $16)" -> quantities per menu item. Our form script
 * writes exactly that, with item names from the menu; anything else (a customer
 * typing "2 dal 8oz and 4 roti") goes through the strict order rules. Whatever
 * can't be read is returned as unmatched for the owner to look at.
 */
export function parseOrderText(text: string, items: MenuItem[]): { qty: Map<string, number>; unmatched: string[] } {
  const body = text.replace(/\s*\(?\btotal\b[^)]*\)?\s*$/i, "").trim();
  const qty = new Map<string, number>();
  if (!body) return { qty, unmatched: [] };
  const byName = new Map<string, MenuItem>();
  for (const i of items) for (const k of [nameKey(i.name), nameKey(formLabel(i))]) if (!byName.has(k)) byName.set(k, i);
  const parts = body.split(/\s*[,\n;]\s*/).filter(Boolean);
  const exact = parts.map((p) => {
    const m = p.match(LINE_RE);
    const item = m ? byName.get(nameKey(m[2]!)) : undefined;
    return m && item && Number(m[1]) > 0 ? { item, n: Number(m[1]) } : null;
  });
  if (exact.every(Boolean)) {
    for (const e of exact) qty.set(e!.item.id, (qty.get(e!.item.id) ?? 0) + e!.n);
    return { qty, unmatched: [] };
  }
  const ruled = ruleInterpret({ message: body, menu: items, currentOrder: null, previousOrder: null, clarification: null });
  if (ruled?.intent === "order" && ruled.lines.length) {
    for (const l of ruled.lines) qty.set(l.item_id, (qty.get(l.item_id) ?? 0) + l.qty);
    return { qty, unmatched: [] };
  }
  return { qty, unmatched: [`Order: ${body.slice(0, 300)}`] };
}
/** WhatsForm built-ins and totals we never treat as dishes. */
const IGNORE = /\b(response time|delivered to|total|payment|amount|time|date)\b/;

/**
 * Match a WhatsForm webhook body to the menu: number answers whose key is a menu
 * item's form label become order lines; name/phone/area/address/notes are picked
 * by key. Strict: a key must equal an item's label (with or without price).
 */
export function parseFormResponse(body: unknown, items: MenuItem[]): ParsedFormResponse {
  const fields = flattenFields(body);
  const byKey = new Map<string, MenuItem>();
  for (const i of items) for (const k of itemKeys(i)) if (!byKey.has(k)) byKey.set(k, i);

  const qty = new Map<string, number>();
  const out: ParsedFormResponse = { responseKey: "", lines: [], totalCents: 0, phone: null, name: null, area: null, address: null, note: null, unmatched: [] };
  let responseId: string | null = null;

  for (const [rawKey, rawVal] of fields) {
    const key = nameKey(rawKey);
    const val = rawVal.trim();
    if (!key) continue;
    const item = byKey.get(key);
    if (item) {
      const m = val.match(QTY_RE);
      if (m && Number(m[1]) > 0) qty.set(item.id, (qty.get(item.id) ?? 0) + Number(m[1]));
      else if (val && !m) out.unmatched.push(`${rawKey}: ${val}`);
      continue;
    }
    if (ORDER_TEXT.test(key)) {
      const t = parseOrderText(val, items);
      for (const [id, n] of t.qty) qty.set(id, (qty.get(id) ?? 0) + n);
      out.unmatched.push(...t.unmatched);
      continue;
    }
    if (RESPONSE_ID.test(key)) {
      responseId = val;
      continue;
    }
    if (IGNORE.test(key)) continue;
    const field = FIELD.find(([, re]) => re.test(key));
    if (field && val) {
      const [f] = field;
      if (f === "phone") out.phone ??= normalizePhone(val);
      else if (out[f] === null) (out as Record<string, unknown>)[f] = val.slice(0, 500);
      continue;
    }
    // A number answer under an unknown key is probably a dish whose question was renamed.
    if (QTY_RE.test(val) && Number(val) > 0) out.unmatched.push(`${rawKey}: ${val}`);
  }

  for (const i of items) {
    const n = qty.get(i.id);
    if (n) out.lines.push({ item_id: i.id, name: i.name, qty: n, unit_cents: i.price_cents, note: null });
  }
  out.totalCents = out.lines.reduce((s, l) => s + l.qty * l.unit_cents, 0);
  out.responseKey = responseId ? `wf:${responseId}` : `wf-hash:${createHash("sha256").update(JSON.stringify(body)).digest("hex").slice(0, 32)}`;
  return out;
}

export type PrepRow = { name: string; amount: string; detail: string };

const UNIT_RE = /^(\d+(?:\.\d+)?)\s*(oz|ml|l|ltr|g|gm|kg|lb|lbs)$/i;

/**
 * How much to make, per dish: sizes with a unit add up ("5×8oz + 1×10oz" -> "50 oz"),
 * other sizes are counted ("3× S, 2× L"), plain dishes are a count ("10").
 */
export function prepTotals(items: MenuItem[], lines: OrderLine[]): PrepRow[] {
  const count = new Map<string, number>();
  for (const l of lines) count.set(l.item_id, (count.get(l.item_id) ?? 0) + l.qty);
  const groups = new Map<string, { name: string; parts: { size: string | undefined; n: number }[] }>();
  for (const i of items) {
    const n = count.get(i.id);
    if (!n) continue;
    const key = i.product_id !== undefined ? `p${i.product_id}` : i.id;
    const name = i.size && i.name.endsWith(` ${i.size}`) ? i.name.slice(0, -i.size.length - 1) : i.name;
    const g = groups.get(key) ?? { name, parts: [] };
    g.parts.push({ size: i.size, n });
    groups.set(key, g);
  }
  return [...groups.values()].map(({ name, parts }) => {
    const units = parts.map((p) => p.size?.match(UNIT_RE));
    const unit = units[0]?.[2]?.toLowerCase();
    const detail = parts.map((p) => (p.size && !/^each$|^per\s/i.test(p.size) ? `${p.n}× ${p.size}` : `${p.n}`)).join(", ");
    if (unit && units.every((u) => u && u[2]!.toLowerCase() === unit)) {
      const total = parts.reduce((s, p, k) => s + p.n * Number(units[k]![1]), 0);
      return { name, amount: `${+total.toFixed(2)} ${unit}`, detail };
    }
    if (parts.length === 1 && (!parts[0]!.size || /^each$|^per\s/i.test(parts[0]!.size))) return { name, amount: String(parts[0]!.n), detail: "" };
    return { name, amount: `${parts.reduce((s, p) => s + p.n, 0)}`, detail };
  });
}
