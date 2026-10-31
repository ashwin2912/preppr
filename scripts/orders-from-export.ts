/**
 * Orders from WhatsApp "Export chat" files, without the bot: the owner
 * exports customer chats (Without media), we read the orders.
 *
 *   pnpm orders:from-export <file.txt | folder> [--date 2026-10-30 | --all] [--menu menu.txt]
 *                           [--owner "Tiffin Kitchen"] [--dmy] [--out orders.csv]
 *
 * The day's menu is found in the kitchen's own messages (the broadcast lands
 * in every chat); pass --menu if it isn't there. Default date: the latest day
 * with a menu. Prints the kitchen totals and writes one CSV row per order
 * (open it in Google Sheets). Needs a parser model in .env (ANTHROPIC_API_KEY
 * or LLM_*). Nothing is sent or stored.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { MenuItem } from "../src/db/schema";
import { guessOwner, parseChatExport } from "../src/domain/chatExport";
import { daySummary, detectDateOrder, extractOrders, findMenuTexts, ordersCsv, parseMenuText, type ExportChat } from "../src/domain/exportOrders";
import { loadDotEnv } from "../src/lib/env";
import { llmFromEnv } from "../src/llm";

loadDotEnv();
const args = process.argv.slice(2);
const VALUED = ["--date", "--menu", "--owner", "--out"];
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const input = args.find((a, i) => !a.startsWith("--") && !VALUED.includes(args[i - 1] ?? ""));
if (!input) {
  console.error("Usage: pnpm orders:from-export <file.txt | folder> [--date YYYY-MM-DD | --all] [--menu menu.txt] [--owner name] [--dmy] [--out orders.csv]");
  process.exit(1);
}
const picked = llmFromEnv();
if (!picked) {
  console.error("No parser model: set ANTHROPIC_API_KEY (or LLM_PROVIDER + LLM_API_KEY + LLM_MODEL) in .env");
  process.exit(1);
}
const { llm, label } = picked;

// iOS exports unzip to a folder per chat holding _chat.txt; Android gives "WhatsApp Chat with X.txt".
function txtFiles(path: string): string[] {
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path).flatMap((f) => {
    const p = join(path, f);
    if (statSync(p).isDirectory()) return txtFiles(p).map((x) => x);
    return f.endsWith(".txt") ? [p] : [];
  });
}
const chats: ExportChat[] = txtFiles(input).map((f) => ({
  file: basename(f) === "_chat.txt" ? basename(join(f, "..")) : basename(f),
  messages: parseChatExport(readFileSync(f, "utf8")),
}));
if (!chats.length) {
  console.error(`No .txt exports found in ${input}. Unzip iOS exports first.`);
  process.exit(1);
}

const owner = flag("--owner") ?? guessOwner(chats.map((c) => c.messages));
if (!owner) {
  console.error('Couldn\'t tell which author is the kitchen; pass --owner "<name as it appears in the export>"');
  process.exit(1);
}
const order = args.includes("--dmy") ? "dmy" : detectDateOrder(chats);
console.log(`Parser: ${label}. Kitchen account: ${owner}. ${chats.length} chats. Dates read as ${order}.`);

const menuTexts = findMenuTexts(chats, owner, order);
const menuFile = flag("--menu");
let dates: string[];
if (args.includes("--all")) dates = [...menuTexts.keys()].sort();
else if (flag("--date")) dates = [flag("--date")!];
else {
  const latest = [...menuTexts.keys()].sort().at(-1);
  if (!latest && !menuFile) {
    console.error("No menu message found in the exports. Pass --menu menu.txt and --date YYYY-MM-DD.");
    process.exit(1);
  }
  dates = latest ? [latest] : [];
}
if (!dates.length) {
  console.error("Pass --date YYYY-MM-DD.");
  process.exit(1);
}

const menus = new Map<string, MenuItem[]>();
const fileItems = menuFile ? await parseMenuText(llm, readFileSync(menuFile, "utf8")) : null;
for (const date of dates) {
  const text = menuTexts.get(date);
  const items = fileItems ?? (text ? await parseMenuText(llm, text) : []);
  menus.set(date, items);
  console.log(`\nMenu ${date}: ${items.length ? items.map((i) => `${i.name} $${(i.price_cents / 100).toFixed(2)}`).join(", ") : "none found"}`);
}

const orders = await extractOrders(llm, chats, owner, menus, order, dates);
for (const date of dates) console.log(`\n${daySummary(date, orders)}`);

const out = flag("--out") ?? `orders-${dates.length === 1 ? dates[0] : `${dates[0]}_to_${dates.at(-1)}`}.csv`;
writeFileSync(out, ordersCsv(orders));
console.log(`\nWrote ${orders.length} rows to ${out}. Rows marked "check" need a look.`);
process.exit(0);
