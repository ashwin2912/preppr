/**
 * Messages from WhatsApp's iPhone database (ChatStorage.sqlite, Core Data),
 * turned into order inputs. Only plain text messages in 1:1 and group chats.
 */
import type { OrderInput } from "../domain/exportOrders";
import { normalizePhone } from "../lib/phone";
import { addDays, localDate } from "../lib/time";
import { OwnerError } from "./backup";
import type { Db } from "./sqlite";

/** Seconds between 1970-01-01 and 2001-01-01 (Apple's reference date). */
export const APPLE_EPOCH = 978307200;

const REQUIRED: Record<string, string[]> = {
  ZWACHATSESSION: ["Z_PK", "ZCONTACTJID", "ZPARTNERNAME", "ZSESSIONTYPE"],
  ZWAMESSAGE: ["Z_PK", "ZCHATSESSION", "ZISFROMME", "ZTEXT", "ZMESSAGEDATE", "ZGROUPMEMBER", "ZMESSAGETYPE"],
  ZWAGROUPMEMBER: ["Z_PK", "ZMEMBERJID", "ZCONTACTNAME"],
};

/** Missing tables/columns, e.g. ["ZWAMESSAGE.ZTEXT"]; empty = the layout we expect. */
export function missingColumns(db: Db): string[] {
  const missing: string[] = [];
  for (const [table, cols] of Object.entries(REQUIRED)) {
    const have = new Set(db.all<{ name: string }>(`PRAGMA table_info(${table})`).map((c) => c.name));
    if (!have.size) missing.push(table);
    else for (const c of cols) if (!have.has(c)) missing.push(`${table}.${c}`);
  }
  return missing;
}

/** Throws a clear error when WhatsApp changed its database layout. */
export function checkSchema(db: Db) {
  const missing = missingColumns(db);
  if (missing.length)
    throw new OwnerError(`WhatsApp's chat database has changed and Preppr can't read it yet (missing ${missing.join(", ")}). Send this message to Ashwin.`);
}

type Row = {
  fromMe: number;
  text: string | null;
  at: number;
  type: number;
  chatJid: string | null;
  partner: string | null;
  memberJid: string | null;
  memberName: string | null;
};

function rows(db: Db, fromUnix: number, toUnix: number, textOnly: boolean): Row[] {
  return db.all<Row>(
    `SELECT m.ZISFROMME AS fromMe, m.ZTEXT AS text, m.ZMESSAGEDATE AS at, s.ZSESSIONTYPE AS type,
            s.ZCONTACTJID AS chatJid, s.ZPARTNERNAME AS partner, g.ZMEMBERJID AS memberJid, g.ZCONTACTNAME AS memberName
       FROM ZWAMESSAGE m
       JOIN ZWACHATSESSION s ON s.Z_PK = m.ZCHATSESSION
       LEFT JOIN ZWAGROUPMEMBER g ON g.Z_PK = m.ZGROUPMEMBER
      WHERE s.ZSESSIONTYPE IN (0, 1)
        AND coalesce(s.ZCONTACTJID, '') <> 'status@broadcast'
        AND m.ZMESSAGEDATE >= ? AND m.ZMESSAGEDATE < ?
        ${textOnly ? "AND m.ZMESSAGETYPE = 0 AND m.ZTEXT IS NOT NULL AND trim(m.ZTEXT) <> ''" : ""}
      ORDER BY m.ZMESSAGEDATE, m.Z_PK`,
    fromUnix - APPLE_EPOCH,
    toUnix - APPLE_EPOCH,
  );
}

/** "15551234567@s.whatsapp.net" → "+15551234567"; "@lid" and anything else → null. */
export function jidPhone(jid: string | null): string | null {
  const m = jid?.match(/^(\d{6,15})@s\.whatsapp\.net$/);
  return m ? normalizePhone(`+${m[1]}`) : null;
}

const isLid = (jid: string | null) => Boolean(jid?.endsWith("@lid"));

/** Unix seconds window around a set of local dates (a day either side covers every time zone). */
function window(dates: string[]): [number, number] {
  const sorted = [...dates].sort();
  const from = Date.parse(`${addDays(sorted[0]!, -1)}T00:00:00Z`) / 1000;
  const to = Date.parse(`${addDays(sorted.at(-1)!, 2)}T00:00:00Z`) / 1000;
  return [from, to];
}

/**
 * Text messages on the given local dates as order inputs, in time order.
 * 1:1 chats: the customer is the chat. Groups: each member is a customer.
 */
export function readInputs(db: Db, tz: string, dates: string[]): OrderInput[] {
  const wanted = new Set(dates);
  const out: OrderInput[] = [];
  for (const r of rows(db, ...window(dates), true)) {
    const date = localDate(new Date((r.at + APPLE_EPOCH) * 1000), tz);
    if (!wanted.has(date)) continue;
    const group = r.type === 1;
    const jid = group ? r.memberJid : r.chatJid;
    const name = ((group ? r.memberName : r.partner) ?? "").trim();
    const phone = jidPhone(jid);
    const fallback = name || jid?.split("@")[0] || "someone";
    out.push({
      phone,
      key: phone ?? `unknown:${fallback}`,
      name: name || phone || fallback,
      chat: group ? (r.partner ?? "").trim() || "group" : "1:1",
      isOwner: r.fromMe === 1,
      text: r.text!,
      date,
      note: r.fromMe === 1 || phone ? undefined : isLid(jid) ? "phone hidden by WhatsApp" : "phone number not readable",
    });
  }
  return out;
}

export type DayStats = { date: string; chats: number; oneToOne: number; group: number; membersWithPhone: number; membersHidden: number };

/** Counts per local day for the last `days` days (newest first). No text, names or numbers. */
export function dayStats(db: Db, tz: string, now: Date, days = 7): DayStats[] {
  const today = localDate(now, tz);
  const dates = Array.from({ length: days }, (_, i) => addDays(today, -i));
  const byDate = new Map(dates.map((d) => [d, { chats: new Set<string>(), oneToOne: 0, group: 0, phone: new Set<string>(), hidden: new Set<string>() }]));
  for (const r of rows(db, ...window(dates), false)) {
    const s = byDate.get(localDate(new Date((r.at + APPLE_EPOCH) * 1000), tz));
    if (!s) continue;
    s.chats.add(r.chatJid ?? "");
    if (r.type === 1) {
      s.group++;
      if (r.fromMe !== 1 && r.memberJid) (jidPhone(r.memberJid) ? s.phone : s.hidden).add(r.memberJid);
    } else s.oneToOne++;
  }
  return dates.map((date) => {
    const s = byDate.get(date)!;
    return { date, chats: s.chats.size, oneToOne: s.oneToOne, group: s.group, membersWithPhone: s.phone.size, membersHidden: s.hidden.size };
  });
}
