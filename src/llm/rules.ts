import type { MenuItem } from "../db/schema";
import { MAX_QTY } from "../domain/order";
import type { InterpretInput, Interpretation } from "./types";

/**
 * Deterministic first pass before the model. Handles the common simple
 * messages ("hi", "Order", "2 dal, 3 roti", "thanks") and returns null for
 * anything it isn't certain about, which then goes to the model. Strict on
 * purpose: one unrecognized word and the whole message goes to the model.
 */

const NUMBER_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, ek: 1,
  two: 2, do: 2,
  three: 3, teen: 3,
  four: 4, char: 4, chaar: 4,
  five: 5, paanch: 5, panch: 5,
  six: 6, chhe: 6, che: 6,
  seven: 7, saat: 7,
  eight: 8, aath: 8,
  nine: 9, nau: 9,
  ten: 10, das: 10,
};

const MENU_WORDS = /^(hi+|hii+|hello|helo|hey|namaste|order|menu|start|today'?s menu|what'?s today)( aunty| ji| there)?$/;
const OTHER_WORDS = /^(ok+|okay|k|thanks?|thank you( so much)?|thanku|ty|thx|great|perfect|cool)( aunty| ji)?$/;
const CANCEL_WORDS = /^(please )?cancel( my| the)?( order)?( for)?( today)?( please| pls| plz)?$/;
const EMOJI_ONLY = /^[\p{Extended_Pictographic}\p{Emoji_Modifier}‍️\s]+$/u;

const GREETING = /^(hi+|hello|hey|namaste)( aunty| ji)?[\s,!.]+/;
const POLITE_TAIL = /[\s,!.]+(please|pls|plz|thanks|thank you|ji)$/;

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/[^a-z0-9' ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

function base(intent: Interpretation["intent"]): Interpretation {
  return {
    intent,
    lines: [],
    unmatched: [],
    confidence: 1,
    question_topic: null,
    clarify_question: null,
    payment_cents: null,
    payment_method: null,
  };
}

/** The one menu item this name means, or null if none or more than one. */
function uniqueItem(name: string, menu: MenuItem[]): MenuItem | null {
  const tries = [name, name.replace(/e?s$/, "")];
  for (const n of tries) {
    const hits = menu.filter((i) => norm(i.name) === n || i.aliases.some((a) => norm(a) === n));
    if (hits.length === 1) return hits[0]!;
    if (hits.length > 1) return null;
  }
  return null;
}

const qtyOf = (t: string): number | null => {
  const n = /^\d+$/.test(t) ? Number(t) : NUMBER_WORDS[t];
  return n && n >= 1 && n <= MAX_QTY ? n : null;
};

/** "2 dal", "2x dal", "dal 2", "dal x2" → [qty, name]. */
function parsePair(chunk: string): [number, string] | null {
  const words = chunk.split(" ");
  if (words.length < 2) return null;
  const first = words[0]!.replace(/x$/, "");
  const last = words.at(-1)!.replace(/^x/, "");
  let q = qtyOf(first);
  if (q) {
    const rest = words.slice(1);
    if (rest[0] === "x") rest.shift();
    return rest.length ? [q, rest.join(" ")] : null;
  }
  q = qtyOf(last);
  if (q) {
    const rest = words.slice(0, -1);
    if (rest.at(-1) === "x") rest.pop();
    return rest.length ? [q, rest.join(" ")] : null;
  }
  return null;
}

/** Split "2 dal makhani 3 roti" at each number that starts a new item. Digits only. */
function splitOnDigits(chunk: string): string[] {
  const words = chunk.split(" ");
  const out: string[][] = [];
  for (const w of words) {
    if (/^\d+x?$/.test(w) && out.length && out.at(-1)!.length > 1) out.push([w]);
    else if (out.length) out.at(-1)!.push(w);
    else out.push([w]);
  }
  return out.map((p) => p.join(" "));
}

function parseOrder(text: string, menu: MenuItem[]): Interpretation | null {
  if (!menu.length) return null;
  const chunks = text
    .split(/\s*(?:,|&|\+|\n|;|\band\b|\baur\b|\bplus\b)\s*/)
    .map((c) => norm(c))
    .filter(Boolean)
    .flatMap(splitOnDigits);
  if (!chunks.length) return null;
  const qty = new Map<string, number>();
  for (const c of chunks) {
    const pair = parsePair(c);
    if (!pair) return null;
    const item = uniqueItem(pair[1], menu);
    if (!item) return null;
    qty.set(item.id, (qty.get(item.id) ?? 0) + pair[0]);
  }
  if ([...qty.values()].some((q) => q > MAX_QTY)) return null;
  return { ...base("order"), lines: [...qty].map(([item_id, q]) => ({ item_id, qty: q, note: null })) };
}

export function ruleInterpret(input: InterpretInput): Interpretation | null {
  // Answers to a question we asked need the context; leave those to the model.
  if (input.clarification) return null;
  const raw = input.message.trim();
  if (!raw || raw.length > 200) return null;
  if (EMOJI_ONLY.test(raw)) return base("other");

  const text = norm(raw);
  if (MENU_WORDS.test(text)) return base("menu");
  if (OTHER_WORDS.test(text)) return base("other");
  if (CANCEL_WORDS.test(text)) return base("cancel");

  // With an order already in place, "2 roti" could mean add or replace: ask the model.
  if (input.currentOrder?.length) return null;
  // Anything in brackets is usually a note ("no onion"): the model handles notes.
  if (/[()]/.test(raw)) return null;
  const body = raw.toLowerCase().replace(GREETING, "").replace(POLITE_TAIL, "");
  return parseOrder(body, input.menu);
}
