/** Parsing WhatsApp's "Export chat" .txt files (iOS and Android formats). */

export type ExportedMessage = { at: string; author: string; text: string };

// iOS:     [10/23/26, 8:14:02 AM] Priya: text
// Android: 10/23/26, 8:14 AM - Priya: text   (also 23/10/2026, 08:14 - …)
const IOS = /^\[(\d{1,4}[./-]\d{1,2}[./-]\d{1,4},? \d{1,2}:\d{2}(?::\d{2})?(?:\s?[AP]M)?)\] ([^:]+?): ([\s\S]*)$/i;
const ANDROID = /^(\d{1,4}[./-]\d{1,2}[./-]\d{1,4},? \d{1,2}:\d{2}(?::\d{2})?(?:\s?[AP]M)?) - ([^:]+?): ([\s\S]*)$/i;
// A line that starts a new entry but has no "Name:" (encryption notice, "X added Y", …).
const SYSTEM = /^(\[\d{1,4}[./-]\d{1,2}[./-]\d{1,4},? \d{1,2}:\d{2}|\d{1,4}[./-]\d{1,2}[./-]\d{1,4},? \d{1,2}:\d{2}.* - )/;

const MEDIA = /^(<media omitted>|<attached: .*>|(image|video|audio|sticker|gif|document|contact card) omitted|this message was deleted|you deleted this message|null)$/i;

/** Invisible marks WhatsApp sprinkles into exports, and the narrow no-break space before AM/PM. */
const clean = (s: string) => s.replace(/[‎‏‪-‮]/g, "").replace(/[  ]/g, " ");

export function parseChatExport(text: string): ExportedMessage[] {
  const out: ExportedMessage[] = [];
  for (const raw of clean(text).replace(/\r\n?/g, "\n").split("\n")) {
    const m = raw.match(IOS) ?? raw.match(ANDROID);
    if (m) {
      out.push({ at: m[1]!, author: m[2]!.trim(), text: m[3]! });
    } else if (SYSTEM.test(raw)) {
      continue;
    } else if (out.length) {
      out.at(-1)!.text += `\n${raw}`; // continuation of a multi-line message
    }
  }
  return out.map((m) => ({ ...m, text: m.text.trim() })).filter((m) => m.text && !MEDIA.test(m.text));
}

/** The author with the most messages across all chats: the kitchen's own account. */
export function guessOwner(chats: ExportedMessage[][]): string | null {
  const n = new Map<string, number>();
  for (const chat of chats) for (const a of new Set(chat.map((m) => m.author))) n.set(a, (n.get(a) ?? 0) + 1);
  const [best] = [...n].sort((a, b) => b[1] - a[1]);
  return best && best[1] > 1 ? best[0] : null;
}

/** Mask phone numbers, emails and known names so messages can go in test fixtures. */
export function anonymize(text: string, names: string[]): string {
  let t = text
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "<email>")
    .replace(/\+?\(?\d[\d\s().-]{6,}\d/g, "<phone>");
  for (const name of names) {
    for (const part of name.split(/\s+/).filter((p) => p.length >= 3)) {
      t = t.replace(new RegExp(`\\b${part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi"), "<name>");
    }
  }
  return t;
}
