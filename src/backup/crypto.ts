/**
 * Encrypted iPhone backups (iOS 10.2+), node:crypto only. The backup password
 * unlocks the keybag's class keys; each file's own key is wrapped with one of
 * them. Key unwrap (RFC 3394) is done on plain AES so it also runs under Bun.
 */
import { createDecipheriv, pbkdf2Sync } from "node:crypto";

export class WrongPassword extends Error {
  constructor() {
    super("That backup password didn't work.");
    this.name = "WrongPassword";
  }
}

export type ClassKey = { uuid: Buffer; clas: number; wrap: number; ktyp: number; wpky: Buffer };
export type Keybag = { salt: Buffer; iter: number; dpsl: Buffer; dpic: number; classes: ClassKey[] };

const INT_TAGS = new Set(["VERS", "TYPE", "WRAP", "ITER", "DPIC", "CLAS", "KTYP"]);

/** BackupKeyBag from Manifest.plist: 4-byte tag, 4-byte big-endian length, value. */
export function parseKeybag(buf: Buffer): Keybag {
  const top: Record<string, Buffer | number> = {};
  const classes: Record<string, Buffer | number>[] = [];
  let cur: Record<string, Buffer | number> | null = null;
  let seenUuid = false;
  for (let at = 0; at + 8 <= buf.length; ) {
    const tag = buf.toString("latin1", at, at + 4);
    const len = buf.readUInt32BE(at + 4);
    const raw = buf.subarray(at + 8, at + 8 + len);
    at += 8 + len;
    const v = INT_TAGS.has(tag) && len === 4 ? raw.readUInt32BE(0) : Buffer.from(raw);
    if (tag === "UUID") {
      if (!seenUuid) {
        seenUuid = true;
        top.UUID = v;
        continue;
      }
      cur = { UUID: v };
      classes.push(cur);
      continue;
    }
    (cur ?? top)[tag] = v;
  }
  const need = (o: Record<string, Buffer | number>, k: string) => {
    if (o[k] === undefined) throw new Error(`backup keybag is missing ${k}`);
    return o[k]!;
  };
  return {
    salt: need(top, "SALT") as Buffer,
    iter: need(top, "ITER") as number,
    dpsl: need(top, "DPSL") as Buffer,
    dpic: need(top, "DPIC") as number,
    classes: classes
      .filter((c) => c.WPKY && c.CLAS !== undefined)
      .map((c) => ({ uuid: c.UUID as Buffer, clas: c.CLAS as number, wrap: (c.WRAP as number) ?? 0, ktyp: (c.KTYP as number) ?? 0, wpky: c.WPKY as Buffer })),
  };
}

/** Key derived from the backup password: PBKDF2-SHA256 (DPSL, DPIC) then PBKDF2-SHA1 (SALT, ITER). */
export function passcodeKey(password: string, kb: Keybag): Buffer {
  const first = pbkdf2Sync(password, kb.dpsl, kb.dpic, 32, "sha256");
  return pbkdf2Sync(first, kb.salt, kb.iter, 32, "sha1");
}

const IV = Buffer.from("a6a6a6a6a6a6a6a6", "hex");

/** RFC 3394 AES key unwrap. Integrity check fails → WrongPassword (the usual cause). */
export function aesUnwrap(kek: Buffer, wrapped: Buffer): Buffer {
  if (wrapped.length < 24 || wrapped.length % 8) throw new Error("wrapped key has a bad length");
  const n = wrapped.length / 8 - 1;
  const aes = createDecipheriv(`aes-${kek.length * 8}-ecb`, kek, null).setAutoPadding(false);
  let a = Buffer.from(wrapped.subarray(0, 8));
  const r = Array.from({ length: n }, (_, i) => Buffer.from(wrapped.subarray(8 + i * 8, 16 + i * 8)));
  for (let j = 5; j >= 0; j--)
    for (let i = n; i >= 1; i--) {
      const t = BigInt(n * j + i);
      const x = Buffer.from(a);
      x.writeBigUInt64BE(x.readBigUInt64BE(0) ^ t);
      const b = aes.update(Buffer.concat([x, r[i - 1]!]));
      a = Buffer.from(b.subarray(0, 8));
      r[i - 1] = Buffer.from(b.subarray(8, 16));
    }
  if (!a.equals(IV)) throw new WrongPassword();
  return Buffer.concat(r);
}

/** Class keys by protection class, unlocked with the password. Wrong password → WrongPassword. */
export function unlockClassKeys(kb: Keybag, password: string): Map<number, Buffer> {
  const key = passcodeKey(password, kb);
  const out = new Map<number, Buffer>();
  for (const c of kb.classes) if (c.wrap & 2) out.set(c.clas, aesUnwrap(key, c.wpky));
  if (!out.size) throw new Error("backup keybag has no password-protected keys");
  return out;
}

/**
 * A key blob (4-byte little-endian class, then the wrapped key) → the key.
 * Files pass their ProtectionClass; ManifestKey uses the class in the blob.
 */
export function unwrapFileKey(blob: Buffer, classKeys: Map<number, Buffer>, clas = blob.readUInt32LE(0)): Buffer {
  const ck = classKeys.get(clas);
  if (!ck) throw new Error(`no key for protection class ${clas}`);
  return aesUnwrap(ck, blob.subarray(4));
}

/** AES-256-CBC with a zero IV, no padding removed. */
export function decryptCbc(key: Buffer, data: Buffer): Buffer {
  if (data.length % 16) throw new Error("encrypted file length isn't a multiple of 16");
  const d = createDecipheriv("aes-256-cbc", key, Buffer.alloc(16)).setAutoPadding(false);
  return Buffer.concat([d.update(data), d.final()]);
}

/** Drop PKCS#7 padding if it's there and valid. */
export function stripPkcs7(buf: Buffer): Buffer {
  const p = buf[buf.length - 1] ?? 0;
  if (p < 1 || p > 16 || p > buf.length) return buf;
  for (let i = buf.length - p; i < buf.length; i++) if (buf[i] !== p) return buf;
  return buf.subarray(0, buf.length - p);
}
