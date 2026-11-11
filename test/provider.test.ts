import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import { WaSendError } from "../src/wa/client";
import { classifySendError } from "../src/wa/errors";
import { createProvider, verifyInbound } from "../src/wa/provider";
import { D360Provider, d360Base } from "../src/wa/provider/d360";
import { menuTemplateDef, templateBody } from "../src/wa/provider/types";
import { sign } from "../src/wa/signature";
import { testEnv } from "./helpers";

type Call = { url: string; init: RequestInit };
const fakeFetch = (status: number, body: unknown, calls: Call[]) =>
  (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;

const msg = { kind: "text" as const, to: "+12015550001", body: "hi" };

describe("config", () => {
  it("needs the Meta secrets only for meta, and the webhook secret only for d360", () => {
    const base = { ...testEnv, WA_APP_SECRET: "", WA_VERIFY_TOKEN: "" } as unknown as NodeJS.ProcessEnv;
    expect(() => loadConfig(base)).toThrow(/WA_APP_SECRET/);
    expect(() => loadConfig({ ...base, WA_PROVIDER: "d360" })).toThrow(/WA_WEBHOOK_SECRET/);
    expect(loadConfig({ ...base, WA_PROVIDER: "d360", WA_WEBHOOK_SECRET: "s" }).waProvider).toBe("d360");
  });

  it("picks the provider from WA_PROVIDER", () => {
    const d = loadConfig({ ...testEnv, WA_PROVIDER: "d360", WA_WEBHOOK_SECRET: "s" } as unknown as NodeJS.ProcessEnv);
    expect(createProvider(d).name).toBe("d360");
    expect(createProvider(loadConfig(testEnv as unknown as NodeJS.ProcessEnv)).name).toBe("meta");
  });
});

describe("verifyInbound", () => {
  const meta = loadConfig(testEnv as unknown as NodeJS.ProcessEnv);
  const d360 = loadConfig({ ...testEnv, WA_PROVIDER: "d360", WA_WEBHOOK_SECRET: "sekret" } as unknown as NodeJS.ProcessEnv);
  const hdr = (h: Record<string, string>) => (n: string) => Object.entries(h).find(([k]) => k.toLowerCase() === n.toLowerCase())?.[1];

  it("meta: HMAC over the raw body", () => {
    expect(verifyInbound(meta, hdr({ "x-hub-signature-256": sign("{}", "app-secret") }), "{}")).toBe(true);
    expect(verifyInbound(meta, hdr({ "x-hub-signature-256": sign("{}", "nope") }), "{}")).toBe(false);
    expect(verifyInbound(meta, hdr({ "X-Preppr-Secret": "sekret" }), "{}")).toBe(false);
  });

  it("d360: shared secret header, any case", () => {
    expect(verifyInbound(d360, hdr({ "x-preppr-secret": "sekret" }), "{}")).toBe(true);
    expect(verifyInbound(d360, hdr({ "x-preppr-secret": "sekreT" }), "{}")).toBe(false);
    expect(verifyInbound(d360, hdr({}), "{}")).toBe(false);
  });
});

describe("D360Provider", () => {
  it("sends Cloud API JSON to /messages with D360-API-KEY", async () => {
    const calls: Call[] = [];
    const p = new D360Provider({ waToken: "KEY", waApiUrl: undefined }, fakeFetch(200, { messages: [{ id: "wamid.out" }] }, calls));
    expect(await p.send(msg)).toBe("wamid.out");
    expect(calls[0]!.url).toBe("https://waba-v2.360dialog.io/messages");
    expect((calls[0]!.init.headers as Record<string, string>)["D360-API-KEY"]).toBe("KEY");
    expect(JSON.parse(String(calls[0]!.init.body))).toMatchObject({ messaging_product: "whatsapp", to: "12015550001", type: "text" });
  });

  it("uses /v1/messages on the sandbox, and accepts an old full messages URL as base", async () => {
    const calls: Call[] = [];
    const p = new D360Provider({ waToken: "K", waApiUrl: "https://waba-sandbox.360dialog.io" }, fakeFetch(201, { messages: [{ id: "x" }] }, calls));
    expect(p.sandbox).toBe(true);
    await p.send(msg);
    expect(calls[0]!.url).toBe("https://waba-sandbox.360dialog.io/v1/messages");
    expect(d360Base("https://waba-v2.360dialog.io/messages")).toBe("https://waba-v2.360dialog.io");
  });

  it("sets and reads the webhook with our secret header", async () => {
    const calls: Call[] = [];
    const p = new D360Provider({ waToken: "K", waApiUrl: undefined }, fakeFetch(200, { url: "https://wa.x.com/webhooks/whatsapp", headers: { "X-Preppr-Secret": "s" } }, calls));
    await p.setWebhook("https://wa.x.com/webhooks/whatsapp", { "X-Preppr-Secret": "s" });
    expect(calls[0]!.url).toBe("https://waba-v2.360dialog.io/v1/configs/webhook");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ url: "https://wa.x.com/webhooks/whatsapp", headers: { "X-Preppr-Secret": "s" } });
    expect(await p.getWebhook()).toMatchObject({ url: "https://wa.x.com/webhooks/whatsapp" });
  });

  it("checks the key with /health_status", async () => {
    const calls: Call[] = [];
    const ok = new D360Provider({ waToken: "K", waApiUrl: undefined }, fakeFetch(200, { health_status: { can_send_message: "AVAILABLE" } }, calls));
    expect(await ok.checkKey()).toMatchObject({ ok: true });
    expect(calls[0]!.url).toBe("https://waba-v2.360dialog.io/health_status");
    const bad = new D360Provider({ waToken: "K", waApiUrl: undefined }, fakeFetch(401, { error: "Invalid API key" }, []));
    expect(await bad.checkKey()).toMatchObject({ ok: false });
  });

  it("creates templates on /message_templates as UTILITY with samples and quick replies", async () => {
    const calls: Call[] = [];
    const p = new D360Provider({ waToken: "K", waApiUrl: undefined }, fakeFetch(200, { id: "1", status: "PENDING", category: "UTILITY" }, calls));
    await p.createTemplate(menuTemplateDef("daily_order_open", "en_US"));
    expect(calls[0]!.url).toBe("https://waba-v2.360dialog.io/message_templates");
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body).toEqual(templateBody(menuTemplateDef("daily_order_open", "en_US")));
    expect(body.category).toBe("UTILITY");
    expect(JSON.stringify(body)).not.toMatch(/\$|dal|roti/i); // no dishes or prices in a template
  });
});

