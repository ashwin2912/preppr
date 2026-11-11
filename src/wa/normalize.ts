import { createHash } from "node:crypto";
import { HistorySchema, InboundMessageSchema, WebhookPayloadSchema, type InboundMessage } from "./types";

/** "History sync is turned off by the business from the WhatsApp Business App". */
export const HISTORY_DECLINED_CODE = 2593109;

/** One thing a webhook told us, in the terms the rest of the app uses. */
export type InboundEvent =
  | { kind: "message"; message: InboundMessage; profileName: string | null }
  | { kind: "status"; statuses: unknown[] }
  /** Owner typed in the Business app (coexistence): pause the bot for that customer. */
  | { kind: "echo"; echoes: unknown[] }
  | { kind: "history_batch"; chunks: unknown[] }
  | { kind: "history_declined"; errors: unknown[] }
  | { kind: "contacts_sync"; items: unknown[] }
  /** A known envelope with a field we don't act on (account_update, ...). */
  | { kind: "ignored"; field: string }
  /** Nothing we recognize: kept in raw_webhooks and alerted on. */
  | { kind: "unknown"; reason: string };

export type Shape = "meta_entry" | "d360_event" | "unknown";

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);

/**
 * By shape, not by provider: 360dialog forwards Meta's `entry[].changes[]`
 * for messages/statuses/echoes, and its own `{id, event, data}` for
 * coexistence history and contact sync.
 */
export function detectShape(body: unknown): Shape {
  if (isObj(body) && Array.isArray(body.entry)) return "meta_entry";
  if (isObj(body) && typeof body.event === "string" && isObj(body.data)) return "d360_event";
  return "unknown";
}

/** Idempotency key for a raw delivery. */
export function dedupeKey(body: unknown, raw: string): string {
  if (detectShape(body) === "d360_event" && (body as { id?: unknown }).id != null) return `event:${String((body as { id: unknown }).id)}`;
  return `sha256:${createHash("sha256").update(raw, "utf8").digest("hex")}`;
}

const hasDeclined = (chunk: unknown) =>
  isObj(chunk) && Array.isArray(chunk.errors) && chunk.errors.some((e) => isObj(e) && e.code === HISTORY_DECLINED_CODE);

/** One `field` + `value` pair (a Meta change, or a 360dialog event's data). */
function fromChange(field: string, value: Record<string, unknown>, out: InboundEvent[], strict: boolean) {
  const arr = (k: string) => (Array.isArray(value[k]) ? (value[k] as unknown[]) : []);
  switch (field) {
    case "smb_message_echoes":
      out.push({ kind: "echo", echoes: arr("message_echoes") });
      return;
    case "history": {
      const chunks = arr("history");
      const declined = chunks.filter(hasDeclined);
      if (declined.length) out.push({ kind: "history_declined", errors: declined.flatMap((c) => (c as { errors: unknown[] }).errors) });
      const ok = chunks.filter((c) => !hasDeclined(c));
      if (ok.length) out.push({ kind: "history_batch", chunks: ok });
      return;
    }
    case "smb_app_state_sync":
      out.push({ kind: "contacts_sync", items: arr("state_sync") });
      return;
    case "messages": {
      const statuses = arr("statuses");
      if (statuses.length) out.push({ kind: "status", statuses });
      const contacts = arr("contacts") as { wa_id?: string; profile?: { name?: string } }[];
      for (const raw of arr("messages")) {
        const m = InboundMessageSchema.safeParse(raw);
        if (!m.success) {
          out.push({ kind: "unknown", reason: "unparseable message" });
          continue;
        }
        const profileName = contacts.find((c) => c?.wa_id === m.data.from)?.profile?.name?.trim().slice(0, 60) || null;
        out.push({ kind: "message", message: m.data, profileName });
      }
      return;
    }
    default:
      out.push(strict ? { kind: "unknown", reason: `event ${field}` } : { kind: "ignored", field });
  }
}

/** Turns any webhook body into events. Never throws. */
export function normalizeInbound(body: unknown): InboundEvent[] {
  const out: InboundEvent[] = [];
  switch (detectShape(body)) {
    case "meta_entry": {
      const p = WebhookPayloadSchema.safeParse(body);
      if (!p.success) return [{ kind: "unknown", reason: "bad entry envelope" }];
      for (const entry of p.data.entry)
        for (const change of entry.changes) fromChange(change.field ?? "messages", change.value as Record<string, unknown>, out, false);
      return out;
    }
    case "d360_event": {
      const b = body as { event: string; data: Record<string, unknown> };
      fromChange(b.event, b.data, out, true);
      return out;
    }
    default:
      return [{ kind: "unknown", reason: "unrecognized envelope" }];
  }
}

/**
 * A file from the 360dialog Hub (or anywhere else): a full webhook body, an
 * array of bodies, or a bare `history[]` / `state_sync[]` list.
 */
export function normalizeFile(json: unknown): InboundEvent[] {
  if (Array.isArray(json)) {
    if (json.every((x) => detectShape(x) !== "unknown")) return json.flatMap(normalizeInbound);
    if (json.some((x) => HistorySchema.safeParse(x).success && isObj(x) && ("threads" in x || "errors" in x)))
      return normalizeInbound({ event: "history", data: { history: json } });
    return normalizeInbound({ event: "smb_app_state_sync", data: { state_sync: json } });
  }
  if (isObj(json) && detectShape(json) === "unknown") {
    if (Array.isArray(json.history)) return normalizeInbound({ event: "history", data: json });
    if (Array.isArray(json.state_sync)) return normalizeInbound({ event: "smb_app_state_sync", data: json });
  }
  return normalizeInbound(json);
}
