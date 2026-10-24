import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { outbox, waStatuses } from "../src/db/schema";
import { setErrorSink } from "../src/lib/log";
import { runCutoff } from "../src/jobs/cutoff";
import { runWatchdog } from "../src/jobs/watchdog";
import { harness, OWNER } from "./helpers";

const ALICE = "+12015550001";
const MIN = 60 * 1000;
const HOUR = 60 * MIN;

type H = Awaited<ReturnType<typeof harness>>;
const statusPayload = (h: H, id: string, to: string, status: string, errors?: unknown[]) => ({
  object: "whatsapp_business_account",
  entry: [
    {
      id: "waba",
      changes: [
        {
          field: "messages",
          value: {
            messaging_product: "whatsapp",
            statuses: [
              { id, status, recipient_id: to.replace("+", ""), timestamp: String(Math.floor(h.clock.now.getTime() / 1000)), ...(errors ? { errors } : {}) },
            ],
          },
        },
      ],
    },
  ],
});
const lastSentId = async (h: H, to: string) =>
  (await h.db.select().from(outbox).where(eq(outbox.to, to))).filter((o) => o.waMessageId).at(-1)!.waMessageId!;
const statusOf = async (h: H, id: string) => (await h.db.select().from(waStatuses).where(eq(waStatuses.waMessageId, id)))[0];

describe("delivery statuses", () => {
  it("stores the latest status and never goes backwards", async () => {
    const h = await harness();
    await h.publishMenu();
    await h.say(ALICE, "Order");
    const id = await lastSentId(h, ALICE);
    for (const s of ["sent", "read", "delivered"]) expect((await h.post(statusPayload(h, id, ALICE, s))).status).toBe(200);
    expect(await statusOf(h, id)).toMatchObject({ status: "read", recipient: ALICE });
  });

  it("records a status that arrives before the worker saved the message id", async () => {
    const h = await harness();
    await h.post(statusPayload(h, "wamid.early", ALICE, "delivered"));
    expect(await statusOf(h, "wamid.early")).toMatchObject({ status: "delivered" });
  });

  it("logs a failed delivery as an alert, once, with the Graph error", async () => {
    const h = await harness();
    await h.publishMenu();
    await h.say(ALICE, "Order");
    const id = await lastSentId(h, ALICE);
    const alerts: Record<string, unknown>[] = [];
    setErrorSink((_m, f) => alerts.push(f));
    try {
      const err = [{ code: 131026, title: "Message undeliverable", error_data: { details: "recipient blocked" } }];
      await h.post(statusPayload(h, id, ALICE, "failed", err));
      await h.post(statusPayload(h, id, ALICE, "failed", err)); // Meta redelivery
      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toMatchObject({ alert: "delivery_failed", to: ALICE, code: 131026 });
      expect(String(alerts[0]!.error)).toContain("recipient blocked");
      expect(String(alerts[0]!.key)).toMatch(/^wamid\./);
    } finally {
      setErrorSink(null);
    }
    expect(await statusOf(h, id)).toMatchObject({ status: "failed", errorCode: 131026 });
  });

  it("alerts when the cutoff summary isn't delivered to the owner's phone", async () => {
    const h = await harness();
    await h.publishMenu();
    await h.onboard(ALICE, "Alice");
    h.advance(3 * HOUR);
    const deps = { db: h.db, wa: h.wa, llm: h.llm, cfg: h.cfg, now: () => h.clock.now };
    await runCutoff(deps);
    await h.drain();
    h.advance(16 * MIN);
    expect(await runWatchdog(deps)).toContain("summary_undelivered");

    // Once delivered, a fresh day's check stays quiet.
    const h2 = await harness();
    await h2.publishMenu();
    h2.advance(3 * HOUR);
    const d2 = { db: h2.db, wa: h2.wa, llm: h2.llm, cfg: h2.cfg, now: () => h2.clock.now };
    await runCutoff(d2);
    await h2.drain();
    const summary = (await h2.db.select().from(outbox).where(eq(outbox.to, OWNER))).filter((o) => o.idemKey.startsWith("cutoff:"));
    expect(summary.length).toBeGreaterThan(0);
    for (const o of summary) await h2.post(statusPayload(h2, o.waMessageId!, OWNER, "delivered"));
    h2.advance(16 * MIN);
    expect(await runWatchdog(d2)).not.toContain("summary_undelivered");
  });
});
