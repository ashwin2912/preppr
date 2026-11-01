/**
 * A synthetic iPhone backup for tests: WhatsApp Business and regular WhatsApp
 * chat databases, Manifest.db, Manifest.plist and Status.plist, either plain
 * or encrypted the way iOS 10.2+ does it (inverse of src/backup/crypto.ts).
 */
import { createCipheriv, createHash, pbkdf2Sync, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Uid, type PlistValue } from "../src/backup/plist";
import { openDb } from "../src/backup/sqlite";
import { APPLE_EPOCH } from "../src/backup/whatsapp";

export const SMB_DOMAIN = "AppDomainGroup-group.net.whatsapp.WhatsAppSMB.shared";
export const CONSUMER_DOMAIN = "AppDomainGroup-group.net.whatsapp.WhatsApp.shared";
export const MENU = "Fri menu 🍛\nDal Makhani $6\nJeera Rice $4\nRoti $1\nPaneer Bhurji $7\nOrder by 10:30";

// ---- binary plist writer ----

export function writeBplist(root: PlistValue): Buffer {
  const objs: Buffer[] = [];
  const REF = 2;
  const ref = (i: number) => {
    const b = Buffer.alloc(REF);
    b.writeUInt16BE(i);
    return b;
  };
  const intBytes = (n: number) => {
    if (n < 0x100) return Buffer.from([0x10, n]);
    if (n < 0x10000) return Buffer.concat([Buffer.from([0x11]), u(n, 2)]);
    if (n < 0x100000000) return Buffer.concat([Buffer.from([0x12]), u(n, 4)]);
    const b = Buffer.alloc(9);
    b[0] = 0x13;
    b.writeBigInt64BE(BigInt(n), 1);
    return b;
  };
  const u = (n: number, size: number) => {
    const b = Buffer.alloc(size);
    b.writeUIntBE(n, 0, size);
    return b;
  };
  const head = (type: number, n: number) => (n < 15 ? Buffer.from([(type << 4) | n]) : Buffer.concat([Buffer.from([(type << 4) | 0xf]), intBytes(n)]));
  function add(v: PlistValue): number {
    const i = objs.length;
    objs.push(Buffer.alloc(0));
    let out: Buffer;
    if (v === null) out = Buffer.from([0x00]);
    else if (v === true || v === false) out = Buffer.from([v ? 0x09 : 0x08]);
    else if (typeof v === "number" && Number.isInteger(v) && v >= 0) out = intBytes(v);
    else if (typeof v === "number") {
      out = Buffer.alloc(9);
      out[0] = 0x23;
      out.writeDoubleBE(v, 1);
    } else if (typeof v === "bigint") {
      out = Buffer.alloc(9);
      out[0] = 0x13;
      out.writeBigInt64BE(v, 1);
    } else if (v instanceof Date) {
      out = Buffer.alloc(9);
      out[0] = 0x33;
      out.writeDoubleBE(v.getTime() / 1000 - APPLE_EPOCH, 1);
    } else if (Buffer.isBuffer(v)) out = Buffer.concat([head(0x4, v.length), v]);
    else if (typeof v === "string") {
      if (/^[\x00-\x7f]*$/.test(v)) out = Buffer.concat([head(0x5, v.length), Buffer.from(v, "latin1")]);
      else {
        const b = Buffer.from(v, "utf16le").swap16();
        out = Buffer.concat([head(0x6, b.length / 2), b]);
      }
    } else if (v instanceof Uid) out = v.value < 256 ? Buffer.from([0x80, v.value]) : Buffer.concat([Buffer.from([0x81]), u(v.value, 2)]);
    else if (Array.isArray(v)) {
      const refs = v.map(add);
      out = Buffer.concat([head(0xa, v.length), ...refs.map(ref)]);
    } else {
      const entries = Object.entries(v);
      const keys = entries.map(([k]) => add(k));
      const vals = entries.map(([, x]) => add(x));
      out = Buffer.concat([head(0xd, entries.length), ...keys.map(ref), ...vals.map(ref)]);
    }
    objs[i] = out;
    return i;
  }
  add(root);
  const offsets: number[] = [];
  let at = 8;
  for (const o of objs) {
    offsets.push(at);
    at += o.length;
  }
  const table = Buffer.concat(offsets.map((o) => u(o, 4)));
  const trailer = Buffer.alloc(32);
  trailer[6] = 4;
  trailer[7] = REF;
  trailer.writeBigUInt64BE(BigInt(objs.length), 8);
  trailer.writeBigUInt64BE(0n, 16);
  trailer.writeBigUInt64BE(BigInt(at), 24);
  return Buffer.concat([Buffer.from("bplist00", "latin1"), ...objs, table, trailer]);
}

