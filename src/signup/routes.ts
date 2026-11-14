import { randomBytes } from "node:crypto";
import type { Hono } from "hono";
import { z } from "zod";
import { kv } from "../db/schema";
import type { Deps } from "../flows/router";
import { esc } from "../admin/html";
import { signViewerToken, verifyViewerToken } from "../admin/auth";
import { errFields, log } from "../lib/log";
import { seal, unseal } from "../lib/sealed";
import { sendText } from "../wa/send";

/** Signup links use their own key, so a CHATS link can't open signup and vice versa. */
const signupSecret = (adminSecret: string) => `${adminSecret}:signup`;

export const signSignupToken = (adminSecret: string, owner: string, now: Date) => signViewerToken(signupSecret(adminSecret), owner, now);
export const verifySignupToken = (adminSecret: string, token: string | undefined, now: Date) =>
  verifyViewerToken(signupSecret(adminSecret), token, now);

/** Embedded Signup is on when the Meta app, its Login for Business config, the public URL and the admin secret are all set. */
export const signupEnabled = (cfg: Deps["cfg"]) => Boolean(cfg.metaAppId && cfg.esConfigId && cfg.publicUrl && cfg.adminSecret);

const CompleteSchema = z.object({
  t: z.string(),
  code: z.string().min(1),
  waba_id: z.string().regex(/^\d+$/),
  phone_number_id: z.string().regex(/^\d+$/),
});

export type SignupRecord = {
  wabaId: string;
  phoneNumberId: string;
  displayPhoneNumber: string | null;
  verifiedName: string | null;
  /** Business integration token for this WABA (from the code exchange), sealed with ADMIN_SECRET (`readSignupToken`). */
  tokenSealed: string;
  by: string;
  at: string;
};

const TOKEN_PURPOSE = "signup-token";
/** The app secret for the code exchange: the Tech Provider app's when set, else the production app's. */
const exchangeSecret = (cfg: Deps["cfg"]) => cfg.esAppSecret || cfg.waAppSecret;

/** The business token of a finished signup, or null if ADMIN_SECRET changed since. */
export const readSignupToken = (adminSecret: string, rec: SignupRecord) => unseal(adminSecret, TOKEN_PURPOSE, rec.tokenSealed);

async function graph(deps: Deps, path: string, init: RequestInit & { token?: string } = {}) {
  const { token, ...rest } = init;
  const res = await fetch(`https://graph.facebook.com/${deps.cfg.esGraphVersion}/${path}`, {
    ...rest,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(rest.headers ?? {}) },
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const err = (json.error ?? {}) as { message?: string; code?: number };
    throw new Error(`Graph ${path.split("?")[0]} ${res.status}: ${err.code ?? ""} ${err.message ?? ""}`.trim());
  }
  return json;
}

/**
 * Finish Embedded Signup: swap the one-time code for a business token,
 * subscribe our app to the WABA's webhooks, and save the IDs. Coexistence
 * numbers need no /register step.
 */
export async function completeSignup(deps: Deps, owner: string, input: z.infer<typeof CompleteSchema>): Promise<SignupRecord> {
  const q = new URLSearchParams({ client_id: deps.cfg.metaAppId!, client_secret: exchangeSecret(deps.cfg), code: input.code });
  const tok = await graph(deps, `oauth/access_token?${q}`);
  const token = typeof tok.access_token === "string" ? tok.access_token : "";
  if (!token) throw new Error("Graph oauth/access_token: no access_token in response");

  await graph(deps, `${input.waba_id}/subscribed_apps`, { method: "POST", token });

  // Best effort: the number and name, so the owner knows which number got connected.
  let info: Record<string, unknown> = {};
  try {
    info = await graph(deps, `${input.phone_number_id}?fields=display_phone_number,verified_name`, { token });
  } catch (e) {
    log.warn("signup: phone number lookup failed", errFields(e));
  }

  const now = deps.now();
  const record: SignupRecord = {
    wabaId: input.waba_id,
    phoneNumberId: input.phone_number_id,
    displayPhoneNumber: typeof info.display_phone_number === "string" ? info.display_phone_number : null,
    verifiedName: typeof info.verified_name === "string" ? info.verified_name : null,
    tokenSealed: seal(deps.cfg.adminSecret!, TOKEN_PURPOSE, token),
    by: owner,
    at: now.toISOString(),
  };
  await deps.db
    .insert(kv)
    .values({ key: `signup:${input.phone_number_id}`, value: record, updatedAt: now })
    .onConflictDoUpdate({ target: kv.key, set: { value: record, updatedAt: now } });
  log.info("embedded signup complete", { wabaId: record.wabaId, phoneNumberId: record.phoneNumberId, number: record.displayPhoneNumber });
  return record;
}

