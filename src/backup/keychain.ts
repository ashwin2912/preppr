/**
 * The backup password lives in the owner's macOS Keychain (service
 * "preppr-backup"), so it is typed once, hidden, into Apple's own prompt.
 */
import { spawnSync } from "node:child_process";
import { OwnerError } from "./backup";

const SERVICE = "preppr-backup";

/** The saved backup password. PREPPR_BACKUP_PASSWORD overrides it (development only). */
export function keychainPassword(env: NodeJS.ProcessEnv = process.env): string {
  if (env.PREPPR_BACKUP_PASSWORD) return env.PREPPR_BACKUP_PASSWORD;
  const r = spawnSync("security", ["find-generic-password", "-s", SERVICE, "-w"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const pw = r.status === 0 ? r.stdout.replace(/\n$/, "") : "";
  if (!pw)
    throw new OwnerError(
      "This iPhone backup is encrypted and the backup password isn't saved yet.\nRun this once in Terminal and type the password when asked:\n\n  ~/Preppr/preppr-orders --save-password\n",
    );
  return pw;
}

/**
 * Save (or replace) the password. `security` asks for it itself, twice,
 * without showing it, so it never passes through our process or arguments.
 */
export function saveKeychainPassword(): boolean {
  const r = spawnSync("security", ["add-generic-password", "-U", "-s", SERVICE, "-a", "backup", "-l", "Preppr iPhone backup password", "-w"], {
    stdio: "inherit",
  });
  return r.status === 0;
}
