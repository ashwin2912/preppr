import { desc, eq, gt, inArray, max, sql } from "drizzle-orm";
import { formatInTimeZone } from "date-fns-tz";
import type { Q } from "../db/client";
import { customers, kv, menus, orders, payments, type Menu } from "../db/schema";
import { allBalances } from "../domain/ledger";
import { ownerMenu } from "../domain/menu";
import { shortLines } from "../domain/order";
import { kitchenTotals, loadSummaryData } from "../domain/summary";
import type { Deps } from "../flows/router";
import { errFields, log } from "../lib/log";
import { formatClock, formatDay } from "../lib/time";
import type { Cell } from "../sheets/client";

const MARKER = "sheet_sync_at";
/** Re-include rows changed slightly before the marker, in case a write committed late. */
const OVERLAP_MS = 60_000;

const dollars = (cents: number) => Math.round(cents) / 100;
const STATUS_RANK = { confirmed: 0, draft: 1, cancelled: 2 } as const;

export const ordersTabTitle = (m: Menu) => `Orders ${m.date}`;

async function latestChange(db: Q): Promise<Date | null> {
  const [o] = await db.select({ at: max(orders.updatedAt) }).from(orders);
  const [c] = await db.select({ at: max(customers.updatedAt) }).from(customers);
  const [p] = await db.select({ at: max(payments.updatedAt) }).from(payments);
  const all = [o?.at, c?.at, p?.at].filter((d): d is Date => !!d).map((d) => new Date(d));
  return all.length ? new Date(Math.max(...all.map((d) => d.getTime()))) : null;
}

async function getMarker(db: Q): Promise<Date | null> {
  const [row] = await db.select().from(kv).where(eq(kv.key, MARKER));
  return row ? new Date(row.value as string) : null;
}

async function setMarker(db: Q, at: Date, now: Date) {
  await db
    .insert(kv)
    .values({ key: MARKER, value: at.toISOString(), updatedAt: now })
    .onConflictDoUpdate({ target: kv.key, set: { value: at.toISOString(), updatedAt: now } });
}

export async function ordersTab(deps: Deps, menu: Menu): Promise<Cell[][]> {
  const { cfg } = deps;
  const { rows } = await loadSummaryData(deps.db, menu, cfg.tz);
  const owed = new Map((await allBalances(deps.db)).map((b) => [b.phone, b.owedCents]));
  const areaIdx = (a: string | null) => {
    const i = a ? cfg.areas.indexOf(a) : -1;
    return i < 0 ? cfg.areas.length : i;
  };
  rows.sort(
    (a, b) =>
      STATUS_RANK[a.order.status] - STATUS_RANK[b.order.status] ||
      areaIdx(a.customer.area) - areaIdx(b.customer.area) ||
      (a.customer.name ?? "").localeCompare(b.customer.name ?? ""),
  );
  const confirmed = rows.filter((r) => r.order.status === "confirmed");
  const out: Cell[][] = [
    [`${cfg.kitchenName} — ${formatDay(menu.date, cfg.tz)}`, `Cutoff ${formatClock(menu.cutoffAt, cfg.tz)}`, `Status: ${menu.status}`],
    [`${confirmed.length} confirmed`, `Total $${dollars(confirmed.reduce((s, r) => s + r.order.totalCents, 0)).toFixed(2)}`],
    [],
    ["Kitchen totals", "Qty"],
    ...kitchenTotals(menu, rows).map((k) => [k.name, k.qty]),
    [],
    ["Area", "Name", "Phone", "Address", "Items", "Total ($)", "Status", "Flagged", "Balance owed ($)", "Order #", "Updated"],
    ...rows.map((r) => [
      r.customer.area ?? "No area",
      r.customer.name,
      r.customer.phone,
      r.customer.addressNote,
      shortLines(r.order.lines),
      dollars(r.order.totalCents),
      r.order.status,
      r.order.flagged ? "yes" : "",
      dollars(owed.get(r.customer.phone) ?? 0),
      r.order.id,
      formatInTimeZone(r.order.updatedAt, cfg.tz, "yyyy-MM-dd HH:mm"),
    ]),
  ];
  return out;
}

