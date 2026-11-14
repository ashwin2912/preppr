import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { kv } from "../src/db/schema";
import { setEnvLines } from "../src/lib/env";
import { seal, unseal } from "../src/lib/sealed";
import { readSignupToken, signSignupToken, type SignupRecord } from "../src/signup/routes";
import { sign } from "../src/wa/signature";
import { harness, OWNER } from "./helpers";

type H = Awaited<ReturnType<typeof harness>>;
const FORM = { ORDER_CHANNEL: "whatsform", OWNER_ONLY: "1" };
const ES = { ...FORM, META_APP_ID: "111", ES_CONFIG_ID: "222", ES_APP_SECRET: "es-secret" };

async function login(h: H) {
  const out = await h.say(OWNER, "/app");
  const link = out[0]!.body.match(/https:\/\/preppr\.test(\/admin\?\S+)/)![1]!;
  const res = await h.app.request(link);
  return res.headers.get("set-cookie")!.split(";")[0]!;
}

const postForm = (h: H, path: string, cookie: string, origin = "https://preppr.test") =>
  h.app.request(`https://preppr.test${path}`, { method: "POST", headers: { cookie, origin, "content-type": "application/x-www-form-urlencoded" }, body: "" });

const complete = (h: H, body: Record<string, unknown>) =>
  h.app.request("/signup/complete", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

/** Stand-in for Graph: records calls, answers the three signup requests. */
function fakeGraph(fail?: string) {
  const calls: { url: string; method: string; auth: string | null }[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    const auth = new Headers(init.headers).get("authorization");
    calls.push({ url, method: init.method ?? "GET", auth });
    if (fail && url.includes(fail)) return new Response(JSON.stringify({ error: { code: 100, message: "nope" } }), { status: 400 });
    if (url.includes("/oauth/access_token")) return Response.json({ access_token: "biz-token-xyz" });
    if (url.includes("/subscribed_apps")) return Response.json({ success: true });
    return Response.json({ display_phone_number: "+1 201-555-0142", verified_name: "Test Tiffin" });
  });
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe("sealed values", () => {
  it("round-trips, and refuses a wrong secret, purpose or tampered blob", () => {
    const blob = seal("k1", "p", "hello");
    expect(blob).not.toContain("hello");
    expect(unseal("k1", "p", blob)).toBe("hello");
    expect(unseal("k2", "p", blob)).toBeNull();
    expect(unseal("k1", "q", blob)).toBeNull();
    expect(unseal("k1", "p", blob.slice(0, -2) + "AA")).toBeNull();
    expect(unseal("k1", "p", "junk")).toBeNull();
  });
});

describe("setEnvLines", () => {
  it("replaces keys in place (also commented ones) and appends the rest", () => {
    const out = setEnvLines("A=1\n# WA_TOKEN=\nB=2\n", { WA_TOKEN: "t", A: "9", NEW: "x" });
    expect(out).toBe("A=9\nWA_TOKEN=t\nB=2\nNEW=x\n");
    expect(setEnvLines("", { K: "v" })).toBe("K=v\n");
  });
});

describe("webhook signatures during the switch-over", () => {
  it("accepts the production app's and the Embedded Signup app's secret, nothing else", async () => {
    const h = await harness({ env: ES });
    const body = JSON.stringify({ object: "whatsapp_business_account", entry: [] });
    expect((await h.postRaw(body, sign(body, "app-secret"))).status).toBe(200);
    expect((await h.postRaw(body, sign(body, "es-secret"))).status).toBe(200);
    expect((await h.postRaw(body, sign(body, "other"))).status).toBe(401);
  });

  it("without ES_APP_SECRET only the production secret works", async () => {
    const h = await harness({ env: FORM });
    const body = JSON.stringify({ object: "whatsapp_business_account", entry: [] });
    expect((await h.postRaw(body, sign(body, "es-secret"))).status).toBe(401);
  });
});

describe("Embedded Signup", () => {
  it("is off (404, no card) until the app and config ids are set", async () => {
    const h = await harness({ env: FORM });
    expect((await h.app.request("/signup?t=x")).status).toBe(404);
    expect((await complete(h, {})).status).toBe(404);
    const cookie = await login(h);
    expect(await (await h.app.request("/admin/kitchen", { headers: { cookie } })).text()).not.toContain("Connect WhatsApp");
    expect((await postForm(h, "/admin/kitchen/signup", cookie)).status).toBe(303);
  });

  it("kitchen card gives a signed /signup link; the page loads Meta's SDK under its own CSP", async () => {
    const h = await harness({ env: ES });
    expect((await postForm(h, "/admin/kitchen/signup", "preppr_admin=bogus")).status).toBe(401);
    const cookie = await login(h);
    expect(await (await h.app.request("/admin/kitchen", { headers: { cookie } })).text()).toContain('action="/admin/kitchen/signup"');
    expect((await postForm(h, "/admin/kitchen/signup", cookie, "https://evil.example")).status).toBe(401);

    const res = await postForm(h, "/admin/kitchen/signup", cookie);
    expect(res.status).toBe(303);
    const loc = res.headers.get("location")!;
    expect(loc).toMatch(/^\/signup\?t=/);

    const pageRes = await h.app.request(loc);
    expect(pageRes.status).toBe(200);
    const csp = pageRes.headers.get("content-security-policy")!;
    const nonce = csp.match(/'nonce-([^']+)'/)![1]!;
    expect(csp).toContain("https://connect.facebook.net");
    expect(csp).toContain("frame-ancestors 'none'");
    const html = await pageRes.text();
    expect(html.match(new RegExp(`nonce="${nonce.replace(/[+/=]/g, "\\$&")}"`, "g"))).toHaveLength(2);
    expect(html).toContain('"configId":"222"');
    expect(html).toContain('"version":"v27.0"');
    expect(html).not.toContain("featureType");
    expect(html).not.toContain("sessionInfoVersion");

    expect((await h.app.request("/signup?t=forged")).status).toBe(401);
  });

  it("exchanges the code with the signup app's secret, subscribes the WABA, stores the token sealed", async () => {
    const h = await harness({ env: ES });
    await login(h); // opens the owner's 24 h window, so the "connected" notice can go out
    const calls = fakeGraph();
    const t = signSignupToken("admin-secret", OWNER, new Date(h.clock.now));
    const res = await complete(h, { t, code: "c0de", waba_id: "333", phone_number_id: "444" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, waba_id: "333", phone_number_id: "444", number: "Test Tiffin +1 201-555-0142" });

    const exchange = new URL(calls[0]!.url);
    expect(exchange.pathname).toBe("/v27.0/oauth/access_token");
    expect(exchange.searchParams.get("client_id")).toBe("111");
    expect(exchange.searchParams.get("client_secret")).toBe("es-secret");
    expect(calls[1]).toMatchObject({ method: "POST", auth: "Bearer biz-token-xyz" });
    expect(calls[1]!.url).toContain("/333/subscribed_apps");

    const [row] = await h.db.select().from(kv).where(eq(kv.key, "signup:444"));
    const rec = row!.value as SignupRecord;
    expect(JSON.stringify(rec)).not.toContain("biz-token-xyz");
    expect(readSignupToken("admin-secret", rec)).toBe("biz-token-xyz");
    expect(readSignupToken("other-secret", rec)).toBeNull();

    await h.drain();
    expect(h.wa.sent.at(-1)).toMatchObject({ to: OWNER, body: "WhatsApp connected: Test Tiffin +1 201-555-0142. Phone number ID 444, WABA 333." });
  });

  it("refuses expired links and bad input, and reports Graph errors without saving", async () => {
    const h = await harness({ env: ES });
    fakeGraph("subscribed_apps");
    const t = signSignupToken("admin-secret", OWNER, new Date(h.clock.now));
    expect((await complete(h, { t: "forged", code: "c", waba_id: "1", phone_number_id: "2" })).status).toBe(401);
    expect((await complete(h, { t, code: "c", waba_id: "abc", phone_number_id: "2" })).status).toBe(400);
    const res = await complete(h, { t, code: "c", waba_id: "333", phone_number_id: "444" });
    expect(res.status).toBe(502);
    expect(await h.db.select().from(kv).where(eq(kv.key, "signup:444"))).toHaveLength(0);
  });
});
