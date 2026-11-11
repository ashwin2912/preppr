/**
 * Strict code parser for the owner's plain-chat phrasings that need no model:
 * "today: dal, roti", "tomorrow dal and paneer cutoff 11", "same as yesterday",
 * "cutoff 10:30". Any doubt returns null so the model decides. The flow still
 * checks every dish against the product list before using a rule's answer.
 */

export type OwnerRule =
  | { action: "set_menu"; day: string; dishes: string; cutoff: string | null }
  | { action: "copy_menu"; from: string | null }
  | { action: "set_cutoff"; cutoff: string }
  | { action: "help" }
  | { action: "ack" };

const DAY = "today|tomorrow|tmrw|sun(?:day)?|mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:r|rs|rsday)?|fri(?:day)?|sat(?:urday)?";
const CLOCK = "\\d{1,2}(?:[:.]\\d{2})?\\s*(?:am|pm)?";

const MENU_RE = new RegExp(`^(${DAY})(?:'s)?(?:\\s+menu)?\\s*(?:[:\\-–]|\\s+is\\b|\\s)\\s*(.+)$`, "i");
const CUTOFF_TAIL_RE = new RegExp(`[.,]?\\s*\\b(?:cut-?off|by|till|until|before)\\s*(?:at\\s*)?:?\\s*(${CLOCK})\\s*\\.?\\s*$`, "i");
const CUTOFF_RE = new RegExp(`^(?:set\\s+)?(?:the\\s+)?cut-?off(?:\\s+time)?\\s*(?:at|is|to|:)?\\s*(${CLOCK})\\s*[.!]?$`, "i");
const SAME_RE = new RegExp(`^same(?:\\s+menu)?(?:\\s+as\\s+(yesterday|last\\s+time|last|(?:last\\s+)?(?:${DAY})))?(?:\\s+menu)?(?:\\s+(?:please|pls|plz))?[.!]?$`, "i");
const HELP_RE = /^(?:\/?help|\/?start|commands|menu\s+help|hi|hello|hey|namaste|\?+)[.!]?$/i;
const ACK_RE = /^(?:ok(?:ay)?|k|thanks?|thank\s+you|thx|ty|done|great|cool|perfect|nice|good|👍|🙏|👌|✅)(?:\s+(?:thanks?|you))?[.! ]*$/iu;

/** Words that mean the message is a change or a question, never a plain dish list. */
const NOT_A_LIST = /\b(?:no|not|without|except|but|remove|delete|drop|instead|change|price|add|same|what|how|\?)\b|\?/i;

export function ruleOwner(text: string): OwnerRule | null {
  const t = text.trim().replace(/\s+/g, " ");
  if (!t || t.length > 300) return null;
  if (HELP_RE.test(t)) return { action: "help" };
  if (ACK_RE.test(t)) return { action: "ack" };

  const cut = t.match(CUTOFF_RE);
  if (cut) return { action: "set_cutoff", cutoff: cut[1]!.replace(".", ":") };

  const same = t.match(SAME_RE);
  if (same) {
    const from = same[1]?.toLowerCase().replace(/^last\s+(?!time)/, "").replace(/^last\s+time$/, "last") ?? null;
    return { action: "copy_menu", from: from === "last" ? null : from };
  }

  const m = t.match(MENU_RE);
  if (m) {
    let dishes = m[2]!.trim();
    const c = dishes.match(CUTOFF_TAIL_RE);
    if (c) dishes = dishes.slice(0, c.index).trim();
    // A number after a word looks like a price or quantity ("dal 6"): not a plain pick list.
    if (!dishes || NOT_A_LIST.test(dishes) || /\$|\bdollars?\b|\p{L}\s+\d/u.test(dishes)) return null;
    return { action: "set_menu", day: m[1]!.toLowerCase().replace(/^tmrw$/, "tomorrow"), dishes, cutoff: c ? c[1]!.replace(".", ":") : null };
  }
  return null;
}
