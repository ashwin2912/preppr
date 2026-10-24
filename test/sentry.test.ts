import { describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ tags: {} as Record<string, string>, extras: {} as Record<string, unknown>, captured: [] as unknown[] }));
vi.mock("@sentry/node", () => ({
  init: vi.fn(),
  flush: vi.fn(),
  captureMessage: (m: string) => calls.captured.push(m),
  captureException: (e: Error) => calls.captured.push(e),
  withScope: (fn: (s: unknown) => void) =>
    fn({
      setTag: (k: string, v: string) => (calls.tags[k] = v),
      setFingerprint: () => {},
      setExtras: (x: Record<string, unknown>) => (calls.extras = x),
    }),
}));

import { log, setErrorSink } from "../src/lib/log";
import { initSentry } from "../src/lib/sentry";

describe("Sentry error sink", () => {
  it("sends log.error to Sentry with the alert tag, without message text", () => {
    initSentry("https://key@o0.ingest.sentry.io/0");
    try {
      log.error("send dead-lettered", { alert: "send_dead", to: "+12015550001", body: "customer text" });
      expect(calls.captured).toEqual(["send dead-lettered"]);
      expect(calls.tags.alert).toBe("send_dead");
      expect(calls.extras).toEqual({ alert: "send_dead", to: "+12015550001" });

      log.error("route failed", { error: "boom", stack: "Error: boom\n  at x" });
      expect(calls.captured[1]).toBeInstanceOf(Error);
      log.warn("not an error");
      expect(calls.captured).toHaveLength(2);
    } finally {
      setErrorSink(null);
    }
  });
});
