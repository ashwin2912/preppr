/**
 * One-screen health check for the WhatsApp setup: key, webhook, template,
 * database, last webhook received. Exit code 1 if anything FAILs.
 *
 *   pnpm wa:check
 */
import { loadConfig } from "../src/config";
import { connectPostgres } from "../src/db/client";
import { loadDotEnv } from "../src/lib/env";
import { formatChecks, runChecks } from "../src/ops/checks";
import { createProvider } from "../src/wa/provider";

loadDotEnv();
const cfg = loadConfig();
const db = cfg.databaseUrl ? await connectPostgres(cfg.databaseUrl, false).catch(() => null) : null;
const lines = await runChecks(cfg, createProvider(cfg), db);
console.log(formatChecks(lines));
process.exit(lines.some((l) => l.result === "FAIL") ? 1 : 0);
