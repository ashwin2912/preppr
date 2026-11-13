import { Hono, type Context } from "hono";
import { storeWebhook, type Deps } from "./flows/router";
import { runCutoff } from "./jobs/cutoff";
import { sql } from "drizzle-orm";
import { backlog } from "./jobs/watchdog";
import { createWorker, type WorkerOptions } from "./jobs/worker";
import { registerAdmin } from "./admin/routes";
import { registerFormWebhook } from "./flows/formOrders";
import { registerFormMenu } from "./flows/formMenu";
import { registerOrderPage } from "./flows/orderPage";
import { errFields, log } from "./lib/log";
import { secretEquals } from "./wa/signature";
import { verifyInbound } from "./wa/provider";
import { healthReport } from "./jobs/watchdog";

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

  // For an uptime monitor: database, last webhook, queue depths, mode. 503 only if the DB is down.
  app.get("/health", async (c) => {
    try {
      return c.json({ ok: true, ...(await healthReport(deps)) });
    } catch (e) {
      log.error("health failed", errFields(e));
      return c.json({ ok: false, db: "error" }, 503);
    }
  });

  // Meta's subscribe challenge. 360dialog sets the URL by API instead (pnpm wa:webhook:set).
  const verifyGet = (c: Context) => {
    const mode = c.req.query("hub.mode");
    const token = c.req.query("hub.verify_token");
    const challenge = c.req.query("hub.challenge");
    if (deps.cfg.waProvider === "meta" && mode === "subscribe" && secretEquals(token, deps.cfg.waVerifyToken) && challenge) return c.text(challenge);
    return c.text("forbidden", 403);
  };

  // Store the body as received, ack, and let the worker normalize it (src/wa/normalize.ts).
  const receive = async (c: Context) => {
    const raw = await c.req.text();
    if (!verifyInbound(deps.cfg, (h) => c.req.header(h), raw)) {
      // ERROR so Sentry counts them (one issue, fingerprinted on message + alert).
      log.error("webhook rejected: bad signature or secret", { alert: "webhook_auth_rejected", provider: deps.cfg.waProvider });
      return c.text("unauthorized", 401);
    }
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return c.text("bad json", 400);
    }
    try {
      if (await storeWebhook(deps, raw, body)) worker.kick();
    } catch (e) {
      // Not saved: a non-2xx makes the provider redeliver.
      log.error("webhook store failed", errFields(e));
      return c.text("try again", 500);
    }
    return c.text("ok");
  };

  // /webhooks/whatsapp is the 360dialog URL (no underscores or ports allowed); /webhook stays for Meta.
  for (const path of ["/webhook", "/webhooks/whatsapp"]) {
    app.get(path, verifyGet);
    app.post(path, receive);
  }

  registerAdmin(app, deps);
  registerFormWebhook(app, deps);
  registerFormMenu(app, deps);
  registerOrderPage(app, deps);

  // X-Job-Secret (original) or Authorization: Bearer (Cloudflare Worker cron).
  const cutoff = async (c: Context) => {
    const bearer = c.req.header("authorization")?.replace(/^Bearer\s+/i, "");
    if (!secretEquals(c.req.header("x-job-secret"), deps.cfg.jobSecret) && !secretEquals(bearer, deps.cfg.jobSecret)) return c.text("forbidden", 403);
    return c.json(await runCutoff(deps));
  };
  app.post("/jobs/cutoff", cutoff);
  app.post("/internal/cutoff", cutoff);

  return { app, drain: worker.drain, worker };
}
