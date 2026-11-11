import { createHmac } from "node:crypto";
import { and, desc, eq, lte, ne, sql } from "drizzle-orm";
import type { Context, Hono } from "hono";
import { customers, formResponses, menus, type Menu } from "../db/schema";
import { parseFormResponse } from "../domain/formOrders";
import { errFields, log } from "../lib/log";
import { localDate } from "../lib/time";
import { secretEquals } from "../wa/signature";
import { orderableMenu } from "./formMenu";
import type { Deps } from "./router";

/** Secret path segment for the WhatsForm webhook URL, derived so there's nothing extra to configure. */
export function formWebhookToken(deps: Pick<Deps, "cfg">): string {
  const key = deps.cfg.adminSecret ?? deps.cfg.jobSecret;
  return createHmac("sha256", key).update("whatsform-webhook").digest("base64url").slice(0, 32);
}

export const formWebhookPath = (deps: Pick<Deps, "cfg">) => `/webhooks/whatsform/${formWebhookToken(deps)}`;

/**
 * The menu a submission belongs to: the one the form is showing (see orderableMenu),
 * else today's, else the latest published one before today (a late submission).
 */
async function menuFor(deps: Deps, now: Date): Promise<Menu | null> {
  const showing = await orderableMenu(deps.db, now, deps.cfg.tz);
  if (showing) return showing;
  const today = localDate(now, deps.cfg.tz);
  const [m] = await deps.db
    .select()
    .from(menus)
    .where(and(lte(menus.date, today), ne(menus.status, "draft")))
    .orderBy(desc(menus.date))
    .limit(1);
  return m ?? null;
}

/**
 * Store one WhatsForm submission: lines priced from the menu in code, the
 * customer saved (or their name/area filled in). Redeliveries are ignored.
 */
export async function ingestFormResponse(deps: Deps, body: unknown) {
  const now = deps.now();
  const menu = await menuFor(deps, now);
  const r = parseFormResponse(body, menu?.items ?? []);
  if (r.phone) {
    await deps.db
      .insert(customers)
      .values({ phone: r.phone, name: r.name, area: r.area, addressNote: r.address, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({
        target: customers.phone,
        set: {
          name: sql`coalesce(${customers.name}, excluded.name)`,
          area: sql`coalesce(${customers.area}, excluded.area)`,
          addressNote: sql`coalesce(${customers.addressNote}, excluded.address_note)`,
          updatedAt: now,
        },
      });
  }
  const [row] = await deps.db
    .insert(formResponses)
    .values({
      responseKey: r.responseKey,
      menuId: menu?.id ?? null,
      customerPhone: r.phone,
      name: r.name,
      area: r.area,
      address: r.address,
      note: r.note,
      lines: r.lines,
      totalCents: r.totalCents,
      unmatched: r.unmatched,
      raw: body as object,
      createdAt: now,
    })
    .onConflictDoNothing()
    .returning({ id: formResponses.id });
  if (row) log.info("whatsform order", { id: row.id, menuId: menu?.id ?? null, lines: r.lines.length, unmatched: r.unmatched.length });
  return { stored: !!row, ...r };
}

/** POST /webhooks/whatsform/<token>: JSON or form-encoded body from WhatsForm's webhook integration. */
export function registerFormWebhook(app: Hono, deps: Deps) {
  app.post("/webhooks/whatsform/:token", async (c: Context) => {
    if (!secretEquals(c.req.param("token"), formWebhookToken(deps))) return c.text("not found", 404);
    let body: unknown;
    const type = c.req.header("content-type") ?? "";
    try {
      body = type.includes("json") ? await c.req.json() : await c.req.parseBody({ all: true });
    } catch {
      return c.text("bad body", 400);
    }
    try {
      await ingestFormResponse(deps, body);
    } catch (e) {
      log.error("whatsform ingest failed", errFields(e));
      return c.text("try again", 500);
    }
    return c.text("ok");
  });
  // Lets the owner check the URL in a browser.
  app.get("/webhooks/whatsform/:token", (c) => (secretEquals(c.req.param("token"), formWebhookToken(deps)) ? c.text("Preppr: WhatsForm webhook OK") : c.text("not found", 404)));
}

/** Active submissions for a menu, oldest first. */
export async function responsesFor(deps: Pick<Deps, "db">, menuId: number) {
  return deps.db
    .select()
    .from(formResponses)
    .where(and(eq(formResponses.menuId, menuId), eq(formResponses.status, "active")))
    .orderBy(formResponses.createdAt);
}
