/**
 * iPhone backups made by Finder: find the newest one, read Manifest.db, and
 * copy single files out of it (decrypting when the backup is encrypted).
 * Nothing in the backup folder is ever written.
 */
import { chmodSync, copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decryptCbc, parseKeybag, stripPkcs7, unlockClassKeys, unwrapFileKey } from "./crypto";
import { parsePlist, unarchive, type PlistDict } from "./plist";
import { openDb, type Db } from "./sqlite";

/** An error whose message is written for the kitchen owner; print it as-is. */
export class OwnerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OwnerError";
  }
}

export const FULL_DISK_ACCESS = [
  "This Mac didn't let Preppr read the iPhone backup.",
  "",
  "To fix it (one time):",
  "  1. Open System Settings → Privacy & Security → Full Disk Access.",
  "  2. Turn on Terminal (click + and pick Applications → Utilities → Terminal if it isn't listed).",
  "  3. Quit Terminal completely (Terminal menu → Quit), then double-click \"Get today's orders\" again.",
].join("\n");

export const backupRoot = (home: string) => join(home, "Library", "Application Support", "MobileSync", "Backup");

const denied = (e: unknown) => ["EPERM", "EACCES"].includes((e as NodeJS.ErrnoException)?.code ?? "");

/** When the backup finished: Status.plist's Date, else the folder's modified time. */
export function backupDate(dir: string): Date {
  try {
    const d = (parsePlist(readFileSync(join(dir, "Status.plist"))) as PlistDict).Date;
    if (d instanceof Date && !Number.isNaN(d.getTime())) return d;
  } catch (e) {
    if (denied(e)) throw new OwnerError(FULL_DISK_ACCESS);
  }
  try {
    return statSync(join(dir, "Manifest.db")).mtime;
  } catch (e) {
    if (denied(e)) throw new OwnerError(FULL_DISK_ACCESS);
    return statSync(dir).mtime;
  }
}

/** The newest backup folder under `root` (the one holding Manifest.plist with the latest date). */
export function findBackup(root: string): { dir: string; date: Date } {
  let names: string[];
  try {
    names = readdirSync(root);
  } catch (e) {
    if (denied(e)) throw new OwnerError(FULL_DISK_ACCESS);
    throw new OwnerError("No iPhone backup on this Mac yet. Back up the iPhone in Finder first (see the instructions), then try again.");
  }
  const found: { dir: string; date: Date }[] = [];
  for (const n of names) {
    const dir = join(root, n);
    try {
      if (!statSync(join(dir, "Manifest.plist")).isFile()) continue;
    } catch (e) {
      if (denied(e)) throw new OwnerError(FULL_DISK_ACCESS);
      continue;
    }
    found.push({ dir, date: backupDate(dir) });
  }
  const newest = found.sort((a, b) => b.date.getTime() - a.date.getTime())[0];
  if (!newest) throw new OwnerError("No iPhone backup on this Mac yet. Back up the iPhone in Finder first (see the instructions), then try again.");
  return newest;
}

export type FileRow = { fileID: string; domain: string; relativePath: string; file: Uint8Array | null };

export type Backup = {
  dir: string;
  encrypted: boolean;
  manifest: Db;
  /** Copy one backed-up file to `dest` (decrypted). */
  extract(row: FileRow, dest: string): void;
  close(): void;
};

/**
 * Open a backup folder. Encrypted backups need the password (asked only then)
 * and decrypt Manifest.db into `tmp`. A wrong password throws WrongPassword.
 */
