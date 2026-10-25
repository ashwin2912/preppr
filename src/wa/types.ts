import { z } from "zod";

// Permissive shapes: only the fields we read are declared, the rest pass through.

export const InboundMessageSchema = z.looseObject({
  id: z.string(),
  from: z.string(),
  timestamp: z.string().optional(),
  type: z.string(),
  text: z.looseObject({ body: z.string() }).optional(),
  interactive: z
    .looseObject({
      type: z.string(),
      button_reply: z.looseObject({ id: z.string(), title: z.string() }).optional(),
      list_reply: z.looseObject({ id: z.string(), title: z.string() }).optional(),
    })
    .optional(),
  button: z.looseObject({ payload: z.string().optional(), text: z.string().optional() }).optional(),
  /** Contact cards shared in the chat (type "contacts"). */
  contacts: z
    .array(
      z.looseObject({
        name: z.looseObject({ formatted_name: z.string().optional(), first_name: z.string().optional(), last_name: z.string().optional() }).optional(),
        phones: z.array(z.looseObject({ phone: z.string().optional(), wa_id: z.string().optional() })).optional(),
      }),
    )
    .optional(),
});
export type InboundMessage = z.infer<typeof InboundMessageSchema>;

export const WebhookPayloadSchema = z.looseObject({
  object: z.string().optional(),
  entry: z
    .array(
      z.looseObject({
        changes: z
          .array(
            z.looseObject({
              field: z.string().optional(),
              value: z.looseObject({
                messages: z.array(z.unknown()).optional(),
                statuses: z.array(z.unknown()).optional(),
                /** Sender's WhatsApp profile, one entry per sender in `messages`. */
                contacts: z
                  .array(z.looseObject({ wa_id: z.string().optional(), profile: z.looseObject({ name: z.string().optional() }).optional() }))
                  .optional(),
              }),
            }),
          )
          .default([]),
      }),
    )
    .default([]),
});

export type Button = { id: string; title: string };
export type ListRow = { id: string; title: string; description?: string };

export type Outbound =
  | { kind: "text"; to: string; body: string }
  | { kind: "buttons"; to: string; body: string; buttons: Button[] }
  | { kind: "list"; to: string; body: string; button: string; rows: ListRow[] };

/** What the bot extracts from any inbound message. */
export type Incoming = {
  id: string;
  /** E.164 */
  phone: string;
  type: string;
  /** Text body, or button/list title for interactive replies. */
  text: string;
  /** Button / list reply id, if interactive. */
  replyId: string | null;
  raw: unknown;
};

export const MEDIA_TYPES = new Set(["audio", "voice", "image", "video", "document", "sticker", "contacts", "location"]);
