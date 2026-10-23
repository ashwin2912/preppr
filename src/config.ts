import { z } from "zod";
import { normalizePhone } from "./lib/phone";

const csv = (s: string) =>
  s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

const EnvSchema = z.object({
  PORT: z.coerce.number().default(8080),
  WA_TOKEN: z.string().default(""),
  WA_PHONE_NUMBER_ID: z.string().default(""),
  WA_APP_SECRET: z.string().min(1),
  WA_VERIFY_TOKEN: z.string().min(1),
  WA_GRAPH_VERSION: z.string().default("v23.0"),
  WA_DRY_RUN: z
    .string()
    .optional()
    .transform((v) => v === "1" || v === "true"),
  BOT_NUMBER: z.string().min(1),
  DATABASE_URL: z.string().optional(),
  OWNER_NUMBERS: z.string().min(1),
  TZ: z.string().default("America/New_York"),
  CUTOFF_TIME: z.string().regex(/^\d{1,2}:\d{2}$/).default("10:30"),
  AREAS: z.string().min(1),
  PAYMENT_INSTRUCTIONS: z.string().default(""),
  KITCHEN_NAME: z.string().default("Tiffin Kitchen"),
  JOB_SECRET: z.string().min(1),
});

export type Config = {
  port: number;
  waToken: string;
  waPhoneNumberId: string;
  waAppSecret: string;
  waVerifyToken: string;
  waGraphVersion: string;
  waDryRun: boolean;
  /** Bot number, digits only (wa.me format). */
  botNumber: string;
  databaseUrl?: string;
  /** E.164 */
  ownerNumbers: string[];
  tz: string;
  cutoffTime: string;
  areas: string[];
  paymentInstructions: string;
  kitchenName: string;
  jobSecret: string;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const e = EnvSchema.parse(env);
  const ownerNumbers = csv(e.OWNER_NUMBERS).map((n) => {
    const p = normalizePhone(n);
    if (!p) throw new Error(`Invalid OWNER_NUMBERS entry: ${n}`);
    return p;
  });
  const bot = normalizePhone(e.BOT_NUMBER);
  if (!bot) throw new Error(`Invalid BOT_NUMBER: ${e.BOT_NUMBER}`);
  const areas = csv(e.AREAS);
  if (areas.length === 0) throw new Error("AREAS must list at least one area");
  return {
    port: e.PORT,
    waToken: e.WA_TOKEN,
    waPhoneNumberId: e.WA_PHONE_NUMBER_ID,
    waAppSecret: e.WA_APP_SECRET,
    waVerifyToken: e.WA_VERIFY_TOKEN,
    waGraphVersion: e.WA_GRAPH_VERSION,
    waDryRun: e.WA_DRY_RUN,
    botNumber: bot.slice(1),
    databaseUrl: e.DATABASE_URL,
    ownerNumbers,
    tz: e.TZ,
    cutoffTime: e.CUTOFF_TIME,
    areas,
    paymentInstructions: e.PAYMENT_INSTRUCTIONS,
    kitchenName: e.KITCHEN_NAME,
    jobSecret: e.JOB_SECRET,
  };
}
