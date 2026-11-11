import type { Config } from "../../config";
import { log } from "../../lib/log";
import { secretEquals, verifySignature } from "../signature";
import { D360Provider, D360_SECRET_HEADER } from "./d360";
import { MetaProvider } from "./meta";
import type { WaProvider } from "./types";

export type { WaProvider, WebhookConfig, TemplateDef, TemplateStatus } from "./types";

export function createProvider(cfg: Config): WaProvider {
  return cfg.waProvider === "d360" ? new D360Provider(cfg) : new MetaProvider(cfg);
}

/**
 * Authenticates an inbound webhook. meta: HMAC X-Hub-Signature-256 with the
 * app secret. d360: 360dialog doesn't sign; it echoes the header we set with
 * the webhook URL (`pnpm wa:webhook:set`), compared in constant time.
 */
export function verifyInbound(cfg: Config, header: (name: string) => string | undefined, rawBody: string): boolean {
  if (cfg.waProvider === "d360") return secretEquals(header(D360_SECRET_HEADER), cfg.waWebhookSecret);
  return verifySignature(rawBody, header("x-hub-signature-256"), cfg.waAppSecret);
}

/** Meta-only setup calls (register, subscribed_apps, business profile, smb_app_data) don't apply under 360dialog. */
export function skipUnderD360(cfg: Config, what: string): boolean {
  if (cfg.waProvider !== "d360") return false;
  log.info(`skipped under WA_PROVIDER=d360: ${what} is handled by 360dialog`);
  return true;
}
