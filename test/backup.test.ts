import { createCipheriv, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findBackup, OwnerError, openBackup, withTempDir, findWhatsApp } from "../src/backup/backup";
import { aesUnwrap, WrongPassword } from "../src/backup/crypto";
import { parsePlist, Uid, unarchive } from "../src/backup/plist";
import { runCheck, runOrders, type RunDeps } from "../src/backup/run";
import { buildBackup, CONSUMER_DOMAIN, mbFile, scenario, SMB_DOMAIN, writeBplist, writeChatDb } from "./backupFixture";
import { FakeLlm } from "./helpers";

const roots: string[] = [];
const fresh = () => {
  const d = mkdtempSync(join(tmpdir(), "pfx-"));
  roots.push(d);
  return d;
};
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

const ourTemps = () => readdirSync(tmpdir()).filter((n) => n.startsWith("preppr-")).sort();

function deps(over: Partial<RunDeps> & { password?: string } = {}) {
  const lines: string[] = [];
  const opened: string[] = [];
  const d: RunDeps = {
    now: () => new Date("2026-10-30T18:00:00Z"), // 2 PM in New York
    tz: "America/New_York",
    home: fresh(),
    getPassword: () => {
      if (!over.password) throw new Error("password asked for an unencrypted backup");
      return over.password;
    },
    print: (l) => lines.push(l),
    openFile: (p) => opened.push(p),
    ...over,
  };
  return { d, lines, opened };
}

describe("plists", () => {
  it("reads binary plists and NSKeyedArchiver file info", () => {
    const v = { a: 1, big: 5_000_000_000, s: "héllo", d: Buffer.from([1, 2]), t: true, arr: [null, 1.5], when: new Date("2026-10-30T12:00:00Z"), u: new Uid(3) };
    const back = parsePlist(writeBplist(v)) as Record<string, unknown>;
    expect(back).toMatchObject({ a: 1, big: 5_000_000_000, s: "héllo", t: true, arr: [null, 1.5], u: new Uid(3) });
    expect((back.d as Buffer).equals(Buffer.from([1, 2]))).toBe(true);
    expect((back.when as Date).toISOString()).toBe("2026-10-30T12:00:00.000Z");

    const key = randomBytes(44);
    const meta = unarchive(mbFile(1234, 3, key));
    expect(meta.Size).toBe(1234);
    expect(meta.ProtectionClass).toBe(3);
    expect((meta.EncryptionKey as Buffer).equals(key)).toBe(true);
  });

  it("reads XML plists", () => {
    const xml = `<?xml version="1.0"?><!DOCTYPE plist><plist version="1.0"><dict>
      <key>IsEncrypted</key><false/><key>Date</key><date>2026-10-30T12:00:00Z</date>
      <key>Blob</key><data>AQI=</data><key>Name</key><string>a &amp; b</string><key>N</key><integer>7</integer>
      <key>List</key><array><string>x</string><true/></array></dict></plist>`;
    const v = parsePlist(Buffer.from(xml)) as Record<string, unknown>;
    expect(v).toMatchObject({ IsEncrypted: false, Name: "a & b", N: 7, List: ["x", true] });
    expect((v.Date as Date).toISOString()).toBe("2026-10-30T12:00:00.000Z");
    expect((v.Blob as Buffer).equals(Buffer.from([1, 2]))).toBe(true);
  });
});

