/**
 * 360dialog: point the number's webhook at us, with the shared-secret header
 * the app checks (X-Preppr-Secret = WA_WEBHOOK_SECRET), then poll until the
 * change shows up.
 *
 *   pnpm wa:webhook:set [url]     # default: $PUBLIC_URL/webhooks/whatsapp
 *
 * Re-run after generating a new API key (docs/runbook.md). Meta: set the
 * webhook in the app dashboard instead.
 */
import { loadConfig } from "../src/config";
import { loadDotEnv } from "../src/lib/env";
import { webhookMatches, webhookUrlFor, webhookUrlProblem } from "../src/ops/checks";
import { createProvider } from "../src/wa/provider";
import { D360_SECRET_HEADER } from "../src/wa/provider/d360";

loadDotEnv();
const cfg = loadConfig();
const provider = createProvider(cfg);
if (provider.name !== "d360") {
  console.log("WA_PROVIDER=meta: set the webhook in the Meta app dashboard (WhatsApp → Configuration). Nothing to do here.");
  process.exit(0);
}
const url = process.argv[2] ?? webhookUrlFor(cfg);
if (!url) {
  console.error("Pass the URL or set PUBLIC_URL");
  process.exit(1);
}
const problem = webhookUrlProblem(url);
if (problem) {
  console.error(`Webhook URL ${url} ${problem}`);
  process.exit(1);
}

await provider.setWebhook(url, { [D360_SECRET_HEADER]: cfg.waWebhookSecret });
console.log(`Set ${url}; waiting for 360dialog to apply it…`);
const deadline = Date.now() + 60_000;
while (Date.now() < deadline) {
  const w = await provider.getWebhook().catch(() => null);
  if (webhookMatches(w, url)) {
    console.log(`✓ webhook is ${w!.url}`);
    process.exit(0);
  }
  await new Promise((r) => setTimeout(r, 3_000));
}
console.error("Not applied after 60 s; run pnpm wa:check in a minute");
process.exit(1);