const CSS = `
:root{--bg:#f6f5f2;--card:#fff;--ink:#1d1d1b;--muted:#6b6a66;--line:#e4e2dc;--accent:#1f7a4d;--warn:#b4441f}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--card:#1e1e1c;--ink:#ecebe6;--muted:#a3a29c;--line:#33322f;--accent:#5cc98d;--warn:#f08a65}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 -apple-system,system-ui,Segoe UI,Roboto,sans-serif}
main{max-width:560px;margin:0 auto;padding:32px 16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:20px}
h1{font-size:20px;margin:0 0 8px}ol{padding-left:20px}li{margin:6px 0}.muted{color:var(--muted);font-size:14px}
button{background:var(--accent);color:#fff;border:0;border-radius:8px;padding:12px 18px;font-size:16px;cursor:pointer;width:100%;margin-top:12px}
button:disabled{opacity:.5}#status{margin-top:14px;white-space:pre-wrap}.err{color:var(--warn)}`;

/** Only this page loads Meta's SDK, so only it gets these hosts in its CSP. */
const signupCsp = (nonce: string) =>
  [
    "default-src 'none'",
    `script-src 'nonce-${nonce}' https://connect.facebook.net`,
    "connect-src 'self' https://*.facebook.com https://connect.facebook.net",
    "frame-src https://*.facebook.com",
    "img-src https://*.facebook.com data:",
    "style-src 'unsafe-inline'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
  ].join("; ");