describe("backup crypto", () => {
  it("key unwrap matches OpenSSL's AES key wrap", () => {
    const kek = randomBytes(32);
    const key = randomBytes(32);
    const c = createCipheriv("id-aes256-wrap", kek, Buffer.from("a6a6a6a6a6a6a6a6", "hex"));
    const wrapped = Buffer.concat([c.update(key), c.final()]);
    expect(aesUnwrap(kek, wrapped).equals(key)).toBe(true);
    expect(() => aesUnwrap(randomBytes(32), wrapped)).toThrow(WrongPassword);
  });

  it("wrong password: clear message, temp folder removed", async () => {
    const b = buildBackup(fresh(), { encrypted: true, password: "right" });
    const before = ourTemps();
    const { d } = deps({ password: "wrong" });
    const err = await runOrders({ backup: b.dir }, new FakeLlm(), d).catch((e) => e);
    expect(err).toBeInstanceOf(WrongPassword);
    expect(err.message).toBe("That backup password didn't work.");
    expect(ourTemps()).toEqual(before);
  });
});

describe("finding the backup and the chats", () => {
  it("picks the newest backup by Status.plist date", () => {
    const root = fresh();
    const older = join(root, "old");
    const a = buildBackup(join(root, "a"), { date: new Date("2026-10-30T17:00:00Z") });
    const b = buildBackup(older, { date: new Date("2026-10-20T17:00:00Z") });
    // Put both device folders side by side.
    const all = fresh();
    for (const [src, name] of [
      [a.dir, "NEW"],
      [b.dir, "OLD"],
    ] as const)
      for (const f of readdirSync(src, { recursive: true, withFileTypes: true })) {
        if (!f.isFile()) continue;
        const rel = join(f.parentPath, f.name).slice(src.length);
        const dest = join(all, name, rel);
        mkdirSync(join(dest, ".."), { recursive: true });
        writeFileSync(dest, readFileSync(join(f.parentPath, f.name)));
      }
    expect(findBackup(all).dir).toBe(join(all, "NEW"));
  });

  it("explains Full Disk Access when the folder can't be read, and says when there is no backup", () => {
    const root = fresh();
    chmodSync(root, 0o000);
    try {
      expect(() => findBackup(root)).toThrow(/Full Disk Access/);
    } finally {
      chmodSync(root, 0o700);
    }
    expect(() => findBackup(join(root, "missing"))).toThrow(/No iPhone backup/);
  });

  it("prefers WhatsApp Business over regular WhatsApp, and warns when only the regular app is there", async () => {
    const b = buildBackup(fresh());
    await withTempDir(async (tmp) => {
      const bk = openBackup(b.dir, tmp, () => "");
      const wa = findWhatsApp(bk.manifest);
      expect(wa.domain).toBe(SMB_DOMAIN);
      expect(wa.domains).toEqual([CONSUMER_DOMAIN, SMB_DOMAIN]);
      expect(wa.warning).toBeNull();
      bk.close();
    });
    const c = buildBackup(fresh(), { consumerOnly: true });
    await withTempDir(async (tmp) => {
      const bk = openBackup(c.dir, tmp, () => "");
      const wa = findWhatsApp(bk.manifest);
      expect(wa.domain).toBe(CONSUMER_DOMAIN);
      expect(wa.warning).toMatch(/regular WhatsApp/);
      bk.close();
    });
  });

  it("fails clearly when WhatsApp's database layout changed", async () => {
    const root = fresh();
    const db = join(root, "chat.sqlite");
    writeChatDb(db, scenario(), { dropColumn: "ZTEXT" });
    const b = buildBackup(join(root, "b"), { chatDb: db });
    const err = await runOrders({ backup: b.dir }, new FakeLlm(), deps().d).catch((e) => e);
    expect(err).toBeInstanceOf(OwnerError);
    expect(err.message).toMatch(/missing ZWAMESSAGE\.ZTEXT/);
  });
});

