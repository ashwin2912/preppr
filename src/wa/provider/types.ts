import type { WaClient } from "../client";

/** A utility template definition (Cloud API `message_templates` body). */
export type TemplateDef = {
  name: string;
  language: string;
  category: "UTILITY";
  /** Body text with {{1}}.. placeholders. */
  body: string;
  /** One sample per placeholder, for review. */
  examples: string[];
  /** Quick-reply button titles, in order. */
  quickReplies: string[];
};

export type TemplateStatus = { name: string; language: string; status: string; category?: string };

export type WebhookConfig = { url: string | null; headers: Record<string, string> };

/**
 * Everything provider-specific. `send`/`markReadTyping` (WaClient) are all
 * the worker uses; the rest is for ops scripts (`pnpm wa:*`).
 */
export interface WaProvider extends WaClient {
  readonly name: "meta" | "d360";
  /** 360dialog sandbox: fixed recipient, 25 messages, predefined templates, no media. */
  readonly sandbox: boolean;
  /** Credentials accepted by the provider. */
  checkKey(): Promise<{ ok: boolean; detail: string }>;
  /** null: webhook is configured outside the API (Meta app dashboard). */
  getWebhook(): Promise<WebhookConfig | null>;
  setWebhook(url: string, headers: Record<string, string>): Promise<void>;
  listTemplates(): Promise<TemplateStatus[]>;
  createTemplate(def: TemplateDef): Promise<TemplateStatus>;
}

/** The body both providers accept for creating a template. */
export function templateBody(def: TemplateDef) {
  return {
    name: def.name,
    language: def.language,
    category: def.category,
    components: [
      { type: "BODY", text: def.body, ...(def.examples.length ? { example: { body_text: [def.examples] } } : {}) },
      ...(def.quickReplies.length ? [{ type: "BUTTONS", buttons: def.quickReplies.map((text) => ({ type: "QUICK_REPLY", text })) }] : []),
    ],
  };
}

/** The coexistence menu push (`docs/coexistence-setup.md`). No dishes, prices or promotions: US numbers block marketing. */
export const menuTemplateDef = (name: string, language: string): TemplateDef => ({
  name,
  language,
  category: "UTILITY",
  body: "Hi {{1}}, ordering for {{2}} is open until {{3}}. Tap below to see today's menu or skip.",
  examples: ["Priya", "Mon Oct 19", "10:30 AM"],
  quickReplies: ["See menu", "Skip today"],
});
