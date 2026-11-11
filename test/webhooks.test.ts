import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { customers, inbox, messages, rawWebhooks, waContacts, waStatuses } from "../src/db/schema";
import { setErrorSink } from "../src/lib/log";
import { applyEvents } from "../src/flows/router";
import { detectShape, normalizeFile, normalizeInbound } from "../src/wa/normalize";
import { harness, OWNER } from "./helpers";

const ALICE = "+12015550001";
const OPS = "+12015550177";
const fx = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/webhooks/${name}`, import.meta.url), "utf8"));

const PROVIDERS = {
  meta: {},
  d360: { WA_PROVIDER: "d360", WA_WEBHOOK_SECRET: "d360-secret", WA_APP_SECRET: "", WA_VERIFY_TOKEN: "" },
} as const;

const alerts: string[] = [];
afterEach(() => {
  setErrorSink(null);
  alerts.length = 0;
});
const captureAlerts = () => setErrorSink((_m, f) => alerts.push(String(f.alert)));

describe("normalizeInbound", () => {
  it("detects the envelope by shape, not by provider", () => {
    expect(detectShape(fx("message-text.json"))).toBe("meta_entry");
    expect(detectShape(fx("d360-history.json"))).toBe("d360_event");
    expect(detectShape(fx("unknown.json"))).toBe("unknown");
  });

  it("maps every fixture to internal events", () => {
    const kinds = (name: string) => normalizeInbound(fx(name)).map((e) => e.kind);
    expect(kinds("message-text.json")).toEqual(["message"]);
    expect(kinds("message-voice.json")).toEqual(["message"]);
    expect(kinds("status-delivered.json")).toEqual(["status"]);
    expect(kinds("echo.json")).toEqual(["echo"]);
    expect(kinds("history-meta.json")).toEqual(["history_batch"]);
    expect(kinds("d360-history.json")).toEqual(["history_batch"]);
    expect(kinds("d360-history-declined.json")).toEqual(["history_declined"]);
    expect(kinds("d360-state-sync.json")).toEqual(["contacts_sync"]);
    expect(kinds("d360-unknown-event.json")).toEqual(["unknown"]);
    expect(kinds("unknown.json")).toEqual(["unknown"]);
  });

  it("keeps the sender's profile name with the message", () => {
    const [ev] = normalizeInbound(fx("message-text.json"));
    expect(ev).toMatchObject({ kind: "message", profileName: "Alice R", message: { id: "wamid.fx.text" } });
  });

  it("reads Hub downloads: a full event, a list of events, or a bare history/state_sync array", () => {
    const hist = fx("d360-history.json");
    expect(normalizeFile(hist).map((e) => e.kind)).toEqual(["history_batch"]);
    expect(normalizeFile([hist, fx("d360-state-sync.json")]).map((e) => e.kind)).toEqual(["history_batch", "contacts_sync"]);
    expect(normalizeFile(hist.data.history).map((e) => e.kind)).toEqual(["history_batch"]);
    expect(normalizeFile({ history: hist.data.history }).map((e) => e.kind)).toEqual(["history_batch"]);
    expect(normalizeFile(fx("d360-state-sync.json").data.state_sync).map((e) => e.kind)).toEqual(["contacts_sync"]);
  });
});

for (const [provider, env] of Object.entries(PROVIDERS)) {
  describe(`webhook intake (${provider})`, () => {
    const setup = async () => {
      const h = await harness({ env: { ...env, WA_COEXISTENCE: "1", OPERATOR_NUMBERS: OPS } });
      await h.db.insert(customers).values({ phone: ALICE, name: "Alice", area: "Heights" });
      return h;
    };

    it("rejects a webhook without valid auth (401), and stores nothing", async () => {
      const h = await setup();
      captureAlerts();
      const res = await h.postRaw(fx("message-text.json"), "wrong");
      expect(res.status).toBe(401);
      expect(alerts).toContain("webhook_auth_rejected");
      expect(await h.db.select().from(rawWebhooks)).toHaveLength(0);
      // A 360dialog request has no HMAC; a Meta request has no shared secret.
      const raw = JSON.stringify(fx("message-text.json"));
      const bare = await h.app.request("/webhooks/whatsapp", { method: "POST", body: raw, headers: { "content-type": "application/json" } });
      expect(bare.status).toBe(401);
    });

    it("stores the raw body before the 200, then the worker normalizes it", async () => {
      const h = await setup();
      const res = await h.postRaw(fx("message-text.json"), undefined, "/webhooks/whatsapp");
      expect(res.status).toBe(200);
      const [row] = await h.db.select().from(rawWebhooks);
      expect(row).toMatchObject({ provider, shape: "meta_entry", status: "pending" });
      expect(await h.db.select().from(inbox)).toHaveLength(0);
      await h.worker.ingest();
      expect(await h.db.select().from(inbox)).toEqual([expect.objectContaining({ waMessageId: "wamid.fx.text", phone: ALICE, profileName: "Alice R" })]);
      expect((await h.db.select().from(rawWebhooks))[0]!.status).toBe("done");
    });

    it("dedupes redelivered bodies and repeated event ids", async () => {
      const h = await setup();
      await h.post(fx("message-text.json"));
      await h.post(fx("message-text.json"));
      await h.post(fx("d360-state-sync.json"));
      await h.post({ ...fx("d360-state-sync.json"), extra: 1 }); // same event id
      expect(await h.db.select().from(rawWebhooks)).toHaveLength(2);
      expect(await h.db.select().from(inbox)).toHaveLength(1);
    });

    it("text message: parsed and answered", async () => {
      const h = await setup();
      await h.publishMenu();
      const before = h.wa.sent.length;
      await h.post(fx("message-text.json"));
      await h.drain();
      expect(h.texts(h.wa.sent.slice(before))).toContain("Total: $12.00");
    });

    it("voice note: asks to type and forwards to the owner (media download is backlog)", async () => {
      const h = await setup();
      await h.publishMenu();
      const before = h.wa.sent.length;
      await h.post(fx("message-voice.json"));
      await h.drain();
      const out = h.wa.sent.slice(before);
      expect(out.find((m) => m.to === ALICE)!.body).toContain("Please type your order");
      expect(out.find((m) => m.to === OWNER)!.body).toContain("voice note");
    });

    it("status: recorded", async () => {
      const h = await setup();
      await h.post(fx("status-delivered.json"));
      expect(await h.db.select().from(waStatuses)).toEqual([expect.objectContaining({ waMessageId: "wamid.fx.out", status: "delivered" })]);
    });

    it("echo: owner typed in the app, bot paused for that customer", async () => {
      const h = await setup();
      await h.post(fx("echo.json"));
      const [c] = await h.db.select().from(customers).where(eq(customers.phone, ALICE));
      expect(c!.humanTakeoverUntil!.getTime()).toBeGreaterThan(h.clock.now.getTime());
      expect(await h.db.select().from(messages).where(eq(messages.source, "app"))).toHaveLength(1);
    });

    it("history (Meta envelope and 360dialog event): stored, never routed", async () => {
      const h = await setup();
      await h.post(fx("history-meta.json"));
      await h.post(fx("d360-history.json"));
      await h.drain();
      const rows = await h.db.select().from(messages).where(eq(messages.source, "history"));
      expect(rows.map((r) => [r.waMessageId, r.direction]).sort()).toEqual([
        ["wamid.fx.dh1", "in"],
        ["wamid.fx.dh2", "out"],
        ["wamid.fx.h1", "in"],
      ]);
      expect(h.wa.sent).toHaveLength(0);
    });

    it("history declined (2593109): ops alert, nothing stored", async () => {
      const h = await setup();
      captureAlerts();
      await h.post(fx("d360-history-declined.json"));
      expect(alerts).toContain("history_declined");
      expect(await h.db.select().from(messages)).toHaveLength(0);
    });

    it("app state sync: contacts stored apart from customers", async () => {
      const h = await setup();
      await h.post(fx("d360-state-sync.json"));
      expect(await h.db.select().from(waContacts)).toEqual([expect.objectContaining({ phone: ALICE, name: "Alice Rao" })]);
    });

    it("unknown shapes are kept and alerted on, never dropped", async () => {
      const h = await setup();
      captureAlerts();
      expect((await h.post(fx("unknown.json"))).status).toBe(200);
      expect((await h.post(fx("d360-unknown-event.json"))).status).toBe(200);
      const rows = await h.db.select().from(rawWebhooks);
      expect(rows.map((r) => r.shape).sort()).toEqual(["d360_event", "unknown"]);
      expect(rows.every((r) => r.body && r.status === "done")).toBe(true);
      expect(alerts.filter((a) => a === "webhook_unknown_shape")).toHaveLength(2);
    });
  });
}

describe("webhook GET verify", () => {
  it("answers Meta's challenge under meta only", async () => {
    const q = "?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=42";
    const meta = await harness();
    expect(await (await meta.app.request(`/webhook${q}`)).text()).toBe("42");
    const d360 = await harness({ env: PROVIDERS.d360 });
    expect((await d360.app.request(`/webhooks/whatsapp${q}`)).status).toBe(403);
  });
});

describe("file import (wa:sync)", () => {
  it("applies Hub history and contacts idempotently", async () => {
    const h = await harness({ env: { WA_COEXISTENCE: "1" } });
    const events = normalizeFile([fx("d360-history.json"), fx("d360-state-sync.json")]);
    const deps = { db: h.db, wa: h.wa, llm: h.llm, cfg: h.cfg, now: () => h.clock.now };
    await applyEvents(deps, events, h.clock.now);
    await applyEvents(deps, events, h.clock.now);
    expect(await h.db.select().from(messages).where(eq(messages.source, "history"))).toHaveLength(2);
    expect(await h.db.select().from(waContacts)).toHaveLength(1);
  });
});
