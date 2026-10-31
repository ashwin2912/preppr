import { eq } from "drizzle-orm";
import { conversationState, customers, messages, waContacts } from "../db/schema";
import { log } from "../lib/log";
import { normalizePhone } from "../lib/phone";
import { EchoSchema, HistorySchema, InboundMessageSchema, StateSyncSchema } from "../wa/types";
import { TAKEOVER_MS } from "./handoff";
import type { Deps } from "./router";

const at = (ts: string | undefined, fallback: Date) => (ts ? new Date(Number(ts) * 1000) : fallback);

/**
 * The owner typed in a customer's chat from the WhatsApp Business app: keep
 * it in the chat log and pause the bot for that customer (RESUME turns it
 * back on), so the bot doesn't talk over the owner.
 */
export async function recordEchoes(deps: Deps, raw: unknown[]) {
  for (const r of raw) {
    const p = EchoSchema.safeParse(r);
    const to = p.success ? normalizePhone(p.data.to) : null;
    if (!p.success || !to) {
      log.warn("unrecognized echo", { keys: r && typeof r === "object" ? Object.keys(r) : typeof r });
      continue;
    }
    const e = p.data;
    const inserted = await deps.db
      .insert(messages)
      .values({ waMessageId: e.id, phone: to, direction: "out", type: e.type, body: e.text?.body ?? null, raw: e, source: "app", createdAt: at(e.timestamp, deps.now()) })
      .onConflictDoNothing()
      .returning({ id: messages.waMessageId });
    if (!inserted.length || deps.cfg.ownerNumbers.includes(to)) continue;
    const until = new Date(deps.now().getTime() + TAKEOVER_MS);
    const paused = await deps.db.update(customers).set({ humanTakeoverUntil: until }).where(eq(customers.phone, to)).returning({ phone: customers.phone });
    if (paused.length) {
      await deps.db.delete(conversationState).where(eq(conversationState.phone, to));
      log.info("owner replied in app, bot paused", { phone: to });
    }
  }
}

/** One-time history sync: store past chats for the viewer and parser evals. Never routed. */
export async function recordHistory(deps: Deps, raw: unknown[]) {
  const bot = `+${deps.cfg.botNumber}`;
  let stored = 0;
  for (const r of raw) {
    const p = HistorySchema.safeParse(r);
    if (!p.success) {
      log.warn("unrecognized history chunk");
      continue;
    }
    if (p.data.errors?.length) log.warn("history sync error", { errors: p.data.errors });
    for (const thread of p.data.threads) {
      const rows = [];
      for (const m of thread.messages) {
        const msg = InboundMessageSchema.safeParse(m);
        if (!msg.success) continue;
        const from = normalizePhone(msg.data.from);
        const out = from === bot;
        const phone = out ? normalizePhone(thread.id ?? (msg.data as { to?: string }).to) : from;
        if (!phone) continue;
        rows.push({
          waMessageId: msg.data.id,
          phone,
          direction: out ? ("out" as const) : ("in" as const),
          type: msg.data.type,
          body: msg.data.text?.body ?? null,
          raw: msg.data,
          source: "history" as const,
          createdAt: at(msg.data.timestamp, deps.now()),
        });
      }
      if (rows.length) stored += (await deps.db.insert(messages).values(rows).onConflictDoNothing().returning({ id: messages.waMessageId })).length;
    }
  }
  log.info("history sync chunk stored", { stored });
}

/** Contact sync from the owner's app. Kept apart from customers: the address book holds friends and suppliers too. */
export async function recordContacts(deps: Deps, raw: unknown[]) {
  for (const r of raw) {
    const p = StateSyncSchema.safeParse(r);
    const phone = p.success && p.data.contact ? normalizePhone(p.data.contact.phone_number) : null;
    if (!p.success || p.data.type !== "contact" || !phone) continue;
    if (p.data.action === "remove") {
      await deps.db.delete(waContacts).where(eq(waContacts.phone, phone));
      continue;
    }
    const name = (p.data.contact?.full_name || p.data.contact?.first_name || "").trim().slice(0, 60) || null;
    await deps.db
      .insert(waContacts)
      .values({ phone, name, syncedAt: deps.now() })
      .onConflictDoUpdate({ target: waContacts.phone, set: { name, syncedAt: deps.now() } });
  }
}
