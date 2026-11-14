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
  /** meta = Cloud API direct (Graph); d360 = 360dialog (BSP pass-through, coexistence). */
  WA_PROVIDER: z.enum(["meta", "d360"]).default("meta"),
  /** meta: app secret for X-Hub-Signature-256 and the GET verify token. Required for meta only. */
  WA_APP_SECRET: z.string().default(""),
  WA_VERIFY_TOKEN: z.string().default(""),
  /** d360: shared secret 360dialog sends back in the X-Preppr-Secret header. Required for d360. */
  WA_WEBHOOK_SECRET: z.string().default(""),
  /** meta: WhatsApp Business Account id, for template sync/check. */
  WA_WABA_ID: z.string().default(""),
  WA_GRAPH_VERSION: z.string().default("v23.0"),
  WA_API_URL: z.string().url().optional(),
  WA_AUTH_HEADER: z.string().default("Authorization"),
  WA_COEXISTENCE: z
    .string()
    .optional()
    .transform((v) => v === "1" || v === "true"),
  UNKNOWN_SENDERS: z.enum(["onboard", "order_only"]).optional(),
  OWNER_ONLY: z
    .string()
    .optional()
    .transform((v) => v === "1" || v === "true"),
  ORDER_CHANNEL: z.enum(["bot", "whatsform", "page"]).default("bot"),
  MENU_TEMPLATE: z.string().default("daily_order_open"),
  MENU_TEMPLATE_LANG: z.string().default("en_US"),
  WA_DRY_RUN: z
    .string()
    .optional()
    .transform((v) => v === "1" || v === "true"),
  BOT_NUMBER: z.string().min(1),
  BOT_MODE: z.enum(["shadow", "assist", "live"]).default("live"),
  ASSIST_MIN_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.9),
  OPERATOR_NUMBERS: z.string().default(""),
  WATCHDOG_NO_INBOUND_MIN: z.coerce.number().int().positive().default(120),
  SEND_FAIL_THRESHOLD: z.coerce.number().int().positive().default(3),
  DATABASE_URL: z.string().optional(),
  OWNER_NUMBERS: z.string().min(1),
  TZ: z.string().default("America/New_York"),
  CUTOFF_TIME: z.string().regex(/^\d{1,2}:\d{2}$/).default("10:30"),
  AREAS: z.string().min(1),
  PAYMENT_INSTRUCTIONS: z.string().default(""),
  KITCHEN_NAME: z.string().default("Tiffin Kitchen"),
  JOB_SECRET: z.string().min(1),
  MENU_EXPECTED_BY: z.string().regex(/^\d{1,2}:\d{2}$/).default("09:00"),
  KITCHEN_DAYS: z.string().default("Mon,Tue,Wed,Thu,Fri,Sat"),
  SENTRY_DSN: z.string().optional(),
  SENTRY_ENVIRONMENT: z.string().default("production"),
  PUBLIC_URL: z.string().url().optional(),
  ADMIN_SECRET: z.string().optional(),
  GOOGLE_SERVICE_ACCOUNT_JSON: z.string().optional(),
  SHEET_ID: z.string().optional(),
  META_APP_ID: z.string().optional(),
  ES_CONFIG_ID: z.string().optional(),
  ES_APP_SECRET: z.string().optional(),
  ES_GRAPH_VERSION: z.string().default("v27.0"),
});