describe("classifySendError", () => {
  const c = (status: number, body: unknown) => classifySendError("x", status, body);
  it("retries rate limits and server errors", () => {
    expect(c(429, { error: "You have exceeded the endpoint rate limit." }).retryable).toBe(true);
    expect(c(400, { error: { code: 130429 } }).retryable).toBe(true);
    expect(c(400, { error: { code: 131056 } }).retryable).toBe(true);
    expect(c(503, {}).retryable).toBe(true);
  });
  it("does not retry a closed window or a bad recipient", () => {
    expect(c(400, { error: { code: 131047 } })).toMatchObject({ retryable: false, kind: "rejected" });
    expect(c(400, { error: { code: 131026 } })).toMatchObject({ retryable: false, kind: "rejected" });
  });
  it("flags setup problems: bad key, no balance, expired token", () => {
    expect(c(401, { error: "Invalid API key" })).toMatchObject({ retryable: false, kind: "config" });
    expect(c(403, { code: "insufficient_balance", error: "x" })).toMatchObject({ kind: "config" });
    expect(c(400, { error: { code: 190 } })).toMatchObject({ kind: "config" });
    expect(c(400, {})).toBeInstanceOf(WaSendError);
  });
});

describe("ops checks", () => {
  it("rejects webhook URLs 360dialog won't accept", async () => {
    const { webhookUrlProblem } = await import("../src/ops/checks");
    expect(webhookUrlProblem("https://wa.kitchen.com/webhooks/whatsapp")).toBeNull();
    expect(webhookUrlProblem("https://wa.kitchen.com:8443/webhooks/whatsapp")).toMatch(/port/);
    expect(webhookUrlProblem("https://wa.kitchen.com/webhooks/what_sapp")).toMatch(/_/);
    expect(webhookUrlProblem("http://wa.kitchen.com/webhooks/whatsapp")).toMatch(/https/);
  });

  it("wa:check is green against a healthy sandbox and says why when not", async () => {
    const { runChecks } = await import("../src/ops/checks");
    const { connectPglite } = await import("../src/db/client");
    const { rawWebhooks } = await import("../src/db/schema");
    const cfg = loadConfig({ ...testEnv, WA_PROVIDER: "d360", WA_WEBHOOK_SECRET: "s", WA_API_URL: "https://waba-sandbox.360dialog.io" } as unknown as NodeJS.ProcessEnv);
    const db = await connectPglite();
    const hook = { url: "https://preppr.test/webhooks/whatsapp", headers: { "X-Preppr-Secret": "s" } };
    const p = new D360Provider(cfg, fakeFetch(200, hook, []));
    let lines = await runChecks(cfg, p, db);
    expect(lines.find((l) => l.name === "last inbound event")!.result).toBe("FAIL");
    await db.insert(rawWebhooks).values({ dedupeKey: "k", provider: "d360", shape: "meta_entry", body: {} });
    lines = await runChecks(cfg, p, db);
    expect(lines.filter((l) => l.result === "FAIL")).toEqual([]);
    expect(lines.find((l) => l.name === "template")!.result).toBe("N/A");

    const wrong = new D360Provider(cfg, fakeFetch(200, { url: "https://old.example/x", headers: {} }, []));
    expect((await runChecks(cfg, wrong, db)).find((l) => l.name === "webhook set")!.result).toBe("FAIL");
  });
});