export function openBackup(dir: string, tmp: string, getPassword: () => string): Backup {
  let plist: PlistDict;
  try {
    plist = parsePlist(readFileSync(join(dir, "Manifest.plist"))) as PlistDict;
  } catch (e) {
    if (denied(e)) throw new OwnerError(FULL_DISK_ACCESS);
    throw new OwnerError("This iPhone backup looks damaged (Manifest.plist can't be read). Make a new backup in Finder.");
  }
  const encrypted = plist.IsEncrypted === true;
  const manifestPath = join(tmp, "Manifest.db");
  let classKeys: Map<number, Buffer> | null = null;
  if (encrypted) {
    const bag = plist.BackupKeyBag;
    const mk = plist.ManifestKey;
    if (!Buffer.isBuffer(bag) || !Buffer.isBuffer(mk)) throw new OwnerError("This encrypted backup is from an iOS version older than 10.2; update the iPhone and back up again.");
    classKeys = unlockClassKeys(parseKeybag(bag), getPassword());
    const key = unwrapFileKey(mk, classKeys);
    writeFileSync(manifestPath, stripPkcs7(decryptCbc(key, readFileSync(join(dir, "Manifest.db")))), { mode: 0o600 });
  } else {
    copyFileSync(join(dir, "Manifest.db"), manifestPath);
  }
  const manifest = openDb(manifestPath, { write: true });
  return {
    dir,
    encrypted,
    manifest,
    extract(row, dest) {
      const src = join(dir, row.fileID.slice(0, 2), row.fileID);
      if (!classKeys) {
        copyFileSync(src, dest);
        chmodSync(dest, 0o600);
        return;
      }
      if (!row.file) throw new Error(`no file info for ${row.relativePath}`);
      const meta = unarchive(Buffer.from(row.file));
      const blob = meta.EncryptionKey;
      if (!Buffer.isBuffer(blob)) throw new Error(`no encryption key for ${row.relativePath}`);
      const key = unwrapFileKey(blob, classKeys, Number(meta.ProtectionClass ?? blob.readUInt32LE(0)));
      const plain = decryptCbc(key, readFileSync(src));
      const size = Number(meta.Size ?? plain.length);
      writeFileSync(dest, plain.subarray(0, Math.min(size, plain.length)), { mode: 0o600 });
    },
    close: () => manifest.close(),
  };
}

export type WhatsAppFiles = {
  domain: string;
  /** Set when only the regular WhatsApp app (not WhatsApp Business) was found. */
  warning: string | null;
  db: FileRow;
  wal: FileRow | null;
  shm: FileRow | null;
  /** Every WhatsApp-looking domain holding a ChatStorage.sqlite. */
  domains: string[];
};

const CHAT_FILES = ["ChatStorage.sqlite", "ChatStorage.sqlite-wal", "ChatStorage.sqlite-shm"];

/** Where WhatsApp Business keeps its chats in this backup; regular WhatsApp only as a fallback. */
export function findWhatsApp(manifest: Db): WhatsAppFiles {
  const rows = manifest.all<FileRow>(
    `SELECT fileID, domain, relativePath, file FROM Files WHERE relativePath IN (?, ?, ?) AND lower(domain) LIKE '%whatsapp%'`,
    ...CHAT_FILES,
  );
  const domains = [...new Set(rows.filter((r) => r.relativePath === CHAT_FILES[0]).map((r) => r.domain))].sort();
  const business = domains.find((d) => d.toLowerCase().includes("whatsappsmb"));
  const domain = business ?? domains[0];
  if (!domain)
    throw new OwnerError(
      "No WhatsApp chats in this iPhone backup. Check that WhatsApp Business is on this iPhone, then make a new backup in Finder.",
    );
  const pick = (name: string) => rows.find((r) => r.domain === domain && r.relativePath === name) ?? null;
  return {
    domain,
    warning: business ? null : "Couldn't find WhatsApp Business in this backup; reading the regular WhatsApp app instead.",
    db: pick(CHAT_FILES[0]!)!,
    wal: pick(CHAT_FILES[1]!),
    shm: pick(CHAT_FILES[2]!),
    domains,
  };
}

/** Copy the chat database (and its -wal/-shm) into `tmp`; returns the path of the copy. */
export function extractChatDb(b: Backup, wa: WhatsAppFiles, tmp: string): string {
  const path = join(tmp, "ChatStorage.sqlite");
  b.extract(wa.db, path);
  if (wa.wal) b.extract(wa.wal, `${path}-wal`);
  if (wa.shm) b.extract(wa.shm, `${path}-shm`);
  return path;
}

/** Run `fn` with a private temp folder (mode 700) that is deleted afterwards, also on error or Ctrl-C. */
export async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "preppr-"));
  chmodSync(dir, 0o700);
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  const onSignal = () => {
    cleanup();
    process.exit(130);
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    return await fn(dir);
  } finally {
    cleanup();
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}
