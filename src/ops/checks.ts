import { sql } from "drizzle-orm";
import type { Config } from "../config";
import type { DB } from "../db/client";
import { lastInboundWebhookAt } from "../jobs/watchdog";
import { D360_SECRET_HEADER } from "../wa/provider/d360";
import type { WaProvider, WebhookConfig } from "../wa/provider";

/** 360dialog rejects webhook URLs with underscores or an explicit port; production needs HTTPS. */
export function webhookUrlProblem(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "not a URL";
  }
  if (u.protocol !== "https:") return "must be https";
  if (u.port) return "must not contain a :port";
  if (url.includes("_")) return "must not contain _";
  return null;
}

export const webhookUrlFor = (cfg: Config) => (cfg.publicUrl ? `${cfg.publicUrl}/webhooks/whatsapp` : null);

/** Whether the provider's webhook config points at us with our secret. Header values may come back masked. */
export function webhookMatches(w: WebhookConfig | null, url: string): boolean {
  if (!w?.url || w.url.replace(/\/+$/, "") !== url.replace(/\/+$/, "")) return false;
  return Object.keys(w.headers ?? {}).some((k) => k.toLowerCase() === D360_SECRET_HEADER.toLowerCase());
}

export type CheckLine = { name: string; result: "PASS" | "FAIL" | "N/A"; detail: string };

/** Everything `pnpm wa:check` prints. Never throws: each check reports its own failure. */
export async function runChecks(cfg: Config, provider: WaProvider, db: DB | null, now = new Date()): Promise<CheckLine[]> {
  const out: CheckLine[] = [];
  const step = async (name: string, fn: () => Promise<Omit<CheckLine, "name">>) => {
    try {
      out.push({ name, ...(await fn()) });
    } catch (e) {
      out.push({ name, result: "FAIL", detail: e instanceof Error ? e.message : String(e) });
    }
  };

  await step("provider", async () => ({ result: "PASS", detail: `${provider.name}${provider.sandbox ? " (sandbox)" : ""}` }));
  await step("key valid", async () => {
    const k = await provider.checkKey();
    return { result: k.ok ? "PASS" : "FAIL", detail: k.detail };
  });
  await step("webhook set", async () => {
    const want = webhookUrlFor(cfg);
    const w = await provider.getWebhook();
    if (w === null) return { result: "N/A", detail: "set in the Meta app dashboard" };
    if (!want) return { result: "FAIL", detail: "PUBLIC_URL not set" };
    return webhookMatches(w, want)
      ? { result: "PASS", detail: w.url! }
      : { result: "FAIL", detail: `is ${w.url ?? "unset"}; want ${want} with ${D360_SECRET_HEADER} (pnpm wa:webhook:set)` };
  });
  await step("template", async () => {
    if (provider.sandbox) return { result: "N/A", detail: "sandbox has predefined templates only" };
    const t = (await provider.listTemplates()).filter((x) => x.name === cfg.menuTemplate && x.language === cfg.menuTemplateLang);
    if (!t.length) return { result: "FAIL", detail: `${cfg.menuTemplate} (${cfg.menuTemplateLang}) missing (pnpm wa:templates:sync)` };
    const s = t[0]!.status.toUpperCase();
    return { result: s === "APPROVED" ? "PASS" : "FAIL", detail: `${s}${t[0]!.category ? ` · ${t[0]!.category}` : ""}` };
  });
  await step("DB reachable", async () => {
    if (!db) return { result: "FAIL", detail: "DATABASE_URL not set" };
    await db.execute(sql`select 1`);
    return { result: "PASS", detail: "select 1" };
  });
  await step("last inbound event", async () => {
    if (!db) return { result: "N/A", detail: "no DB" };
    const at = await lastInboundWebhookAt(db);
    if (!at) return { result: "FAIL", detail: "no webhook received yet" };
    const mins = Math.round((now.getTime() - at.getTime()) / 60000);
    return { result: "PASS", detail: `${at.toISOString()} (${mins} min ago)` };
  });
  return out;
}

export const formatChecks = (lines: CheckLine[]) =>
  lines.map((l) => `${l.result.padEnd(4)}  ${l.name.padEnd(20)} ${l.detail}`).join("\n");
