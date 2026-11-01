/**
 * preppr-orders: today's orders from the newest iPhone backup → CSV files
 * the owner opens in Numbers/Excel/Sheets. Read-only on the backup.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "csv-parse/sync";
import { dailyCsv, extractFromInputs, findMenus, mergeAllOrders, orderStatus, parseMenuText } from "../domain/exportOrders";
import { money } from "../domain/order";
import { localDate } from "../lib/time";
import type { Llm } from "../llm/types";
import { backupDate, backupRoot, extractChatDb, findBackup, findWhatsApp, OwnerError, openBackup, withTempDir } from "./backup";
import { openDb } from "./sqlite";
import { checkSchema, dayStats, missingColumns, readInputs } from "./whatsapp";

export type RunDeps = {
  now: () => Date;
  tz: string;
  home: string;
  getPassword: () => string;
  print: (line: string) => void;
  /** Open a file for the owner (macOS `open`); omit to skip. */
  openFile?: (path: string) => void;
};

export type RunOpts = { date?: string; backup?: string; out?: string };

export const openWithMac = (path: string) => void spawnSync("open", [path], { stdio: "ignore" });

const pickBackup = (opts: RunOpts, deps: RunDeps) => (opts.backup ? { dir: opts.backup, date: backupDate(opts.backup) } : findBackup(backupRoot(deps.home)));

const when = (d: Date, tz: string) => d.toLocaleString("en-US", { timeZone: tz, dateStyle: "medium", timeStyle: "short" });

export type RunResult = { date: string; orders: number; totalCents: number; needCheck: number; dailyPath: string | null; allPath: string | null };

/** Read the day's orders and write `Orders <date>.csv` and `All orders.csv`. */
export async function runOrders(opts: RunOpts, llm: Llm, deps: RunDeps): Promise<RunResult> {
  const date = opts.date ?? localDate(deps.now(), deps.tz);
  const outDir = opts.out ?? join(deps.home, "Desktop", "Orders");
  const backup = pickBackup(opts, deps);
  deps.print(`iPhone backup from ${when(backup.date, deps.tz)}.`);
  if (localDate(backup.date, deps.tz) < date)
    deps.print(`⚠ That backup is older than ${date}. Back up the iPhone in Finder again to get today's messages.`);

  const inputs = await withTempDir(async (tmp) => {
    const b = openBackup(backup.dir, tmp, deps.getPassword);
    try {
      const wa = findWhatsApp(b.manifest);
      if (wa.warning) deps.print(`⚠ ${wa.warning}`);
      const db = openDb(extractChatDb(b, wa, tmp), { write: true });
      try {
        checkSchema(db);
        return readInputs(db, deps.tz, [date]);
      } finally {
        db.close();
      }
    } finally {
      b.close();
    }
  });

  const menuText = findMenus(inputs).get(date);
  if (!menuText) {
    deps.print(`No menu message from you on ${date} (a message with at least two dishes and prices). Nothing written.`);
    return { date, orders: 0, totalCents: 0, needCheck: 0, dailyPath: null, allPath: null };
  }
  const menu = await parseMenuText(llm, menuText);
  if (!menu.length) throw new OwnerError(`Found your menu for ${date} but couldn't read the dishes and prices from it.`);
  const orders = await extractFromInputs(llm, inputs, new Map([[date, menu]]), [date]);

  mkdirSync(outDir, { recursive: true });
  const dailyPath = join(outDir, `Orders ${date}.csv`);
  writeFileSync(dailyPath, dailyCsv(orders, menu));
  const allPath = join(outDir, "All orders.csv");
  const existing = existsSync(allPath) ? (parse(readFileSync(allPath, "utf8"), { relax_column_count: true, bom: true }) as string[][]).slice(1) : [];
  writeFileSync(allPath, mergeAllOrders(existing, date, orders));

  const real = orders.filter((o) => o.lines.length);
  const result = {
    date,
    orders: real.length,
    totalCents: real.reduce((s, o) => s + o.totalCents, 0),
    needCheck: orders.filter((o) => orderStatus(o) === "check").length,
    dailyPath,
    allPath,
  };
  deps.print(`Today: ${result.orders} orders, ${money(result.totalCents)}. ${result.needCheck} need a check.`);
  deps.print(`Saved to ${dailyPath}`);
  deps.openFile?.(dailyPath);
  return result;
}

/**
 * First-visit probe: what's in the backup, without the model and without
 * printing any message text, names or phone numbers.
 */
export async function runCheck(opts: RunOpts, deps: RunDeps): Promise<void> {
  const backup = pickBackup(opts, deps);
  deps.print(`Backup date: ${when(backup.date, deps.tz)}`);
  await withTempDir(async (tmp) => {
    const b = openBackup(backup.dir, tmp, deps.getPassword);
    try {
      deps.print(`Encrypted: ${b.encrypted ? "yes" : "no"}`);
      const wa = findWhatsApp(b.manifest);
      deps.print(`WhatsApp domains with chats: ${wa.domains.join(", ")}`);
      deps.print(`Reading: ${wa.domain}${wa.warning ? "  (⚠ not WhatsApp Business)" : ""}; WAL file: ${wa.wal ? "yes" : "no"}`);
      const db = openDb(extractChatDb(b, wa, tmp), { write: true });
      try {
        const missing = missingColumns(db);
        if (missing.length) {
          deps.print(`Database layout: missing ${missing.join(", ")}`);
          return;
        }
        deps.print("Database layout: ok");
        deps.print("Day          chats  1:1 msgs  group msgs  group members (phone / hidden)");
        for (const s of dayStats(db, deps.tz, deps.now()))
          deps.print(
            `${s.date}  ${String(s.chats).padStart(5)}  ${String(s.oneToOne).padStart(8)}  ${String(s.group).padStart(10)}  ${s.membersWithPhone} / ${s.membersHidden}`,
          );
      } finally {
        db.close();
      }
    } finally {
      b.close();
    }
  });
}