/** Manifest.db's per-file metadata (NSKeyedArchiver MBFile). */
export function mbFile(size: number, protectionClass: number, encryptionKey: Buffer | null): Buffer {
  const objects: PlistValue[] = ["$null"];
  const root: Record<string, PlistValue> = { Size: size, ProtectionClass: protectionClass, $class: new Uid(0) };
  objects.push(root);
  if (encryptionKey) {
    objects.push({ "NS.data": encryptionKey, $class: new Uid(4) });
    root.EncryptionKey = new Uid(2);
  } else objects.push("unused");
  objects.push({ $classname: "MBFile", $classes: ["MBFile", "NSObject"] });
  objects.push({ $classname: "NSMutableData", $classes: ["NSMutableData", "NSData", "NSObject"] });
  root.$class = new Uid(3);
  return writeBplist({ $version: 100000, $archiver: "NSKeyedArchiver", $top: { root: new Uid(1) }, $objects: objects });
}

// ---- crypto (inverse operations) ----

const WRAP_IV = Buffer.from("a6a6a6a6a6a6a6a6", "hex");
export const aesWrap = (kek: Buffer, key: Buffer) => {
  const c = createCipheriv("id-aes256-wrap", kek, WRAP_IV);
  return Buffer.concat([c.update(key), c.final()]);
};
const encryptCbc = (key: Buffer, data: Buffer) => {
  const c = createCipheriv("aes-256-cbc", key, Buffer.alloc(16));
  return Buffer.concat([c.update(data), c.final()]);
};
const tlv = (tag: string, v: Buffer | number) => {
  const val = typeof v === "number" ? Buffer.from([v >>> 24, (v >>> 16) & 255, (v >>> 8) & 255, v & 255]) : v;
  const h = Buffer.alloc(8);
  h.write(tag, 0, "latin1");
  h.writeUInt32BE(val.length, 4);
  return Buffer.concat([h, val]);
};

type Keys = { bag: Buffer; classKeys: Map<number, Buffer> };

function makeKeybag(password: string): Keys {
  const salt = randomBytes(20);
  const dpsl = randomBytes(20);
  const iter = 10;
  const dpic = 10;
  const pk = pbkdf2Sync(pbkdf2Sync(password, dpsl, dpic, 32, "sha256"), salt, iter, 32, "sha1");
  const classKeys = new Map<number, Buffer>();
  const parts = [tlv("VERS", 4), tlv("TYPE", 1), tlv("UUID", randomBytes(16)), tlv("HMCK", randomBytes(40)), tlv("WRAP", 0)];
  parts.push(tlv("SALT", salt), tlv("ITER", iter), tlv("DPWT", 1), tlv("DPIC", dpic), tlv("DPSL", dpsl));
  for (const clas of [1, 2, 3, 4]) {
    const k = randomBytes(32);
    classKeys.set(clas, k);
    parts.push(tlv("UUID", randomBytes(16)), tlv("CLAS", clas), tlv("WRAP", 2), tlv("KTYP", 0), tlv("WPKY", aesWrap(pk, k)));
  }
  return { bag: Buffer.concat(parts), classKeys };
}

// ---- WhatsApp chat database ----

export type FakeMessage = {
  /** UTC ISO time. */
  at: string;
  chat: string;
  fromMe?: boolean;
  member?: string;
  text: string | null;
  type?: number;
};
export type FakeChat = { key: string; jid: string; name: string; group?: boolean };
export type FakeMember = { key: string; jid: string; name: string };