describe("today's orders from a backup", () => {
  for (const encrypted of [false, true])
    it(`reads ${encrypted ? "an encrypted" : "a plain"} backup into one row per customer`, async () => {
      const b = buildBackup(fresh(), { encrypted, password: "kitchen-1234" });
      const before = ourTemps();
      const { d, lines, opened } = deps({ password: b.password });
      const out = join(d.home, "Orders");
      const r = await runOrders({ backup: b.dir, out }, new FakeLlm(), d);

      expect(ourTemps()).toEqual(before);
      expect(r).toMatchObject({ date: "2026-10-30", orders: 3, totalCents: 2400, needCheck: 3 });
      expect(lines).toContain("Today: 3 orders, $24.00. 3 need a check.");
      expect(opened).toEqual([join(out, "Orders 2026-10-30.csv")]);

      const rows = readFileSync(join(out, "Orders 2026-10-30.csv"), "utf8").trim().split("\n");
      expect(rows[0]).toBe(
        '"phone","name","chat","Dal Makhani","Jeera Rice","Roti","Paneer Bhurji","Gulab Jamun","items","total","status","check","messages"',
      );
      const row = (s: string) => rows.find((x) => x.includes(s)) ?? "";
      expect(rows).toHaveLength(6); // Priya, Rahul, Meera, Arjun, Sana; Kiran wrote on 10-29 local time
      // Priya: one row across her 1:1 chat and the group, flagged; totals from menu prices.
      expect(row("Priya")).toMatch(/^"'\+15551110001","Priya","1:1, Office Lunch","2","","3","","","2 Dal Makhani, 3 Roti","15.00","check","wrote in 2 chats/);
      expect(row("Rahul")).toContain('"cancelled"');
      expect(row("Meera")).toMatch(/"check","unclear: 2 biryani/);
      expect(row("Arjun")).toMatch(/^"'\+15551110004","Arjun","Office Lunch",.*"1 Paneer Bhurji","7.00","ok"/);
      expect(row("Sana")).toMatch(/^"unknown:Sana","Sana","Office Lunch",.*"2 Roti","2.00","check","phone hidden by WhatsApp"/);
      // Not today: yesterday's "5 roti", Saturday's "3 roti", the status post.
      expect(rows.join()).not.toMatch(/5 roti|3 roti"|status text/);
    });

  it("re-running doesn't duplicate rows in All orders.csv and keeps other days", async () => {
    const b = buildBackup(fresh());
    const { d } = deps();
    const out = join(d.home, "Orders");
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, "All orders.csv"), '"date","phone","name","chat","items","total","status","check","messages"\n"2026-10-29","x","Old","1:1","1 Roti","1.00","ok","",""\n');
    await runOrders({ backup: b.dir, out }, new FakeLlm(), d);
    await runOrders({ backup: b.dir, out }, new FakeLlm(), d);
    const all = readFileSync(join(out, "All orders.csv"), "utf8").trim().split("\n");
    expect(all).toHaveLength(1 + 1 + 5);
    expect(all[1]).toContain('"2026-10-29"');
    expect(all.filter((r) => r.includes("Priya"))).toHaveLength(1);
  });

  it("uses the Mac's local date: a different --date reads that day", async () => {
    const b = buildBackup(fresh());
    const { d, lines } = deps();
    const r = await runOrders({ backup: b.dir, date: "2026-10-29", out: join(d.home, "o") }, new FakeLlm(), d);
    expect(r.dailyPath).toBeNull();
    expect(lines.join("\n")).toMatch(/No menu message from you on 2026-10-29/);
  });
});

describe("--check", () => {
  it("prints counts only: no message text, names or phone numbers", async () => {
    const b = buildBackup(fresh(), { encrypted: true, password: "pw" });
    const { d, lines } = deps({ password: "pw", now: () => new Date("2026-10-31T16:00:00Z") });
    await runCheck({ backup: b.dir }, d);
    const text = lines.join("\n");
    expect(text).toContain("Encrypted: yes");
    expect(text).toContain(`Reading: ${SMB_DOMAIN}`);
    expect(text).toContain("Database layout: ok");
    expect(text).toMatch(/2026-10-30\s+4\s+9\s+4\s+2 \/ 1/);
    expect(text).not.toMatch(/Priya|Arjun|Sana|Office|Fri menu|roti|dal|5551110|98765/i);
  });
});
