import { parse } from "csv-parse/sync";
import { inArray } from "drizzle-orm";
import type { Q } from "../db/client";
import { customers } from "../db/schema";
import { normalizePhone } from "../lib/phone";
import { matchArea } from "../flows/onboarding";

export type ImportReport = {
  inserted: number;
  updated: number;
  badPhones: { row: number; phone: string }[];
  areaMismatches: { row: number; phone: string; area: string }[];
  duplicates: string[];
};

type Row = { phone: string; name: string | null; area: string | null; addressNote: string | null };

const blank = (s: string | undefined) => {
  const t = s?.trim();
  return t ? t : null;
};

/** Parse + validate a customers CSV (phone,name,area,address_note). Pure. */
export function parseCustomersCsv(csv: string, areas: string[]) {
  const records = parse(csv, { columns: (h: string[]) => h.map((x) => x.trim().toLowerCase()), skip_empty_lines: true, trim: true, bom: true }) as Record<string, string>[];
  const report: ImportReport = { inserted: 0, updated: 0, badPhones: [], areaMismatches: [], duplicates: [] };
  const rows = new Map<string, Row>();
  records.forEach((r, i) => {
    const line = i + 2; // header is line 1
    const phone = normalizePhone(r.phone);
    if (!phone) {
      report.badPhones.push({ row: line, phone: r.phone ?? "" });
      return;
    }
    const rawArea = blank(r.area);
    const area = rawArea ? matchArea(rawArea, areas) : null;
    if (rawArea && !area) report.areaMismatches.push({ row: line, phone, area: rawArea });
    if (rows.has(phone)) report.duplicates.push(phone);
    rows.set(phone, { phone, name: blank(r.name), area, addressNote: blank(r.address_note) });
  });
  return { rows: [...rows.values()], report };
}

/** Upsert parsed rows. CSV blanks never overwrite existing values. */
export async function importCustomers(db: Q, rows: Row[], report: ImportReport, now = new Date()) {
  const existing = new Map(
    rows.length
      ? (await db.select().from(customers).where(inArray(customers.phone, rows.map((r) => r.phone)))).map((c) => [c.phone, c])
      : [],
  );
  for (const r of rows) {
    const cur = existing.get(r.phone);
    if (!cur) {
      await db.insert(customers).values({ ...r, createdAt: now });
      report.inserted++;
      continue;
    }
    const set = {
      name: r.name ?? cur.name,
      area: r.area ?? cur.area,
      addressNote: r.addressNote ?? cur.addressNote,
    };
    if (set.name !== cur.name || set.area !== cur.area || set.addressNote !== cur.addressNote) {
      await db.update(customers).set(set).where(inArray(customers.phone, [r.phone]));
      report.updated++;
    }
  }
  return report;
}
