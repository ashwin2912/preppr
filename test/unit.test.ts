import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config";
import { connectPglite } from "../src/db/client";
import { customers } from "../src/db/schema";
import { buildMenu } from "../src/domain/menu";
import { importCustomers, parseCustomersCsv } from "../src/domain/importCustomers";
import { orderTotal, priceLines, remapLines } from "../src/domain/order";
import { normalizePhone } from "../src/lib/phone";
import { extractJson, OpenAiCompatLlm } from "../src/llm/openai-compat";
import { parseClock, resolveMenuDate } from "../src/lib/time";
import { splitText } from "../src/wa/send";
import { sign, verifySignature } from "../src/wa/signature";
import { testEnv } from "./helpers";

const cfg = loadConfig(testEnv as unknown as NodeJS.ProcessEnv);
const MENU = [
  { id: "i1", name: "Dal Makhani", price_cents: 600, aliases: ["dal"] },
  { id: "i2", name: "Roti", price_cents: 100, aliases: ["roti", "chapati"] },
];

describe("signature", () => {
  it("accepts a correct HMAC and rejects anything else", () => {
    const body = '{"a":1}';
    expect(verifySignature(body, sign(body, "s"), "s")).toBe(true);
    expect(verifySignature(body, sign(body, "other"), "s")).toBe(false);
    expect(verifySignature(`${body} `, sign(body, "s"), "s")).toBe(false);
    expect(verifySignature(body, undefined, "s")).toBe(false);
    expect(verifySignature(body, "sha256=zz", "s")).toBe(false);
  });
});

describe("phone normalization", () => {
  it.each([
    ["12015551234", "+12015551234"],
    ["+1 (201) 555-1234", "+12015551234"],
    ["201-555-1234", "+12015551234"],
    ["919876543210", "+919876543210"],
    ["+91 98765 43210", "+919876543210"],
  ])("%s -> %s", (input, out) => expect(normalizePhone(input)).toBe(out));

  it.each(["", "abc", "123"])("rejects %j", (input) => expect(normalizePhone(input)).toBeNull());
});

describe("pricing", () => {
  it("prices lines from the menu, merges duplicates, and rejects bad input", () => {
    const { lines, problems } = priceLines(
      [
        { item_id: "i1", qty: 2, note: null },
        { item_id: "i2", qty: 3, note: "" },
        { item_id: "i2", qty: 1, note: null },
        { item_id: "i9", qty: 1, note: null },
        { item_id: "i1", qty: 0, note: null },
        { item_id: "i1", qty: 1.5, note: null },
      ],
      MENU,
    );
    expect(lines).toEqual([
      { item_id: "i1", name: "Dal Makhani", qty: 2, unit_cents: 600, note: null },
      { item_id: "i2", name: "Roti", qty: 4, unit_cents: 100, note: null },
    ]);
    expect(orderTotal(lines)).toBe(1600);
    expect(problems).toHaveLength(3);
  });

  it("remaps a previous order by name or alias", () => {
    const r = remapLines(
      [
        { item_id: "x1", name: "Dal Makhani", qty: 2, unit_cents: 500, note: null },
        { item_id: "x2", name: "Chapati", qty: 3, unit_cents: 100, note: null },
        { item_id: "x3", name: "Gulab Jamun", qty: 1, unit_cents: 200, note: null },
      ],
      MENU,
    );
    expect(r.lines.map((l) => [l.item_id, l.qty])).toEqual([
      ["i1", 2],
      ["i2", 3],
    ]);
    expect(r.unavailable).toEqual(["Gulab Jamun"]);
  });
});

