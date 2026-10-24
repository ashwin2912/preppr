import { describe, expect, it } from "vitest";
import { inbox } from "../src/db/schema";
import { setErrorSink } from "../src/lib/log";
import { runWatchdog } from "../src/jobs/watchdog";
import { runCutoff } from "../src/jobs/cutoff";
import { harness, OWNER } from "./helpers";

const ALICE = "+12015550001";
const MIN = 60 * 1000;
const HOUR = 60 * MIN;

const depsOf = (h: Awaited<ReturnType<typeof harness>>) => ({ db: h.db, wa: h.wa, llm: h.llm, cfg: h.cfg, now: () => h.clock.now });

describe("watchdog", () => {
  it("alerts once when no menu is published by 9:00 on a kitchen day", async () => {
    const h = await harness({ start: new Date("2026-10-19T12:30:00Z") }); // Mon 8:30 AM ET
    const errors: string[] = [];
    setErrorSink((_m, f) => errors.push(String(f.alert)));
    try {
      expect(await runWatchdog(depsOf(h))).toEqual([]);
      h.advance(31 * MIN); // 9:01
      expect(await runWatchdog(depsOf(h))).toEqual(["no_menu"]);
      expect(await runWatchdog(depsOf(h))).toEqual([]); // deduped
      expect(errors).toEqual(["no_menu"]);
    } finally {
      setErrorSink(null);
    }
  });

  it("stays quiet on a non-kitchen day and once the menu is out", async () => {
    const sunday = await harness({ start: new Date("2026-10-18T15:00:00Z") }); // Sun 11 AM ET
    expect(await runWatchdog(depsOf(sunday))).toEqual([]);
    const h = await harness();
    await h.publishMenu();
    h.advance(2 * HOUR); // 10:00
    expect(await runWatchdog(depsOf(h))).toEqual([]);
  });

  it("alerts when the cutoff summary is still undelivered 30 min after cutoff", async () => {
    const h = await harness();
    await h.publishMenu();
    await h.onboard(ALICE, "Alice");
    h.advance(25 * HOUR); // owner window closed, so the summary can't go out
    await runCutoff(depsOf(h));
    expect(await runWatchdog(depsOf(h))).toContain("summary_late");
    expect(await runWatchdog(depsOf(h))).not.toContain("summary_late");
  });

  it("alerts on a stuck queue, and /readyz reports it", async () => {
    const h = await harness();
    await h.publishMenu();
    expect((await h.app.request("/readyz")).status).toBe(200);
    await h.post(h.payload(ALICE, "Order")); // queued, worker not running
    h.advance(3 * MIN);
    const res = await h.app.request("/readyz");
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ ok: false, backlog: { inbox: 1 } });
    expect(await runWatchdog(depsOf(h))).toContain("queue_backlog");
    await h.drain();
    expect((await h.app.request("/readyz")).status).toBe(200);
    expect(await h.db.select().from(inbox)).toHaveLength(3);
  });

  it("nudges the owner once a day about payments unverified for a day", async () => {
    const h = await harness();
    await h.publishMenu();
    await h.onboard(ALICE, "Alice");
    await h.say(ALICE, "paid 10 zelle");
    h.advance(25 * HOUR);
    await h.say(OWNER, "HELP"); // owner window open
    expect(await runWatchdog(depsOf(h))).toContain("payments_unverified");
    await h.drain();
    expect(h.wa.sent.at(-1)).toMatchObject({ to: OWNER, body: expect.stringContaining("1 reported payment(s)") });
    expect(await runWatchdog(depsOf(h))).not.toContain("payments_unverified");
  });
});