export function writeChatDb(
  path: string,
  data: { chats: FakeChat[]; members: FakeMember[]; messages: FakeMessage[] },
  opts: { dropColumn?: string } = {},
) {
  rmSync(path, { force: true });
  const db = openDb(path, { write: true });
  const msgCols = ["Z_PK INTEGER PRIMARY KEY", "ZCHATSESSION INTEGER", "ZISFROMME INTEGER", "ZFROMJID TEXT", "ZTEXT TEXT", "ZMESSAGEDATE REAL", "ZGROUPMEMBER INTEGER", "ZMESSAGETYPE INTEGER"].filter(
    (c) => !opts.dropColumn || !c.startsWith(`${opts.dropColumn} `),
  );
  db.run(`CREATE TABLE ZWACHATSESSION (Z_PK INTEGER PRIMARY KEY, ZCONTACTJID TEXT, ZPARTNERNAME TEXT, ZSESSIONTYPE INTEGER)`);
  db.run(`CREATE TABLE ZWAGROUPMEMBER (Z_PK INTEGER PRIMARY KEY, ZMEMBERJID TEXT, ZCONTACTNAME TEXT, ZCHATSESSION INTEGER)`);
  db.run(`CREATE TABLE ZWAMESSAGE (${msgCols.join(", ")})`);
  const chatPk = new Map(data.chats.map((c, i) => [c.key, i + 1]));
  const memberPk = new Map(data.members.map((m, i) => [m.key, i + 1]));
  data.chats.forEach((c, i) => db.run(`INSERT INTO ZWACHATSESSION VALUES (?, ?, ?, ?)`, i + 1, c.jid, c.name, c.group ? 1 : 0));
  data.members.forEach((m, i) => db.run(`INSERT INTO ZWAGROUPMEMBER VALUES (?, ?, ?, NULL)`, i + 1, m.jid, m.name));
  data.messages.forEach((m, i) => {
    const row: Record<string, unknown> = {
      Z_PK: i + 1,
      ZCHATSESSION: chatPk.get(m.chat)!,
      ZISFROMME: m.fromMe ? 1 : 0,
      ZFROMJID: null,
      ZTEXT: m.text,
      ZMESSAGEDATE: Date.parse(m.at) / 1000 - APPLE_EPOCH,
      ZGROUPMEMBER: m.member ? memberPk.get(m.member)! : null,
      ZMESSAGETYPE: m.type ?? 0,
    };
    const cols = Object.keys(row).filter((k) => k !== opts.dropColumn);
    db.run(`INSERT INTO ZWAMESSAGE (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`, ...cols.map((k) => row[k]));
  });
  db.close();
}

/** The scenario: kitchen in New York, menu broadcast on Fri 2026-10-30. */
export function scenario() {
  const chats: FakeChat[] = [
    { key: "priya", jid: "15551110001@s.whatsapp.net", name: "Priya" },
    { key: "rahul", jid: "15551110002@s.whatsapp.net", name: "Rahul" },
    { key: "meera", jid: "15551110003@s.whatsapp.net", name: "Meera" },
    { key: "kiran", jid: "15551110005@s.whatsapp.net", name: "Kiran" },
    { key: "office", jid: "120363000000000001@g.us", name: "Office Lunch", group: true },
    { key: "status", jid: "status@broadcast", name: "Status" },
  ];
  const members: FakeMember[] = [
    { key: "arjun", jid: "15551110004@s.whatsapp.net", name: "Arjun" },
    { key: "sana", jid: "98765432101234@lid", name: "Sana" },
    { key: "priya", jid: "15551110001@s.whatsapp.net", name: "Priya" },
  ];
  const messages: FakeMessage[] = [
    // Thu 10-29 (yesterday) and a message at 23:50 New York time, which is already 10-30 in UTC.
    { at: "2026-10-29T15:00:00Z", chat: "priya", text: "5 roti" },
    { at: "2026-10-30T03:50:00Z", chat: "kiran", text: "2 roti" },
    // Fri 10-30, 7:30 AM EDT: the menu broadcast to every chat, plus one other priced note.
    ...["priya", "rahul", "meera", "office"].map((chat) => ({ at: "2026-10-30T11:30:00Z", chat, fromMe: true, text: MENU })),
    { at: "2026-10-30T11:31:00Z", chat: "priya", fromMe: true, text: "Tomorrow: Biryani $9\nRaita $2" },
    { at: "2026-10-30T12:14:00Z", chat: "priya", text: "2 dal, 3 roti" },
    { at: "2026-10-30T12:15:00Z", chat: "priya", text: null, type: 1 }, // a photo
    { at: "2026-10-30T12:20:00Z", chat: "rahul", text: "1 rice" },
    { at: "2026-10-30T13:05:00Z", chat: "rahul", text: "cancel" },
    { at: "2026-10-30T12:40:00Z", chat: "meera", text: "2 biryani" },
    { at: "2026-10-30T12:50:00Z", chat: "office", member: "arjun", text: "1 paneer" },
    { at: "2026-10-30T12:51:00Z", chat: "office", member: "sana", text: "2 roti" },
    { at: "2026-10-30T12:52:00Z", chat: "office", member: "priya", text: "thanks" },
    { at: "2026-10-30T12:53:00Z", chat: "status", text: "status text" },
    // Sat 10-31 00:30 EDT: tomorrow already.
    { at: "2026-10-31T04:30:00Z", chat: "meera", text: "3 roti" },
  ];
  return { chats, members, messages };
}