describe("menu building", () => {
  const mon8am = new Date("2026-10-19T12:00:00Z");
  it("resolves day words in New York time", () => {
    expect(resolveMenuDate("Mon", mon8am, "America/New_York")).toBe("2026-10-19");
    expect(resolveMenuDate("tue", mon8am, "America/New_York")).toBe("2026-10-20");
    expect(resolveMenuDate("Sunday", mon8am, "America/New_York")).toBe("2026-10-25");
    expect(resolveMenuDate("tomorrow", mon8am, "America/New_York")).toBe("2026-10-20");
    expect(resolveMenuDate(null, new Date("2026-10-20T03:00:00Z"), "America/New_York")).toBe("2026-10-19");
  });

  it("parses clock strings", () => {
    expect(parseClock("10:30")).toBe("10:30");
    expect(parseClock("11am")).toBe("11:00");
    expect(parseClock("2:15 pm")).toBe("14:15");
    expect(parseClock("10.30")).toBe("10:30");
    expect(parseClock("noonish")).toBeNull();
  });

  it("assigns ids, drops unpriced items, defaults the cutoff", () => {
    const m = buildMenu(
      {
        day: "Mon",
        cutoff: null,
        items: [
          { name: "Dal Makhani", price_cents: 600, aliases: ["Dal", "daal"] },
          { name: "Mystery", price_cents: 0, aliases: [] },
        ],
      },
      mon8am,
      cfg,
    );
    expect(m.items).toEqual([{ id: "i1", name: "Dal Makhani", price_cents: 600, aliases: ["dal makhani", "dal", "daal"] }]);
    expect(m.cutoffAt.toISOString()).toBe("2026-10-19T14:30:00.000Z");
    expect(m.cutoffWasDefault).toBe(true);
  });
});

describe("splitText", () => {
  it("splits on line boundaries under the limit", () => {
    const body = Array.from({ length: 50 }, (_, i) => `line ${i} ${"x".repeat(30)}`).join("\n");
    const parts = splitText(body, 400);
    expect(parts.every((p) => p.length <= 400)).toBe(true);
    expect(parts.join("\n")).toBe(body);
  });
});

describe("customer CSV import", () => {
  const csv = `phone,name,area,address_note
201-555-0001,Alice,journal square,Apt 4B
(201) 555-0002,Bob,Hoboken,
not-a-phone,Nobody,Newport,
+1 201 555 0001,Alice K,,
12015550003,,Heights,Blue door
`;

  it("normalizes phones, matches areas, reports problems", () => {
    const { rows, report } = parseCustomersCsv(csv, cfg.areas);
    expect(rows).toEqual([
      { phone: "+12015550001", name: "Alice K", area: null, addressNote: null, notes: null },
      { phone: "+12015550002", name: "Bob", area: null, addressNote: null, notes: null },
      { phone: "+12015550003", name: null, area: "Heights", addressNote: "Blue door", notes: null },
    ]);
    expect(report.badPhones).toEqual([{ row: 4, phone: "not-a-phone" }]);
    expect(report.areaMismatches).toEqual([{ row: 3, phone: "+12015550002", area: "Hoboken" }]);
    expect(report.duplicates).toEqual(["+12015550001"]);
  });

  it("upserts without blanking existing values", async () => {
    const db = await connectPglite();
    await db.insert(customers).values({ phone: "+12015550001", name: "Old", area: "Newport", addressNote: "Keep me" });
    const { rows, report } = parseCustomersCsv(csv, cfg.areas);
    await importCustomers(db, rows, report);
    expect(report).toMatchObject({ inserted: 2, updated: 1 });
    const all = await db.select().from(customers);
    expect(all.find((c) => c.phone === "+12015550001")).toMatchObject({ name: "Alice K", area: "Newport", addressNote: "Keep me" });
  });
});

describe("OpenAI-compatible parser", () => {
  afterEach(() => vi.unstubAllGlobals());

  const reply = (content: string) =>
    new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
  const input = { message: "2 dal", menu: MENU, currentOrder: null, previousOrder: null, clarification: null };

  it("extracts JSON from fences and reasoning", () => {
    expect(extractJson('<think>{"no":1}</think>Sure:\n```json\n{"a": 1}\n```')).toEqual({ a: 1 });
    expect(extractJson("no json here")).toBeUndefined();
  });

  it("fills omitted nullable fields and quoted numbers", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reply('{"intent":"order","lines":[{"item_id":"i1","qty":"2"}],"confidence":"0.95"}')));
    const out = await new OpenAiCompatLlm("https://x/v1", "k", "m").interpret(input);
    expect(out).toEqual({
      intent: "order",
      lines: [{ item_id: "i1", qty: 2, note: null }],
      unmatched: [],
      confidence: 0.95,
      question_topic: null,
      payment_cents: null,
      payment_method: null,
      clarify_question: null,
    });
  });

  it("retries once with the validation error", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(reply('{"intent":"buy"}'))
      .mockResolvedValueOnce(reply('{"intent":"order","lines":[{"item_id":"i1","qty":2}],"confidence":1}'));
    vi.stubGlobal("fetch", fetch);
    const out = await new OpenAiCompatLlm("https://x/v1", "k", "m").interpret(input);
    expect(out.intent).toBe("order");
    const second = JSON.parse(fetch.mock.calls[1]![1].body as string);
    expect(second.messages.at(-1).content).toMatch(/invalid/);
  });
});

