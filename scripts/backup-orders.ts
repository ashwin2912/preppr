/**
 * preppr-orders: today's customer orders from the newest iPhone backup on
 * this Mac, written to ~/Desktop/Orders as CSV. Ships as one binary
 * (pnpm build:mac); in development: pnpm orders:from-backup [flags].
 *
 *   preppr-orders [--date YYYY-MM-DD] [--check] [--backup <dir>] [--out <dir>] [--no-open]
 *   preppr-orders --save-password
 *
 * The model key comes from ~/.preppr/config.env (LLM_PROVIDER, ANTHROPIC_API_KEY, ...).
 * Message text is never logged.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { backupRoot, findBackup, OwnerError, openBackup, withTempDir } from "../src/backup/backup";
import { WrongPassword } from "../src/backup/crypto";
import { keychainPassword, saveKeychainPassword } from "../src/backup/keychain";
import { openWithMac, runCheck, runOrders, type RunDeps } from "../src/backup/run";
import { loadDotEnv } from "../src/lib/env";
import { llmFromEnv } from "../src/llm";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const home = homedir();
loadDotEnv(join(home, ".preppr", "config.env"));
if (process.env.npm_lifecycle_event) loadDotEnv(); // dev (pnpm orders:from-backup): the repo's .env

const deps: RunDeps = {
  now: () => new Date(),
  tz: process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone,
  home,
  getPassword: () => keychainPassword(),
  print: (l) => console.log(l),
  openFile: args.includes("--no-open") ? undefined : openWithMac,
};
const opts = { date: flag("--date"), backup: flag("--backup"), out: flag("--out") };

async function main(): Promise<number> {
  if (opts.date && !/^\d{4}-\d{2}-\d{2}$/.test(opts.date)) throw new OwnerError("--date must look like 2026-10-30");
  if (args.includes("--help") || args.includes("-h")) {
    console.log("preppr-orders [--date YYYY-MM-DD] [--check] [--backup <dir>] [--out <dir>] [--no-open]\npreppr-orders --save-password");
    return 0;
  }
  if (args.includes("--save-password")) {
    console.log("Type the iPhone backup password (the one set in Finder). It won't show as you type.");
    if (!saveKeychainPassword()) throw new OwnerError("The password wasn't saved. Try again.");
    let backup: { dir: string } | null = null;
    try {
      backup = opts.backup ? { dir: opts.backup } : findBackup(backupRoot(home));
    } catch {
      console.log("Saved. (Couldn't open a backup to test it yet; it will be checked on the first run.)");
      return 0;
    }
    console.log("Saved. Checking it against the backup (takes a few seconds)…");
    await withTempDir(async (tmp) => openBackup(backup!.dir, tmp, deps.getPassword).close());
    console.log("The password works.");
    return 0;
  }
  if (args.includes("--check")) {
    await runCheck(opts, deps);
    return 0;
  }
  const picked = llmFromEnv();
  if (!picked) throw new OwnerError(`No model key yet: add ANTHROPIC_API_KEY to ${join(home, ".preppr", "config.env")}.`);
  console.log("Reading today's orders…");
  await runOrders(opts, picked.llm, deps);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    if (e instanceof WrongPassword) console.error(`\n${e.message}\nIf it changed, save the new one: ~/Preppr/preppr-orders --save-password`);
    else if (e instanceof OwnerError) console.error(`\n${e.message}`);
    else console.error(`\nSomething went wrong: ${e instanceof Error ? e.message : String(e)}\nSend a photo of this window to Ashwin.`);
    process.exit(1);
  },
);
