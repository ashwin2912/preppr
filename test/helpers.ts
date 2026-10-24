import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import { connectPglite, type DB } from "../src/db/client";
import { matchItem } from "../src/domain/order";
import type { InterpretInput, Interpretation, Llm, ParsedMenu } from "../src/llm/types";
import { DryRunWaClient } from "../src/wa/client";
import { sign } from "../src/wa/signature";
import type { Outbound } from "../src/wa/types";

export const OWNER = "+12015550100";
export const BOT = "+12015550199";

export const testEnv = {
  WA_APP_SECRET: "app-secret",
  WA_VERIFY_TOKEN: "verify-me",
  BOT_NUMBER: BOT,
  OWNER_NUMBERS: OWNER,
  AREAS: "Journal Square,Newport,Heights",
  CUTOFF_TIME: "10:30",
  TZ: "America/New_York",
  PAYMENT_INSTRUCTIONS: "Pay by Zelle to 201-555-0100",
  KITCHEN_NAME: "Test Tiffin",
  JOB_SECRET: "job-secret",
};

const NUMBER_WORDS: Record<string, number> = { one: 1, ek: 1, two: 2, do: 2, three: 3, teen: 3, four: 4, char: 4, five: 5 };

/**
 * Deterministic stand-in for Claude in flow tests: understands
 * "<qty> <alias>" pairs and a few keywords. The real model is tested in
 * parser.eval.test.ts.
 */
export class FakeLlm implements Llm {
  menuResult: ParsedMenu = {
    day: null,
    cutoff: "10:30",
    items: [
      { name: "Dal Makhani", price_cents: 600, aliases: ["dal", "daal", "makhani"] },
      { name: "Jeera Rice", price_cents: 400, aliases: ["rice", "jeera"] },
      { name: "Roti", price_cents: 100, aliases: ["roti", "rotis", "chapati"] },
      { name: "Paneer Bhurji", price_cents: 700, aliases: ["paneer", "bhurji"] },
      { name: "Gulab Jamun", price_cents: 200, aliases: ["gulab jamun", "jamun"] },
    ],
  };
  calls: InterpretInput[] = [];
  /** Per-message overrides. */
  overrides = new Map<string, Interpretation>();

  async parseMenu(): Promise<ParsedMenu> {
    return this.menuResult;
  }

  async interpret(input: InterpretInput): Promise<Interpretation> {
    this.calls.push(input);
    const msg = input.message.toLowerCase().trim();
    const base = {
      lines: [],
      unmatched: [],
      confidence: 1,
      question_topic: null,
      clarify_question: null,
      payment_cents: null,
      payment_method: null,
    };
    const o = this.overrides.get(msg);
    if (o) return o;
    if (/aunty|owner|human/.test(msg)) return { ...base, intent: "handoff" };
    if (/\b(paid|sent|payment)\b/.test(msg) || (input.clarification?.question.includes("How much did you send") && /^\$?\d+(\.\d{1,2})?\s*(zelle|venmo|cash|card)?$/.test(msg))) {
      const amt = msg.match(/\$?(\d+(?:\.\d{1,2})?)/);
      const method = msg.match(/\b(zelle|venmo|cash|card)\b/)?.[1] as Interpretation["payment_method"] | undefined;
      if (amt || /\b(paid|sent|payment)\b/.test(msg))
        return { ...base, intent: "payment", payment_cents: amt ? Math.round(Number(amt[1]) * 100) : null, payment_method: method ?? null };
    }
    if (/how much do i owe|my balance/.test(msg)) return { ...base, intent: "question", question_topic: "balance" };
    if (/^(hi|hello|order|menu)$/.test(msg)) return { ...base, intent: "menu" };
    if (/cancel/.test(msg)) return { ...base, intent: "cancel" };
    if (/cutoff|last time/.test(msg)) return { ...base, intent: "question", question_topic: "cutoff" };
    if (/refund|wrong/.test(msg)) return { ...base, intent: "question", question_topic: "other" };
    if (/thanks|ok/.test(msg)) return { ...base, intent: "other" };
    if (/same as (yesterday|last)/.test(msg)) {
      const p = input.previousOrder;
      return {
        ...base,
        intent: "order",
        lines: p?.lines.map((l) => ({ item_id: l.item_id, qty: l.qty, note: l.note })) ?? [],
        unmatched: p?.unavailable ?? [],
      };
    }
    const lines: Interpretation["lines"] = [];
    const unmatched: string[] = [];
    for (const part of msg.split(/,| and /)) {
      const m = part.trim().match(/^(\d+|\w+)\s+(.+?)(?:\s*\((.+)\))?$/);
      if (!m) continue;
      const qty = Number(m[1]) || NUMBER_WORDS[m[1]!] || 0;
      const item = matchItem(m[2]!, input.menu);
      if (item && qty) lines.push({ item_id: item.id, qty, note: m[3] ?? null });
      else unmatched.push(part.trim());
    }
    const intent = input.currentOrder ? "edit" : "order";
    return {
      ...base,
      intent: lines.length || unmatched.length ? intent : "other",
      lines,
      unmatched,
      confidence: unmatched.length ? 0.5 : 0.95,
      clarify_question: unmatched.length ? `We don't have ${unmatched.join(", ")} today. Anything else?` : null,
    };
  }
}