function signupPage(cfg: Deps["cfg"], token: string, nonce: string) {
  const conf = JSON.stringify({ appId: cfg.metaAppId, configId: cfg.esConfigId, version: cfg.esGraphVersion, t: token }).replace(/</g, "\\u003c");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Connect WhatsApp</title><style>${CSS}</style></head>
<body><main><div class="card">
<h1>Connect ${esc(cfg.kitchenName)}'s WhatsApp</h1>
<p>This connects your WhatsApp Business app number to the ordering bot. Your chats and the app keep working.</p>
<ol>
<li>Tap <b>Connect</b> and log in with Facebook.</li>
<li>Pick your business, then choose <b>connect your existing WhatsApp Business app</b>.</li>
<li>Enter your business number and confirm on your phone when the WhatsApp Business app asks. Choose to <b>share chat history</b>.</li>
</ol>
<p class="muted">Needs WhatsApp Business app 2.24.17 or newer on the phone. This page works for 12 hours.</p>
<button id="go" disabled>Connect</button>
<div id="status"></div>
</div></main>
<script nonce="${nonce}">
const C = ${conf};
const s = document.getElementById("status"), go = document.getElementById("go");
const say = (m, err) => { s.textContent = m; s.className = err ? "err" : ""; };
let code = null, ids = null, sent = false;
async function finish() {
  if (sent || !code || !ids) return;
  sent = true;
  say("Connecting…");
  try {
    const r = await fetch("/signup/complete", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ t: C.t, code, waba_id: ids.waba_id, phone_number_id: ids.phone_number_id }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || "failed");
    say("Connected ✅ " + (j.number || "") + "\\nYou can close this page.");
    go.style.display = "none";
  } catch (e) { sent = false; say("Something went wrong: " + e.message + "\\nTry again, or send us a screenshot.", true); }
}
window.addEventListener("message", (ev) => {
  let host = ""; try { host = new URL(ev.origin).hostname; } catch { return; }
  if (!/(^|\\.)facebook\\.com$/.test(host)) return;
  let d = ev.data;
  if (typeof d === "string") { try { d = JSON.parse(d); } catch { return; } }
  if (!d || d.type !== "WA_EMBEDDED_SIGNUP") return;
  if (String(d.event).startsWith("FINISH") && d.data && d.data.phone_number_id && d.data.waba_id) { ids = d.data; finish(); }
  else if (d.event === "CANCEL") say("Signup was closed before the end" + (d.data && d.data.current_step ? " (at " + d.data.current_step + ")" : "") + ". Tap Connect to try again.", true);
  else if (d.event === "ERROR") say("Meta reported an error: " + ((d.data && d.data.error_message) || "unknown"), true);
});
window.fbAsyncInit = () => {
  FB.init({ appId: C.appId, autoLogAppEvents: true, xfbml: false, version: C.version });
  go.disabled = false;
};
go.onclick = () => {
  say("");
  FB.login((resp) => {
    if (resp.authResponse && resp.authResponse.code) { code = resp.authResponse.code; finish(); }
    else if (!ids) say("Login was cancelled. Tap Connect to try again.", true);
  }, { config_id: C.configId, response_type: "code", override_default_response_type: true,
       extras: { setup: {} } }); // Embedded Signup v5: "connect existing WhatsApp Business app" is offered by default.
};
</script>
<script nonce="${nonce}" async defer crossorigin="anonymous" src="https://connect.facebook.net/en_US/sdk.js"></script>
</body></html>`;
}

function denyPage() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>Link expired</title><style>${CSS}</style></head><body><main><div class="card"><h1>Link expired</h1>
<p>This link has expired or isn't valid. Open your kitchen page and tap <b>Connect WhatsApp</b> again.</p></div></main></body></html>`;
}

/** `/signup` (Embedded Signup page, signed link from the kitchen page's Connect WhatsApp card) and `/signup/complete`. */
export function registerSignup(app: Hono, deps: Deps) {
  app.get("/signup", (c) => {
    if (!signupEnabled(deps.cfg)) return c.text("not found", 404);
    const t = c.req.query("t");
    if (!verifySignupToken(deps.cfg.adminSecret!, t, deps.now())) return c.html(denyPage(), 401);
    c.header("Cache-Control", "no-store");
    c.header("Referrer-Policy", "no-referrer");
    c.header("X-Robots-Tag", "noindex");
    c.header("X-Content-Type-Options", "nosniff");
    const nonce = randomBytes(16).toString("base64");
    c.header("Content-Security-Policy", signupCsp(nonce));
    return c.html(signupPage(deps.cfg, t!, nonce));
  });

  app.post("/signup/complete", async (c) => {
    if (!signupEnabled(deps.cfg)) return c.text("not found", 404);
    const parsed = CompleteSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "bad request" }, 400);
    const owner = verifySignupToken(deps.cfg.adminSecret!, parsed.data.t, deps.now());
    if (!owner) return c.json({ error: "link expired" }, 401);
    try {
      const rec = await completeSignup(deps, owner, parsed.data);
      const label = [rec.verifiedName, rec.displayPhoneNumber].filter(Boolean).join(" ");
      try {
        await sendText(
          { ...deps, out: { prefix: `signup:${rec.phoneNumberId}`, n: 0 } } as Parameters<typeof sendText>[0],
          owner,
          `WhatsApp connected: ${label || rec.phoneNumberId}. Phone number ID ${rec.phoneNumberId}, WABA ${rec.wabaId}.`,
        );
        deps.kick?.();
      } catch (e) {
        log.warn("signup: owner notice failed", errFields(e));
      }
      return c.json({ ok: true, number: label || null, phone_number_id: rec.phoneNumberId, waba_id: rec.wabaId });
    } catch (e) {
      log.error("embedded signup failed", errFields(e));
      return c.json({ error: e instanceof Error ? e.message : "failed" }, 502);
    }
  });
}
