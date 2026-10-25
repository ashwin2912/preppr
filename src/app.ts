import { Hono } from "hono";
import { enqueuePayload, type Deps } from "./flows/router";
import { runCutoff } from "./jobs/cutoff";
import { sql } from "drizzle-orm";
import { backlog } from "./jobs/watchdog";
import { createWorker, type WorkerOptions } from "./jobs/worker";
import { registerAdmin } from "./admin/routes";
import { errFields, log } from "./lib/log";
import { secretEquals, verifySignature } from "./wa/signature";

export function createApp(baseDeps: Deps, workerOpts?: WorkerOptions) {
  const app = new Hono();
  // Messages are handled by the worker after the 200 goes out. Cloud Run must run
  // with CPU always allocated so it keeps running. Tests and the simulator call drain().
  const worker = createWorker(baseDeps, workerOpts);
  const deps: Deps = { ...baseDeps, kick: worker.kick };

  app.get("/healthz", (c) => c.text("ok"));

  // For UptimeRobot: database reachable and the worker keeping up.
  app.get("/readyz", async (c) => {
    try {
      await deps.db.execute(sql`select 1`);
      const b = await backlog(deps.db, deps.now());
      const ok = b.inbox === 0 && b.outbox === 0;
      return c.json({ ok, db: "ok", backlog: b }, ok ? 200 : 503);
    } catch (e) {
      log.error("readyz failed", errFields(e));
      return c.json({ ok: false, db: "error" }, 503);
    }
  });

  app.get("/webhook", (c) => {
    const mode = c.req.query("hub.mode");
    const token = c.req.query("hub.verify_token");
    const challenge = c.req.query("hub.challenge");
    if (mode === "subscribe" && secretEquals(token, deps.cfg.waVerifyToken) && challenge) return c.text(challenge);
    return c.text("forbidden", 403);
  });

  app.post("/webhook", async (c) => {
    const raw = await c.req.text();
    if (!verifySignature(raw, c.req.header("x-hub-signature-256"), deps.cfg.waAppSecret)) {
      log.warn("bad webhook signature");
      return c.text("bad signature", 401);
    }
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return c.text("bad json", 400);
    }
    try {
      if (await enqueuePayload(deps, body)) worker.kick();
    } catch (e) {
      // Not saved: a non-2xx makes Meta redeliver.
      log.error("enqueue failed", errFields(e));
      return c.text("try again", 500);
    }
    return c.text("ok");
  });

  registerAdmin(app, deps);

  app.post("/jobs/cutoff", async (c) => {
    if (!secretEquals(c.req.header("x-job-secret"), deps.cfg.jobSecret)) return c.text("forbidden", 403);
    const result = await runCutoff(deps);
    return c.json(result);
  });

  return { app, drain: worker.drain, worker };
}