describe("contacts (.vcf) import", () => {
  it("imports every number on each card under its name", async () => {
    const { parseContactsVcf } = await import("../src/domain/importCustomers");
    const vcf = [
      "BEGIN:VCARD", "VERSION:3.0", "FN:Priya Shah", "TEL;type=CELL:(201) 555-0001", "item1.TEL:+1 201 555 0002", "END:VCARD",
      "BEGIN:VCARD", "VERSION:3.0", "N:Kumar;Rahul;;;", "TEL;TYPE=cell:2015550003", "END:VCARD",
      "BEGIN:VCARD", "FN:Long Name That", " Continues", "TEL:12", "END:VCARD",
    ].join("\r\n");
    const { rows, report } = parseContactsVcf(vcf);
    expect(rows.map((r) => [r.phone, r.name])).toEqual([
      ["+12015550001", "Priya Shah"],
      ["+12015550002", "Priya Shah"],
      ["+12015550003", "Rahul Kumar"],
    ]);
    expect(rows[0]).toMatchObject({ area: null, addressNote: null });
    expect(report.badPhones).toEqual([{ row: 3, phone: "12" }]);
  });
});

describe("WhatsApp chat export", () => {
  it("parses iOS and Android exports, multi-line messages, and skips system/media lines", async () => {
    const { parseChatExport } = await import("../src/domain/chatExport");
    const ios = [
      "[10/20/26, 8:01:12 AM] Tiffin Kitchen: ‎Messages and calls are end-to-end encrypted.",
      "[10/20/26, 8:14:02 AM] Priya: 2 dal",
      "3 roti",
      "[10/20/26, 8:15:00 AM] Priya: ‎image omitted",
      "[10/20/26, 8:16:00 AM] Tiffin Kitchen: Done ✅",
    ].join("\r\n");
    expect(parseChatExport(ios)).toEqual([
      { at: "10/20/26, 8:01:12 AM", author: "Tiffin Kitchen", text: "Messages and calls are end-to-end encrypted." },
      { at: "10/20/26, 8:14:02 AM", author: "Priya", text: "2 dal\n3 roti" },
      { at: "10/20/26, 8:16:00 AM", author: "Tiffin Kitchen", text: "Done ✅" },
    ]);
    const android = [
      "20/10/2026, 08:00 - Messages and calls are end-to-end encrypted. Tap to learn more.",
      "20/10/2026, 08:14 - Rahul Kumar: aaj ka menu?",
      "20/10/2026, 08:15 - Rahul Kumar: <Media omitted>",
      "10/21/26, 9:02 AM - Rahul Kumar: same as kal",
    ].join("\n");
    expect(parseChatExport(android).map((m) => [m.author, m.text])).toEqual([
      ["Rahul Kumar", "aaj ka menu?"],
      ["Rahul Kumar", "same as kal"],
    ]);
  });

  it("guesses the kitchen account and masks personal details", async () => {
    const { anonymize, guessOwner } = await import("../src/domain/chatExport");
    const k = (a: string) => ({ at: "", author: a, text: "x" });
    expect(guessOwner([[k("Kitchen"), k("Priya")], [k("Kitchen"), k("Rahul")]])).toBe("Kitchen");
    expect(anonymize("Hi it's Priya Shah, call me on (201) 555-0101 or p@x.com", ["Priya Shah"])).toBe(
      "Hi it's <name> <name>, call me on <phone> or <email>",
    );
  });
});
