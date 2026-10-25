/**
 * Read WhatsApp "Export chat" files (Without media) from the owner's phone.
 *
 *   pnpm import:chat-export <file.txt | folder> [--owner "Tiffin Kitchen"] [--fixtures out.json]
 *
 * Default: lists each chat with message counts, so you can spot regulars who
 * aren't imported as customers yet. With --fixtures: writes the customers'
 * messages, anonymized, as draft parser cases to label and copy into
 * test/fixtures/orders.json. Nothing is written to the database.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { anonymize, guessOwner, parseChatExport } from "../src/domain/chatExport";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const input = args.find((a, i) => !a.startsWith("--") && !["--owner", "--fixtures"].includes(args[i - 1] ?? ""));
if (!input) {
  console.error('Usage: pnpm import:chat-export <file.txt | folder> [--owner "Kitchen name"] [--fixtures out.json]');
  process.exit(1);
}
const files = statSync(input).isDirectory()
  ? readdirSync(input).filter((f) => f.endsWith(".txt")).map((f) => join(input, f))
  : [input];
const chats = files.map((f) => ({ file: basename(f), messages: parseChatExport(readFileSync(f, "utf8")) }));
const owner = flag("--owner") ?? guessOwner(chats.map((c) => c.messages));
if (!owner) {
  console.error("Couldn't tell which author is the kitchen; pass --owner \"<name as it appears in the export>\"");
  process.exit(1);
}
console.log(`Kitchen account: ${owner}\n`);

const out = flag("--fixtures");
const seen = new Set<string>();
const cases: { message: string; expect: Record<string, never>; _chat: number }[] = [];
chats.forEach((c, i) => {
  const authors = [...new Set(c.messages.map((m) => m.author))];
  const fromCustomer = c.messages.filter((m) => m.author !== owner);
  console.log(`${c.file}: ${fromCustomer.length} from ${authors.filter((a) => a !== owner).join(", ") || "nobody"}, ${c.messages.length - fromCustomer.length} from the kitchen`);
  for (const m of fromCustomer) {
    const message = anonymize(m.text, [...authors, c.file.replace(/^WhatsApp Chat (with|-) /i, "").replace(/\.txt$/, "")]);
    if (message.length > 300 || seen.has(message.toLowerCase())) continue;
    seen.add(message.toLowerCase());
    cases.push({ message, expect: {}, _chat: i + 1 });
  }
});

if (out) {
  writeFileSync(out, `${JSON.stringify({ _comment: "Fill in expect for each case (see test/fixtures/orders.json), check nothing personal is left, then copy into the fixtures.", cases }, null, 2)}\n`);
  console.log(`\nWrote ${cases.length} distinct customer messages to ${out}`);
}
