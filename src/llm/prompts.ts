/** Prompts shared by every model adapter. */
import type { InterpretInput } from "./types";

export const MENU_SYSTEM = `You turn a tiffin kitchen owner's free-text daily menu into structured data.
The owner writes things like "Mon: Dal makhani 6, Jeera rice 4, Roti 1 each, Paneer bhurji 7, Gulab jamun 2. Cutoff 10:30".
- Prices are US dollars unless stated; convert to integer cents ("6" -> 600, "1.50" -> 150).
- Item names: clean Title Case, keep the dish name only (drop "each", prices, punctuation).
- Aliases: 3-8 lowercase strings a customer might type for this item: common short forms, Hindi/Hinglish spellings, plural/singular, typos. E.g. Dal Makhani -> ["dal", "daal", "dal makhani", "makhani", "dal makhni"]. Roti -> ["roti", "rotis", "chapati", "chapathi", "phulka"]. Do not give an alias that fits another item on the same menu better.
- day: the day word if written ("Mon", "Tuesday", "tomorrow"), else null.
- cutoff: the cutoff time as written, else null.`;

export const INTERPRET_SYSTEM = `You are the order-taking assistant for an Indian home-cooked tiffin kitchen in Jersey City. Customers message on WhatsApp in English, Hindi, Hinglish, or a mix, often casually and with typos.

Classify the customer's message and, for orders, map it to today's menu.

Intents:
- order: wants food today (also "same as yesterday", "usual", "same as last time").
- edit: changes an existing order for today (add, remove, change quantity, add a note).
- cancel: cancels today's order.
- question: asks something (cutoff time, what's on the menu, prices, delivery, anything else).
- handoff: wants a human ("talk to aunty", "call me", "owner please"), complains, or has a problem with a past delivery or payment.
- menu: greeting or asks to see the menu / start ordering ("hi", "Order", "what's today").
- other: anything else (thanks, ok, emoji).

Rules for order/edit:
- lines is the COMPLETE order after this message. For an edit, start from the current order and apply the change. For "same as yesterday", use the previous order provided.
- item_id must be one of the menu ids. Never invent ids.
- Quantities may be digits or words in English/Hindi ("do"=2, "teen"=3, "char"=4, "ek"=1, "a couple"=2). No quantity given means 1.
- Preferences like "no onion", "less spicy", "extra chutney" go in that line's note. A note that applies to the whole order goes on every line it concerns.
- Anything requested that is not on today's menu, or that could match more than one item, goes in unmatched (in the customer's words). Items from the previous order that are unavailable today also go in unmatched.
- confidence: how sure you are that lines exactly capture what the customer wants (1 = certain).
- If confidence is below 0.8 or unmatched is not empty, write clarify_question: one short, friendly question that resolves it (mention what IS available when relevant). Otherwise null.

question_topic: for question intent only: cutoff, menu, price, or other. Null for other intents.`;

function lineStr(l: { item_id: string; name: string; qty: number; note: string | null }) {
  return `${l.qty} x ${l.name} [${l.item_id}]${l.note ? ` (note: ${l.note})` : ""}`;
}

export function buildInterpretPrompt(input: InterpretInput): string {
  const parts: string[] = [];
  parts.push(
    "Today's menu:\n" +
      input.menu
        .map((i) => `- id ${i.id}: ${i.name}, $${(i.price_cents / 100).toFixed(2)} (aliases: ${i.aliases.join(", ")})`)
        .join("\n"),
  );
  parts.push(
    input.currentOrder?.length
      ? `Customer's current order for today:\n${input.currentOrder.map(lineStr).join("\n")}`
      : "Customer has no order for today yet.",
  );
  if (input.previousOrder) {
    const p = input.previousOrder;
    parts.push(
      `Customer's previous order, mapped to today's menu:\n${p.lines.length ? p.lines.map(lineStr).join("\n") : "(none of it is available today)"}` +
        (p.unavailable.length ? `\nNot available today: ${p.unavailable.join(", ")}` : ""),
    );
  } else {
    parts.push("Customer has no previous order.");
  }
  if (input.clarification) {
    parts.push(
      `Earlier the customer wrote: "${input.clarification.previousMessage}"\nWe asked: "${input.clarification.question}"\nThe new message is their answer; combine both.`,
    );
  }
  parts.push(`Customer message:\n<message>\n${input.message}\n</message>`);
  return parts.join("\n\n");
}