export type Config = {
  port: number;
  waProvider: "meta" | "d360";
  /** d360 only: expected value of the X-Preppr-Secret webhook header. */
  waWebhookSecret: string;
  waWabaId: string;
  waToken: string;
  waPhoneNumberId: string;
  waAppSecret: string;
  waVerifyToken: string;
  waGraphVersion: string;
  waDryRun: boolean;
  /** Full messages endpoint; unset = Graph API for `waPhoneNumberId`. Set for a BSP proxy. */
  waApiUrl?: string;
  /** "Authorization" sends `Bearer <token>`; any other header gets the bare token (e.g. a BSP's API-key header). */
  waAuthHeader: string;
  /**
   * The number is shared with the owner's WhatsApp Business app (coexistence):
   * the menu goes out by API instead of broadcast lists, and the bot stays out
   * of chats the owner is handling.
   */
  coexistence: boolean;
  /** onboard: any new number gets sign-up. order_only: only numbers that ask to order. */
  unknownSenders: "onboard" | "order_only";
  /** Only owners get answers; everyone else is recorded and ignored (menu assistant on a test number). */
  ownerOnly: boolean;
  /**
   * Where customers order. bot: they message this number. whatsform: they fill in a
   * WhatsForm form, so publishing gives the owner form lines and a broadcast with the form link,
   * and the cutoff sends no order summary. page: our own /order page (docs/order-page.md);
   * same owner side as whatsform, with the order page link in the broadcast.
   */
  orderChannel: "bot" | "whatsform" | "page";
  /** Utility template sent when a customer's 24 h window is closed (coexistence menu push). */
  menuTemplate: string;
  menuTemplateLang: string;
  /** Bot number, digits only (wa.me format). */
  botNumber: string;
  /**
   * Rollout mode. shadow: read and record everything, send customers nothing.
   * assist: send only high-confidence order summaries (and the confirm flow
   * that follows); everything else waits for the owner (REVIEW). live: normal.
   * The owner's BOT OFF forces shadow behaviour regardless.
   */
  botMode: "shadow" | "assist" | "live";
  /** assist: minimum parser confidence to send an order summary (rules parser counts as 1). */
  assistMinConfidence: number;
  /** E.164; whoever runs the service. Ops alerts go here (and Sentry); always allowed to receive. */
  operatorNumbers: string[];
  /** Alert when no webhook arrived for this many minutes while ordering is open. */
  watchdogNoInboundMin: number;
  /** Alert when more than this many sends dead-lettered in the last hour. */
  sendFailThreshold: number;
  databaseUrl?: string;
  /** E.164 */
  ownerNumbers: string[];
  tz: string;
  cutoffTime: string;
  areas: string[];
  paymentInstructions: string;
  kitchenName: string;
  jobSecret: string;
  /** Alert if no menu is published by this local time on a kitchen day. */
  menuExpectedBy: string;
  /** "Mon".."Sun" */
  kitchenDays: string[];
  sentryDsn?: string;
  sentryEnvironment: string;
  /** Public base URL of this service, for links the bot sends (chat viewer). */
  publicUrl?: string;
  /** Signs chat-viewer links; unset = viewer off. */
  adminSecret?: string;
  /** Both set = Google Sheet sync on. */
  googleServiceAccountJson?: string;
  sheetId?: string;
  /** Embedded Signup (coexistence onboarding page): Meta app id and Facebook Login for Business configuration id. */
  metaAppId?: string;
  esConfigId?: string;
  /**
   * App secret of the Tech Provider app that runs Embedded Signup, when it isn't
   * the app in WA_APP_SECRET. Used for the code exchange, and also accepted on
   * webhook signatures so both apps can deliver during the switch-over.
   */
  esAppSecret?: string;
  /** Graph version for the signup page's SDK and the code exchange (production sends keep WA_GRAPH_VERSION). */
  esGraphVersion: string;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const e = EnvSchema.parse(env);
  const ownerNumbers = csv(e.OWNER_NUMBERS).map((n) => {
    const p = normalizePhone(n);
    if (!p) throw new Error(`Invalid OWNER_NUMBERS entry: ${n}`);
    return p;
  });
  if (e.WA_PROVIDER === "meta" && (!e.WA_APP_SECRET || !e.WA_VERIFY_TOKEN))
    throw new Error("WA_PROVIDER=meta needs WA_APP_SECRET and WA_VERIFY_TOKEN");
  if (e.WA_PROVIDER === "d360" && !e.WA_WEBHOOK_SECRET) throw new Error("WA_PROVIDER=d360 needs WA_WEBHOOK_SECRET");
  const operatorNumbers = csv(e.OPERATOR_NUMBERS).map((n) => {
    const p = normalizePhone(n);
    if (!p) throw new Error(`Invalid OPERATOR_NUMBERS entry: ${n}`);
    return p;
  });
  const bot = normalizePhone(e.BOT_NUMBER);
  if (!bot) throw new Error(`Invalid BOT_NUMBER: ${e.BOT_NUMBER}`);
  // The bot can't take commands from itself; with coexistence the owner uses a personal number.
  if (ownerNumbers.includes(bot)) throw new Error("OWNER_NUMBERS must not include BOT_NUMBER; use the owner's personal number");
  const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const kitchenDays = csv(e.KITCHEN_DAYS).map((d) => {
    const day = DAYS.find((x) => x.toLowerCase() === d.slice(0, 3).toLowerCase());
    if (!day) throw new Error(`Invalid KITCHEN_DAYS entry: ${d}`);
    return day;
  });
  const areas = csv(e.AREAS);
  if (areas.length === 0) throw new Error("AREAS must list at least one area");
  return {
    port: e.PORT,
    waProvider: e.WA_PROVIDER,
    waWebhookSecret: e.WA_WEBHOOK_SECRET,
    waWabaId: e.WA_WABA_ID,
    waToken: e.WA_TOKEN,
    waPhoneNumberId: e.WA_PHONE_NUMBER_ID,
    waAppSecret: e.WA_APP_SECRET,
    waVerifyToken: e.WA_VERIFY_TOKEN,
    waGraphVersion: e.WA_GRAPH_VERSION,
    waDryRun: e.WA_DRY_RUN,
    waApiUrl: e.WA_API_URL || undefined,
    waAuthHeader: e.WA_AUTH_HEADER,
    coexistence: e.WA_COEXISTENCE,
    unknownSenders: e.UNKNOWN_SENDERS ?? (e.WA_COEXISTENCE ? "order_only" : "onboard"),
    ownerOnly: e.OWNER_ONLY,
    orderChannel: e.ORDER_CHANNEL,
    menuTemplate: e.MENU_TEMPLATE,
    menuTemplateLang: e.MENU_TEMPLATE_LANG,
    botNumber: bot.slice(1),
    botMode: e.BOT_MODE,
    assistMinConfidence: e.ASSIST_MIN_CONFIDENCE,
    operatorNumbers,
    watchdogNoInboundMin: e.WATCHDOG_NO_INBOUND_MIN,
    sendFailThreshold: e.SEND_FAIL_THRESHOLD,
    databaseUrl: e.DATABASE_URL,
    ownerNumbers,
    tz: e.TZ,
    cutoffTime: e.CUTOFF_TIME,
    areas,
    paymentInstructions: e.PAYMENT_INSTRUCTIONS,
    kitchenName: e.KITCHEN_NAME,
    jobSecret: e.JOB_SECRET,
    menuExpectedBy: e.MENU_EXPECTED_BY,
    kitchenDays,
    sentryDsn: e.SENTRY_DSN || undefined,
    sentryEnvironment: e.SENTRY_ENVIRONMENT,
    publicUrl: e.PUBLIC_URL?.replace(/\/+$/, "") || undefined,
    adminSecret: e.ADMIN_SECRET || undefined,
    googleServiceAccountJson: e.GOOGLE_SERVICE_ACCOUNT_JSON || undefined,
    sheetId: e.SHEET_ID || undefined,
    metaAppId: e.META_APP_ID || undefined,
    esConfigId: e.ES_CONFIG_ID || undefined,
    esAppSecret: e.ES_APP_SECRET || undefined,
    esGraphVersion: e.ES_GRAPH_VERSION,
  };
}
