/**
 * Seed customers from a CSV with columns: phone,name,area,address_note
 *
 *   pnpm import:customers customers.csv [--dry-run]
 *
 * Needs DATABASE_URL and AREAS. Imported customers with a name and a valid
 * area skip onboarding in the bot.
 */
import { readFileSync } from "node:fs";
import { connectPostgres } from "../src/db/client";
import { importCustomers, parseCustomersCsv } from "../src/domain/importCustomers";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
const dryRun = args.includes("--dry-run");
if (!file) {
  console.error("Usage: pnpm import:customers <file.csv> [--dry-run]");
  process.exit(1);
}
const areas = (process.env.AREAS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
if (!areas.length) {
  console.error("Set AREAS (e.g. AREAS='Journal Square,Newport,Heights')");
  process.exit(1);
}

const { rows, report } = parseCustomersCsv(readFileSync(file, "utf8"), areas);
console.log(`Parsed ${rows.length} customers from ${file}`);

if (!dryRun) {
  if (!process.env.DATABASE_URL) {
    console.error("Set DATABASE_URL (or use --dry-run)");
    process.exit(1);
  }
  const db = await connectPostgres(process.env.DATABASE_URL);
  await importCustomers(db, rows, report);
}

console.log(`Inserted: ${report.inserted}  Updated: ${report.updated}${dryRun ? "  (dry run, nothing written)" : ""}`);
if (report.badPhones.length) {
  console.log(`\nSkipped ${report.badPhones.length} rows with invalid phone:`);
  for (const b of report.badPhones) console.log(`  line ${b.row}: "${b.phone}"`);
}
if (report.areaMismatches.length) {
  console.log(`\n${report.areaMismatches.length} rows with an area not in AREAS (left empty, bot will ask):`);
  for (const a of report.areaMismatches) console.log(`  line ${a.row}: ${a.phone} "${a.area}"`);
}
if (report.duplicates.length) console.log(`\nDuplicate phones (last row wins): ${[...new Set(report.duplicates)].join(", ")}`);
process.exit(0);
