import type { Config } from "../../config";
import { log } from "../../lib/log";
import { GraphWaClient } from "../client";
import { classifySendError } from "../errors";
import type { Outbound } from "../types";
import { templateBody, type TemplateDef, type TemplateStatus, type WaProvider, type WebhookConfig } from "./types";

/** Meta Cloud API direct (graph.facebook.com), system-user token. */
export class MetaProvider implements WaProvider {
  readonly name = "meta" as const;
  readonly sandbox = false;
  private client: GraphWaClient;
  private graph: string;

  constructor(private cfg: Config) {
    this.client = new GraphWaClient(cfg.waToken, cfg.waPhoneNumberId, cfg.waGraphVersion, { url: cfg.waApiUrl, authHeader: cfg.waAuthHeader });
    this.graph = `https://graph.facebook.com/${cfg.waGraphVersion}`;
  }

  send(msg: Outbound) {
    return this.client.send(msg);
  }
  markReadTyping(id: string) {
    return this.client.markReadTyping(id);
  }

  private async call(method: string, path: string, body?: unknown) {
    const res = await fetch(`${this.graph}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.cfg.waToken}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw classifySendError("Graph API", res.status, json);
    return json as any;
  }

  async checkKey() {
    try {
      const j = await this.call("GET", `/${this.cfg.waPhoneNumberId}?fields=display_phone_number,quality_rating`);
      return { ok: true, detail: `${j.display_phone_number ?? "?"} quality ${j.quality_rating ?? "?"}` };
    } catch (e) {
      return { ok: false, detail: String(e) };
    }
  }

  async getWebhook(): Promise<WebhookConfig | null> {
    return null;
  }
  async setWebhook() {
    log.info("meta: webhook is set in the Meta app dashboard (WhatsApp → Configuration), not by API");
  }

  private waba() {
    if (!this.cfg.waWabaId) throw new Error("WA_WABA_ID not set");
    return this.cfg.waWabaId;
  }

  async listTemplates(): Promise<TemplateStatus[]> {
    const j = await this.call("GET", `/${this.waba()}/message_templates?fields=name,language,status,category&limit=100`);
    return (j.data ?? []).map((t: any) => ({ name: t.name, language: t.language, status: t.status, category: t.category }));
  }

  async createTemplate(def: TemplateDef): Promise<TemplateStatus> {
    const j = await this.call("POST", `/${this.waba()}/message_templates`, templateBody(def));
    return { name: def.name, language: def.language, status: j.status ?? "PENDING", category: j.category };
  }
}
