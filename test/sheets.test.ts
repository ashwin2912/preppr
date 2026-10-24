import { createVerify, generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { syncSheets } from "../src/jobs/sheetSync";
import { FakeSheetSink, GoogleSheetSink } from "../src/sheets/client";
import { harness, OWNER } from "./helpers";

const ALICE = "+12015550001";
const BOB = "+12015550002";

async function day() {
  const sheets = new FakeSheetSink();
  const h = await harness({ sheets });
  const deps = { db: h.db, wa: h.wa, llm: h.llm, cfg: h.cfg, sheets, now: () => h.clock.now };
  await h.publishMenu();
  await h.onboard(ALICE, "Alice", 0);
  await h.onboard(BOB, "=HYPERLINK(\"x\")", 1); // formula-looking name must stay text
  const confirm = async (phone: string, text: string) => {
    const s = await h.say(phone, text);
    await h.say(phone, { replyId: h.buttonsOf(s).find((b) => b.id.startsWith("confirm:"))!.id });
  };
  await confirm(ALICE, "2 dal, 3 roti");
  await confirm(BOB, "1 paneer");
  return { h, sheets, deps };
}

describe("Google Sheet sync", () => {
  it("writes a day tab with kitchen totals and orders, plus Customers and Payments", async () => {
    const { sheets, deps } = await day();
    const tabs = await syncSheets(deps);
    expect(tabs).toEqual(["Orders 2026-10-19", "Customers", "Payments"]);

    const orders = sheets.tabs.get("Orders 2026-10-19")!;
    expect(orders[0]![0]).toContain("Test Tiffin");
    expect(orders[1]).toEqual(["2 confirmed", "Total $22.00"]);
    const k = orders.findIndex((r) => r[0] === "Kitchen totals");
    expect(orders.slice(k + 1, k + 4)).toEqual([["Dal Makhani", 2], ["Roti", 3], ["Paneer Bhurji", 1]]);
    const head = orders.findIndex((r) => r[0] === "Area");
    expect(orders[head + 1]!.slice(0, 9)).toEqual(["Journal Square", "Alice", ALICE, "Apt 4B", "2 Dal Makhani, 3 Roti", 15, "confirmed", "", 15]);
    expect(orders[head + 2]!.slice(0, 3)).toEqual(["Newport", "=HYPERLINK(\"x\")", BOB]);

    const cust = sheets.tabs.get("Customers")!;
    expect(cust[0]).toContain("Balance owed ($)");
    expect(cust.find((r) => r[0] === ALICE)!.slice(0, 9)).toEqual([ALICE, "Alice", "Journal Square", "Apt 4B", "active", null, 15, 0, "2026-10-19"]);
    expect(sheets.tabs.get("Payments")).toHaveLength(1); // header only
  });

  it("writes nothing when nothing changed, and re-syncs after a change", async () => {
    const { h, sheets, deps } = await day();
    await syncSheets(deps);
    expect(await syncSheets(deps)).toEqual([]);

    h.advance(60_000);
    await h.say(ALICE, "paid 15 zelle");
    expect(await syncSheets(deps)).toContain("Payments");
    const pay = sheets.tabs.get("Payments")!;
    expect(pay[1]!.slice(0, 8)).toEqual([1, expect.any(String), "Alice", ALICE, 15, "zelle", "To verify", "customer"]);

    h.advance(60_000);
    await h.say(OWNER, "VERIFY 1");
    await syncSheets(deps);
    expect(sheets.tabs.get("Payments")![1]![6]).toBe("verified");
    expect(sheets.tabs.get("Customers")!.find((r) => r[0] === ALICE)![6]).toBe(0);
  });

  it("keeps the marker on failure so the next run retries", async () => {
    const { sheets, deps } = await day();
    sheets.failNext = 1;
    await expect(syncSheets(deps)).rejects.toThrow("503");
    expect((await syncSheets(deps)).length).toBe(3);
  });

  it("is off without a sheet sink", async () => {
    const h = await harness();
    expect(await syncSheets({ db: h.db, wa: h.wa, llm: h.llm, cfg: h.cfg, now: () => h.clock.now })).toEqual([]);
  });
});

describe("GoogleSheetSink", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("signs a service-account JWT, creates the tab once, clears and writes RAW", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const key = JSON.stringify({
      client_email: "bot@proj.iam.gserviceaccount.com",
      private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
    });
    const calls: { method: string; url: string; body: any }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      const body = typeof init.body === "string" ? (init.body.startsWith("{") ? JSON.parse(init.body) : init.body) : init.body;
      calls.push({ method: init.method ?? "GET", url, body });
      if (url.includes("oauth2")) return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }));
      if (url.includes("fields=sheets")) return new Response(JSON.stringify({ sheets: [{ properties: { title: "Customers" } }] }));
      return new Response("{}");
    });
    const sink = new GoogleSheetSink(key, "SHEET");
    await sink.writeTab("Orders 2026-10-19", [["a", 1, null]], { first: true });
    await sink.writeTab("Orders 2026-10-19", [["b"]], { first: true });

    const [token] = calls;
    const assertion = new URLSearchParams(String(token!.body)).get("assertion")!;
    const [h, c, sig] = assertion.split(".");
    expect(JSON.parse(Buffer.from(c!, "base64url").toString())).toMatchObject({
      iss: "bot@proj.iam.gserviceaccount.com",
      scope: "https://www.googleapis.com/auth/spreadsheets",
    });
    expect(createVerify("RSA-SHA256").update(`${h}.${c}`).verify(publicKey, Buffer.from(sig!, "base64url"))).toBe(true);

    const api = calls.slice(1).map((x) => `${x.method} ${decodeURIComponent(x.url.replace("https://sheets.googleapis.com/v4/spreadsheets/SHEET", ""))}`);
    expect(api).toEqual([
      "GET ?fields=sheets.properties.title",
      "POST :batchUpdate",
      "POST /values/'Orders 2026-10-19':clear",
      "PUT /values/'Orders 2026-10-19'!A1?valueInputOption=RAW",
      "POST /values/'Orders 2026-10-19':clear",
      "PUT /values/'Orders 2026-10-19'!A1?valueInputOption=RAW",
    ]);
    expect(calls[2]!.body.requests[0].addSheet.properties).toEqual({ title: "Orders 2026-10-19", index: 0 });
    expect(calls[4]!.body.values).toEqual([["a", 1, ""]]);
    expect(calls.filter((x) => x.url.includes("oauth2"))).toHaveLength(1); // token cached
  });
});