export async function customersTab(deps: Deps): Promise<Cell[][]> {
  const { db, cfg } = deps;
  const balances = new Map((await allBalances(db)).map((b) => [b.phone, b]));
  const last = await db
    .select({ phone: orders.customerPhone, date: max(menus.date) })
    .from(orders)
    .innerJoin(menus, eq(orders.menuId, menus.id))
    .where(eq(orders.status, "confirmed"))
    .groupBy(orders.customerPhone);
  const lastBy = new Map(last.map((l) => [l.phone, l.date]));
  const all = await db.select().from(customers).orderBy(sql`${customers.name} nulls last`, customers.phone);
  return [
    ["Phone", "Name", "Area", "Address", "Status", "Notes", "Balance owed ($)", "To verify ($)", "Last order", "Joined"],
    ...all.map((c) => {
      const b = balances.get(c.phone);
      return [
        c.phone,
        c.name,
        c.area,
        c.addressNote,
        c.status,
        c.notes,
        dollars(b?.owedCents ?? 0),
        dollars(b?.pendingCents ?? 0),
        lastBy.get(c.phone) ?? "",
        formatInTimeZone(c.createdAt, cfg.tz, "yyyy-MM-dd"),
      ];
    }),
  ];
}

export async function paymentsTab(deps: Deps): Promise<Cell[][]> {
  const { db, cfg } = deps;
  const rows = await db
    .select({ p: payments, name: customers.name })
    .from(payments)
    .innerJoin(customers, eq(payments.customerPhone, customers.phone))
    .orderBy(desc(payments.createdAt), desc(payments.id));
  const at = (d: Date | null) => (d ? formatInTimeZone(d, cfg.tz, "yyyy-MM-dd HH:mm") : "");
  return [
    ["#", "Date", "Name", "Phone", "Amount ($)", "Method", "Status", "Source", "Verified at", "Message / note"],
    ...rows.map(({ p, name }) => [
      p.id,
      at(p.createdAt),
      name,
      p.customerPhone,
      dollars(p.amountCents),
      p.method,
      p.status === "pending" ? "To verify" : p.status,
      p.source,
      at(p.verifiedAt),
      p.note,
    ]),
  ];
}

/**
 * Push DB state to the Google Sheet when something changed since the last
 * sync: a tab per menu day whose orders changed (plus the current one),
 * Customers and Payments. One-way; the Sheet is a read-only view.
 * Returns the tabs written (empty when nothing changed or sync is off).
 */
export async function syncSheets(deps: Deps, opts: { force?: boolean } = {}): Promise<string[]> {
  if (!deps.sheets) return [];
  const { db } = deps;
  const latest = await latestChange(db);
  const marker = await getMarker(db);
  if (!opts.force && (!latest || (marker && latest <= marker))) return [];

  const since = marker ? new Date(marker.getTime() - OVERLAP_MS) : new Date(0);
  const changedMenuIds = (
    await db.selectDistinct({ id: orders.menuId }).from(orders).where(gt(orders.updatedAt, since))
  ).map((r) => r.id);
  const current = await ownerMenu(db, deps.now(), deps.cfg.tz);
  const ids = [...new Set([...changedMenuIds, ...(current ? [current.id] : [])])];
  const dayMenus = ids.length ? await db.select().from(menus).where(inArray(menus.id, ids)).orderBy(menus.date) : [];

  const written: string[] = [];
  for (const m of dayMenus) {
    await deps.sheets.writeTab(ordersTabTitle(m), await ordersTab(deps, m), { first: true });
    written.push(ordersTabTitle(m));
  }
  await deps.sheets.writeTab("Customers", await customersTab(deps));
  await deps.sheets.writeTab("Payments", await paymentsTab(deps));
  written.push("Customers", "Payments");

  if (latest) await setMarker(db, latest, deps.now());
  log.info("sheet synced", { tabs: written });
  return written;
}

/** Wraps syncSheets for the worker: counts failures, alerts after a few in a row. */
export function sheetSyncer(deps: Deps) {
  let failures = 0;
  return async () => {
    try {
      await syncSheets(deps);
      failures = 0;
    } catch (e) {
      failures++;
      const fields = { failures, alert: failures >= 3 ? "sheet_sync_failing" : undefined, ...errFields(e) };
      if (failures >= 3) log.error("sheet sync failing", fields);
      else log.warn("sheet sync failed, will retry", fields);
    }
  };
}
