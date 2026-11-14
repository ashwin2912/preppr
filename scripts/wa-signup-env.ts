/**
 * After Embedded Signup: write the connected number's ids and business token
 * into an env file, ready for `sh scripts/railway-push-env.sh <file>`. Prints
 * ids only, never the token.
 *
 *   pnpm wa:signup:env --file .env.assistant              # latest signup
 *   pnpm wa:signup:env --file .env.assistant <phone_number_id>
 *
 * Reads the signup from DATABASE_URL (kv `signup:<phone_number_id>`); the
 * token is sealed with ADMIN_SECRET, so run with the same ADMIN_SECRET as the
 * server (ENV_FILE=.env.assistant).
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { desc, like } from "drizzle-orm";
import { loadConfig } from "../src/config";
import { connectPostgres } from "../src/db/client";
import { kv } from "../src/db/schema";
import { loadDotEnv, setEnvLines } from "../src/lib/env";
import { readSignupToken, type SignupRecord } from "../src/signup/routes";

loadDotEnv();
const args = process.argv.slice(2);
const fi = args.indexOf("--file");
const file = fi >= 0 ? args[fi + 1] : undefined;
const phoneId = args.find((_, i) => fi < 0 || (i !== fi && i !== fi + 1));
if (!file) {
  console.error("usage: pnpm wa:signup:env --file <env file> [phone_number_id]");
  process.exit(2);
}
const cfg = loadConfig();
if (!cfg.databaseUrl || !cfg.adminSecret) {
  console.error("needs DATABASE_URL and ADMIN_SECRET (same as the server)");
  process.exit(2);
}
const db = await connectPostgres(cfg.databaseUrl, false);
const rows = await db
  .select()
  .from(kv)
  .where(like(kv.key, phoneId ? `signup:${phoneId}` : "signup:%"))
  .orderBy(desc(kv.updatedAt))
  .limit(1);
const rec = rows[0]?.value as SignupRecord | undefined;
if (!rec) {
  console.error(phoneId ? `no signup for ${phoneId}` : "no signup yet");
  process.exit(1);
}
const token = readSignupToken(cfg.adminSecret, rec);
if (!token) {
  console.error("can't unseal the token: ADMIN_SECRET differs from the server's");
  process.exit(1);
}
const before = existsSync(file) ? readFileSync(file, "utf8") : "";
writeFileSync(file, setEnvLines(before, { WA_TOKEN: token, WA_WABA_ID: rec.wabaId, WA_PHONE_NUMBER_ID: rec.phoneNumberId }), { mode: 0o600 });
console.log(`${file}: WA_WABA_ID=${rec.wabaId} WA_PHONE_NUMBER_ID=${rec.phoneNumberId} WA_TOKEN=(set) — ${rec.verifiedName ?? ""} ${rec.displayPhoneNumber ?? ""} signed up ${rec.at}`);
process.exit(0);