export type BuiltBackup = { dir: string; password?: string };

/**
 * Write a backup folder under `root`. The WhatsApp Business database holds
 * the scenario; the regular WhatsApp app has an unrelated chat.
 */
export function buildBackup(root: string, opts: { encrypted?: boolean; password?: string; chatDb?: string; date?: Date; consumerOnly?: boolean } = {}): BuiltBackup {
  const dir = join(root, "00008110-000A1B2C3D4E5F60");
  mkdirSync(dir, { recursive: true });
  const work = join(root, "work");
  mkdirSync(work, { recursive: true });

  let chatDb = opts.chatDb;
  if (!chatDb) {
    chatDb = join(work, "smb.sqlite");
    writeChatDb(chatDb, scenario());
  }
  const consumerDb = join(work, "consumer.sqlite");
  writeChatDb(consumerDb, {
    chats: [{ key: "x", jid: "15559990000@s.whatsapp.net", name: "Friend" }],
    members: [],
    messages: [{ at: "2026-10-30T12:00:00Z", chat: "x", text: "hi" }],
  });

  const keys = opts.encrypted ? makeKeybag(opts.password ?? "kitchen-1234") : null;
  const manifestPath = join(work, "Manifest.db");
  rmSync(manifestPath, { force: true });
  const manifest = openDb(manifestPath, { write: true });
  manifest.run(`CREATE TABLE Files (fileID TEXT PRIMARY KEY, domain TEXT, relativePath TEXT, flags INTEGER, file BLOB)`);
  const addFile = (domain: string, relativePath: string, content: Buffer) => {
    const fileID = createHash("sha1").update(`${domain}-${relativePath}`).digest("hex");
    mkdirSync(join(dir, fileID.slice(0, 2)), { recursive: true });
    let stored = content;
    let meta: Buffer;
    if (keys) {
      const fileKey = randomBytes(32);
      const clas = 3;
      const blob = Buffer.concat([Buffer.from([clas, 0, 0, 0]), aesWrap(keys.classKeys.get(clas)!, fileKey)]);
      stored = encryptCbc(fileKey, content);
      meta = mbFile(content.length, clas, blob);
    } else meta = mbFile(content.length, 3, null);
    writeFileSync(join(dir, fileID.slice(0, 2), fileID), stored);
    manifest.run(`INSERT INTO Files VALUES (?, ?, ?, 1, ?)`, fileID, domain, relativePath, meta);
  };
  if (!opts.consumerOnly) addFile(SMB_DOMAIN, "ChatStorage.sqlite", readFileSync(chatDb));
  addFile(CONSUMER_DOMAIN, opts.consumerOnly ? "ChatStorage.sqlite" : "ChatStorage.sqlite", readFileSync(opts.consumerOnly ? chatDb : consumerDb));
  addFile("HomeDomain", "Library/Preferences/x.plist", Buffer.from("not whatsapp"));
  manifest.close();

  const plist: Record<string, PlistValue> = { IsEncrypted: Boolean(keys), Version: "10.0" };
  if (keys) {
    const mk = randomBytes(32);
    plist.BackupKeyBag = keys.bag;
    plist.ManifestKey = Buffer.concat([Buffer.from([4, 0, 0, 0]), aesWrap(keys.classKeys.get(4)!, mk)]);
    writeFileSync(join(dir, "Manifest.db"), encryptCbc(mk, readFileSync(manifestPath)));
  } else writeFileSync(join(dir, "Manifest.db"), readFileSync(manifestPath));
  writeFileSync(join(dir, "Manifest.plist"), writeBplist(plist));
  writeFileSync(join(dir, "Status.plist"), writeBplist({ Date: opts.date ?? new Date("2026-10-30T17:00:00Z"), IsFullBackup: false }));
  rmSync(work, { recursive: true, force: true });
  return { dir, password: keys ? opts.password ?? "kitchen-1234" : undefined };
}
