import { describe, expect, it } from "vitest";
import { outbox } from "../src/db/schema";
import { runWatchdog } from "../src/jobs/watchdog";
import { harness, OWNER } from "./helpers";

const ALICE = "+12015550001";
const OPS = "+12015550177";
const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;

type H = Awaited<ReturnType<typeof harness>>;
const depsOf = (h: H) => ({ db: h.db, wa: h.wa, llm: h.llm, cfg: h.cfg, now: () => h.clock.now });

describe("watchdog: webhooks and sends", () => {
  it("alerts ops when no webhook arrives for N minutes while ordering is open", async () => {
    const h = await harness({ env: { OPERATOR_NUMBERS: OPS, WATCHDOG_NO_INBOUND_MIN: "60" } });
    await h.say(OPS, "hi"); // operator's window open
    await h.publishMenu(); // 8:00 ET, cutoff 10:30
    h.advance(30 * MIN);
    expect(await runWatchdog(depsOf(h))).not.toContain("no_inbound");
    h.advance(31 * MIN);
    const before = h.wa.sent.length;
    expect(await runWatchdog(depsOf(h))).toContain("no_inbound");
    await h.drain();
    expect(h.wa.sent.slice(before).find((m) => m.to === OPS)!.body).toContain("No WhatsApp webhooks");
    expect(await runWatchdog(depsOf(h))).not.toContain("no_inbound"); // deduped
  });

  it("stays quiet when ordering is closed", async () => {
    const h = await harness({ env: { WATCHDOG_NO_INBOUND_MIN: "60" } });
    await h.publishMenu();
    h.advance(5 * 60 * MIN); // past cutoff
    expect(await runWatchdog(depsOf(h))).not.toContain("no_inbound");
  });

  it("alerts when sends fail above the threshold in an hour", async () => {
    const h = await harness({ env: { SEND_FAIL_THRESHOLD: "2" } });
    const now = h.clock.now;
    const row = (i: number) => ({ idemKey: `t:${i}`, to: ALICE, payload: { kind: "text" as const, to: ALICE, body: "x" }, status: "failed" as const, createdAt: now, nextAttemptAt: now });
    await h.db.insert(outbox).values([row(1), row(2)]);
    expect(await runWatchdog(depsOf(h))).not.toContain("send_failures");
    await h.db.insert(outbox).values(row(3));
    expect(await runWatchdog(depsOf(h))).toContain("send_failures");
  });

  it("reminds the owner to open the Business app after 10 days without an echo (coexistence)", async () => {
    const h = await harness({ env: { WA_COEXISTENCE: "1" } });
    await h.echo(ALICE, "hello");
    h.advance(9 * DAY);
    expect(await runWatchdog(depsOf(h))).not.toContain("app_idle");
    h.advance(1 * DAY + MIN);
    await h.say(OWNER, "HELP"); // owner window open so the reminder can go
    const before = h.wa.sent.length;
    expect(await runWatchdog(depsOf(h))).toContain("app_idle");
    await h.drain();
    expect(h.wa.sent.slice(before).find((m) => m.to === OWNER)!.body).toContain("open the WhatsApp Business app");
    expect(await runWatchdog(depsOf(h))).not.toContain("app_idle");
  });
});

describe("endpoints", () => {
  it("/health reports db, last inbound, depths and mode", async () => {
    const h = await harness();
    let body = await (await h.app.request("/health")).json();
    expect(body).toMatchObject({ ok: true, db: "ok", provider: "meta", mode: "live", botOff: false, lastInboundAt: null, outboxDepth: 0 });
    await h.postRaw(h.payload(ALICE, "hi"));
    body = await (await h.app.request("/health")).json();
    expect(body).toMatchObject({ webhookDepth: 1, lastInboundAt: h.clock.now.toISOString() });
  });

  it("/internal/cutoff takes a Bearer secret; /jobs/cutoff keeps X-Job-Secret", async () => {
    const h = await harness();
    const post = (path: string, headers: Record<string, string>) => h.app.request(path, { method: "POST", headers });
    expect((await post("/internal/cutoff", { authorization: "Bearer job-secret" })).status).toBe(200);
    expect((await post("/internal/cutoff", { authorization: "Bearer nope" })).status).toBe(403);
    expect((await post("/internal/cutoff", {})).status).toBe(403);
    expect((await post("/jobs/cutoff", { "x-job-secret": "job-secret" })).status).toBe(200);
  });
});
