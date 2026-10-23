import { Hono } from "hono";
import { processPayload, type Deps } from "./flows/router";
import { runCutoff } from "./jobs/cutoff";
import { errFields, log } from "./lib/log";
import { secretEquals, verifySignature } from "./wa/signature";

export function createApp(deps: Deps) {
  const app = new Hono();
  // In-flight webhook work. Cloud Run must run with CPU always allocated so this
  // keeps running after the 200 goes out. Tests and the simulator await drain().
  const pending = new Set<Promise<void>>();
  const track = (p: Promise<void>) => {
    pending.add(p);
    p.finally(() => pending.delete(p));
  };

  app.get("/healthz", (c) => c.text("ok"));

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
    track(
      processPayload(deps, body).catch((e) => log.error("processPayload crashed", errFields(e))),
    );
    return c.text("ok");
  });

  app.post("/jobs/cutoff", async (c) => {
    if (!secretEquals(c.req.header("x-job-secret"), deps.cfg.jobSecret)) return c.text("forbidden", 403);
    const result = await runCutoff(deps);
    return c.json(result);
  });

  const drain = async () => {
    while (pending.size) await Promise.all([...pending]);
  };
  return { app, drain };
}