let msgSeq = 0;

export async function harness(
  opts: { start?: Date; llm?: Llm; printOutbound?: boolean; db?: DB; concurrency?: number } = {},
) {
  const start = opts.start ?? new Date("2026-10-19T12:00:00Z"); // Mon 8:00 AM ET
  const cfg = loadConfig(testEnv as unknown as NodeJS.ProcessEnv);
  const db: DB = opts.db ?? (await connectPglite());
  const wa = new DryRunWaClient(opts.printOutbound ?? false);
  const fake = new FakeLlm();
  const llm = opts.llm ?? fake;
  const clock = { now: start };
  const deps = { db, wa, llm, cfg, now: () => clock.now };
  // One row at a time: PGlite is a single connection, and it keeps tests deterministic.
  const { app, drain, worker } = createApp(deps, { concurrency: opts.concurrency ?? 1 });

  type In = string | { replyId: string; title?: string } | { type: "audio" | "image" };

  async function post(body: unknown, signature?: string) {
    const raw = JSON.stringify(body);
    return app.request("/webhook", {
      method: "POST",
      body: raw,
      headers: { "content-type": "application/json", "x-hub-signature-256": signature ?? sign(raw, cfg.waAppSecret) },
    });
  }

  function payload(from: string, input: In, id = `wamid.${++msgSeq}`) {
    const base = { id, from: from.replace("+", ""), timestamp: String(Math.floor(clock.now.getTime() / 1000)) };
    let message: Record<string, unknown>;
    if (typeof input === "string") message = { ...base, type: "text", text: { body: input } };
    else if ("replyId" in input)
      message = {
        ...base,
        type: "interactive",
        interactive: { type: "button_reply", button_reply: { id: input.replyId, title: input.title ?? input.replyId } },
      };
    else message = { ...base, type: input.type, [input.type]: { id: "media-1", mime_type: "audio/ogg" } };
    return {
      object: "whatsapp_business_account",
      entry: [{ id: "waba", changes: [{ field: "messages", value: { messaging_product: "whatsapp", messages: [message] } }] }],
    };
  }

  /** Send one inbound message and return everything the bot sent in response. */
  async function say(from: string, input: In, id?: string): Promise<Outbound[]> {
    const before = wa.sent.length;
    const res = await post(payload(from, input, id));
    if (res.status !== 200) throw new Error(`webhook ${res.status}`);
    await drain();
    return wa.sent.slice(before);
  }

  const texts = (out: Outbound[]) => out.map((o) => o.body).join("\n---\n");
  const advance = (ms: number) => (clock.now = new Date(clock.now.getTime() + ms));
  const buttonsOf = (out: Outbound[]) => out.flatMap((o) => (o.kind === "buttons" ? o.buttons : []));

  /** Owner sets and publishes the default fake menu. */
  async function publishMenu() {
    const preview = await say(OWNER, "MENU Mon: Dal makhani 6, Jeera rice 4, Roti 1, Paneer bhurji 7. Cutoff 10:30");
    const pub = buttonsOf(preview).find((b) => b.id.startsWith("menu_publish:"))!;
    return say(OWNER, { replyId: pub.id, title: "Publish" });
  }

  /** Walk a new customer through onboarding (name, first area, address). */
  async function onboard(phone: string, name: string, areaIdx = 0, address = "Apt 4B") {
    await say(phone, "Order");
    await say(phone, name);
    await say(phone, { replyId: `area:${areaIdx}` });
    return say(phone, address);
  }

  return { cfg, db, wa, llm: fake, clock, app, drain, worker, post, payload, say, texts, advance, buttonsOf, publishMenu, onboard };
}
