/**
 * Coexistence history and contact sync.
 *
 *   pnpm wa:sync                 # meta: ask Meta to send contacts + history to the webhook
 *   pnpm wa:sync --from-db       # re-apply history/contacts already stored in raw_webhooks
 *   pnpm wa:sync <file.json>     # import a file, e.g. history downloaded from the 360dialog Hub
 *
 * 360dialog sends history to a partner webhook; as a direct client we may
 * have to download it from the Hub instead (docs/360dialog.md). Files can be
 * a webhook body, an array of bodies, or a bare history[] / state_sync[]
 * list. Imports are idempotent. Last resort: pnpm import:chat-export.
 *
 * meta request: within 24 h of onboarding, once per onboarding, Graph only.
 */
import { readFileSync } from "node:fs";
import { inArray } from "drizzle-orm";
import { loadConfig } from "../src/config";
import { connectPostgres } from "../src/db/client";
import { rawWebhooks } from "../src/db/schema";
import { loadDotEnv } from "../src/lib/env";
import { applyEvents } from "../src/flows/router";
import { DryRunWaClient } from "../src/wa/client";
import { normalizeFile, normalizeInbound, type InboundEvent } from "../src/wa/normalize";
import { skipUnderD360 } from "../src/wa/provider";

loadDotEnv();
const cfg = loadConfig();
const arg = process.argv[2];

if (!arg) {
  if (skipUnderD360(cfg, "smb_app_data sync request")) {
    console.log("Under 360dialog, history arrives once after onboarding (or from the Hub). Use --from-db or a downloaded file.");
    process.exit(0);
  }
  for (const syncType of ["smb_app_state_sync", "history"]) {
    const res = await fetch(`https://graph.facebook.com/${cfg.waGraphVersion}/${cfg.waPhoneNumberId}/smb_app_data`, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.waToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", sync_type: syncType }),
    });
    console.log(`${syncType}: ${res.status} ${JSON.stringify(await res.json().catch(() => ({})))}`);
    if (!res.ok) process.exit(1);
  }
  console.log("Requested. Contacts and history arrive on the webhook over the next minutes.");
  process.exit(0);
}

if (!cfg.databaseUrl) {
  console.error("Set DATABASE_URL");
  process.exit(1);
}
const db = await connectPostgres(cfg.databaseUrl, false);
const SYNC = new Set(["history_batch", "history_declined", "contacts_sync"]);
let events: InboundEvent[];
if (arg === "--from-db") {
  const rows = await db.select().from(rawWebhooks).where(inArray(rawWebhooks.shape, ["meta_entry", "d360_event"]));
  events = rows.flatMap((r) => normalizeInbound(r.body));
} else {
  events = normalizeFile(JSON.parse(readFileSync(arg, "utf8")));
}
// Only sync events: never replay customer messages, echoes or statuses from here.
events = events.filter((e) => SYNC.has(e.kind));
const count = (k: string) => events.filter((e) => e.kind === k).length;
console.log(`history chunks: ${count("history_batch")}, contact batches: ${count("contacts_sync")}, declined: ${count("history_declined")}`);
if (!events.length) {
  console.log("Nothing to import. Fallback: pnpm import:chat-export <export.txt|folder>");
  process.exit(0);
}
await applyEvents({ db, wa: new DryRunWaClient(false), llm: null as never, cfg, now: () => new Date() }, events, new Date());
console.log("Imported (idempotent; safe to re-run).");
process.exit(0);
