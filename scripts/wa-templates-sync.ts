/**
 * Create the coexistence menu-push template (MENU_TEMPLATE, default
 * daily_order_open, UTILITY, no dishes or prices) if it's missing, and print
 * its review status.
 *
 *   pnpm wa:templates:sync
 */
import { loadConfig } from "../src/config";
import { loadDotEnv } from "../src/lib/env";
import { createProvider } from "../src/wa/provider";
import { menuTemplateDef } from "../src/wa/provider/types";

loadDotEnv();
const cfg = loadConfig();
const provider = createProvider(cfg);
if (provider.sandbox) {
  console.log("Sandbox: only 360dialog's predefined templates exist. N/A.");
  process.exit(0);
}
const def = menuTemplateDef(cfg.menuTemplate, cfg.menuTemplateLang);
const existing = (await provider.listTemplates()).filter((t) => t.name === def.name && t.language === def.language);
if (existing.length) {
  for (const t of existing) console.log(`${t.name} (${t.language}): ${t.status}${t.category ? ` · ${t.category}` : ""}`);
  if (existing.some((t) => t.category && t.category.toUpperCase() !== "UTILITY"))
    console.log("⚠ Category is not UTILITY: edit the wording (no promotions) and resubmit, or US customers won't get it.");
  process.exit(0);
}
const created = await provider.createTemplate(def);
console.log(`Created ${created.name} (${created.language}): ${created.status}${created.category ? ` · ${created.category}` : ""}`);
console.log("Review usually takes minutes to a day; check again with pnpm wa:check.");
process.exit(0);
