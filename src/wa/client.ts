import { toWaId } from "../lib/phone";
import { log } from "../lib/log";
import type { Outbound } from "./types";

export interface WaClient {
  /** Returns the outbound wamid. */
  send(msg: Outbound): Promise<string>;
  /** Mark inbound message read and show a typing indicator. Best effort. */
  markReadTyping(messageId: string): Promise<void>;
}

// WhatsApp interactive limits.
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
export const BODY_MAX = 4096;
const INTERACTIVE_BODY_MAX = 1024;

export function toGraphPayload(msg: Outbound): Record<string, unknown> {
  const base = { messaging_product: "whatsapp", recipient_type: "individual", to: toWaId(msg.to) };
  switch (msg.kind) {
    case "text":
      return { ...base, type: "text", text: { body: clip(msg.body, BODY_MAX), preview_url: true } };
    case "buttons":
      return {
        ...base,
        type: "interactive",
        interactive: {
          type: "button",
          body: { text: clip(msg.body, INTERACTIVE_BODY_MAX) },
          action: {
            buttons: msg.buttons.slice(0, 3).map((b) => ({
              type: "reply",
              reply: { id: clip(b.id, 256), title: clip(b.title, 20) },
            })),
          },
        },
      };
    case "list":
      return {
        ...base,
        type: "interactive",
        interactive: {
          type: "list",
          body: { text: clip(msg.body, INTERACTIVE_BODY_MAX) },
          action: {
            button: clip(msg.button, 20),
            sections: [
              {
                title: "Options",
                rows: msg.rows.slice(0, 10).map((r) => ({
                  id: clip(r.id, 200),
                  title: clip(r.title, 24),
                  ...(r.description ? { description: clip(r.description, 72) } : {}),
                })),
              },
            ],
          },
        },
      };
  }
}

export class GraphWaClient implements WaClient {
  constructor(
    private token: string,
    private phoneNumberId: string,
    private version: string,
  ) {}

  private async post(body: unknown): Promise<any> {
    const res = await fetch(`https://graph.facebook.com/${this.version}/${this.phoneNumberId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Graph API ${res.status}: ${JSON.stringify(json)}`);
    return json;
  }

  async send(msg: Outbound): Promise<string> {
    const json = await this.post(toGraphPayload(msg));
    return json?.messages?.[0]?.id ?? `unknown-${Date.now()}`;
  }

  async markReadTyping(messageId: string): Promise<void> {
    try {
      await this.post({
        messaging_product: "whatsapp",
        status: "read",
        message_id: messageId,
        typing_indicator: { type: "text" },
      });
    } catch (e) {
      log.warn("markReadTyping failed", { messageId, error: String(e) });
    }
  }
}

/** Prints instead of calling Meta. Used by `WA_DRY_RUN=1` and the simulator. */
export class DryRunWaClient implements WaClient {
  sent: Outbound[] = [];
  private n = 0;
  constructor(private print = true) {}

  async send(msg: Outbound): Promise<string> {
    this.sent.push(msg);
    if (this.print) console.log(renderOutbound(msg));
    return `dry-${++this.n}-${Date.now()}`;
  }

  async markReadTyping(): Promise<void> {}
}

export function renderOutbound(msg: Outbound): string {
  const head = `\n── bot → ${msg.to} ──\n${msg.body}`;
  if (msg.kind === "buttons") return `${head}\n${msg.buttons.map((b) => `[${b.title}]`).join(" ")}`;
  if (msg.kind === "list") return `${head}\n${msg.rows.map((r) => `• ${r.title}`).join("\n")}`;
  return head;
}
