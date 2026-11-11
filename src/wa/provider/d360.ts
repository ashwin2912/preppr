import type { Config } from "../../config";
import { toGraphPayload } from "../client";
import { classifySendError } from "../errors";
import type { Outbound } from "../types";
import { templateBody, type TemplateDef, type TemplateStatus, type WaProvider, type WebhookConfig } from "./types";

export const D360_BASE = "https://waba-v2.360dialog.io";
export const D360_SANDBOX_BASE = "https://waba-sandbox.360dialog.io";
export const D360_SECRET_HEADER = "X-Preppr-Secret";

/** `WA_API_URL` may be the base or (older .env) the full messages URL. */
export const d360Base = (url?: string) => (url ?? D360_BASE).replace(/\/+$/, "").replace(/\/(v1\/)?messages$/, "");

/**
 * 360dialog (docs/360dialog.md). Same message JSON as the Cloud API; one API
 * key per number in `D360-API-KEY`; no phone-number id in paths. The sandbox
 * sends on `/v1/messages`, production on `/messages`.
 */
export class D360Provider implements WaProvider {
  readonly name = "d360" as const;
  readonly sandbox: boolean;
  readonly base: string;

  constructor(
    private cfg: Pick<Config, "waToken" | "waApiUrl">,
    private fetchFn: typeof fetch = fetch,
  ) {
    this.base = d360Base(cfg.waApiUrl);
    this.sandbox = this.base.includes("waba-sandbox");
  }

  private async call(method: string, path: string, body?: unknown): Promise<any> {
    const res = await this.fetchFn(`${this.base}${path}`, {
      method,
      headers: { "D360-API-KEY": this.cfg.waToken, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw classifySendError("360dialog", res.status, json);
    return json;
  }

  async send(msg: Outbound): Promise<string> {
    const json = await this.call("POST", this.sandbox ? "/v1/messages" : "/messages", toGraphPayload(msg));
    return json?.messages?.[0]?.id ?? `unknown-${Date.now()}`;
  }

  /** Read receipt only: 360dialog's support for the typing indicator isn't verified yet. */
  async markReadTyping(messageId: string): Promise<void> {
    if (this.sandbox) return;
    try {
      await this.call("POST", "/messages", { messaging_product: "whatsapp", status: "read", message_id: messageId });
    } catch {
      // best effort
    }
  }

  async checkKey() {
    if (this.sandbox) {
      // No health_status on the sandbox; a webhook read proves the key.
      try {
        await this.call("GET", "/v1/configs/webhook");
        return { ok: true, detail: "sandbox key accepted" };
      } catch (e) {
        return { ok: false, detail: String(e) };
      }
    }
    try {
      const j = await this.call("GET", "/health_status");
      const s = j?.health_status?.can_send_message ?? "?";
      return { ok: s !== "BLOCKED", detail: `can_send_message=${s}` };
    } catch (e) {
      return { ok: false, detail: String(e) };
    }
  }

  async getWebhook(): Promise<WebhookConfig> {
    const j = await this.call("GET", "/v1/configs/webhook");
    return { url: j?.url ?? null, headers: j?.headers ?? {} };
  }

  async setWebhook(url: string, headers: Record<string, string>) {
    await this.call("POST", "/v1/configs/webhook", { url, headers });
  }

  async listTemplates(): Promise<TemplateStatus[]> {
    const j = await this.call("GET", "/message_templates?limit=100");
    const rows = j?.waba_templates ?? j?.data ?? [];
    return rows.map((t: any) => ({ name: t.name, language: t.language, status: t.status, category: t.category }));
  }

  async createTemplate(def: TemplateDef): Promise<TemplateStatus> {
    const j = await this.call("POST", "/message_templates", templateBody(def));
    return { name: def.name, language: def.language, status: j?.status ?? "PENDING", category: j?.category };
  }
}
