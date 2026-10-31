import { describe, expect, it } from "vitest";
import { parseChatExport } from "../src/domain/chatExport";
import {
  csvCell,
  daySummary,
  detectDateOrder,
  exportDate,
  extractOrders,
  findMenuTexts,
  ordersCsv,
  parseMenuText,
  type ExportChat,
} from "../src/domain/exportOrders";
import { FakeLlm } from "./helpers";

const MENU = "Fri menu 🍛\nDal Makhani $6\nJeera Rice $4\nRoti $1\nOrder by 10:30";

const ios = (lines: [string, string, string][]) => lines.map(([at, who, text]) => `[${at}] ${who}: ${text}`).join("\n");
const android = (lines: [string, string, string][]) => lines.map(([at, who, text]) => `${at} - ${who}: ${text}`).join("\n");

const chats: ExportChat[] = [
  {
    file: "Priya",
    messages: parseChatExport(
      ios([
        ["10/29/26, 9:00:00 AM", "Priya", "2 roti"],
        ["10/30/26, 7:30:00 AM", "Tiffin Kitchen", MENU],
        ["10/30/26, 8:14:02 AM", "Priya", "2 dal, 3 roti"],
        ["10/30/26, 8:15:00 AM", "Tiffin Kitchen", "Noted 👍"],
      ]),
    ),
  },
  {
    file: "WhatsApp Chat with Rahul.txt",
    messages: parseChatExport(
      android([
        ["10/30/26, 7:30 AM", "Tiffin Kitchen", MENU],
        ["10/30/26, 8:20 AM", "Rahul", "1 rice"],
        ["10/30/26, 9:05 AM", "Rahul", "cancel"],
      ]),
    ),
  },
  {
    file: "Meera",
    messages: parseChatExport(
      ios([
        ["10/30/26, 7:30:00 AM", "Tiffin Kitchen", MENU],
        ["10/30/26, 8:40:00 AM", "Meera", "2 biryani"],
      ]),
    ),
  },
];

describe("export dates", () => {
  it("reads month-first, day-first and 4-digit years", () => {
    expect(exportDate("10/30/26, 8:14 AM", "mdy")).toBe("2026-10-30");
    expect(exportDate("30/10/2026, 08:14", "dmy")).toBe("2026-10-30");
    expect(exportDate("2026-10-30, 08:14", "mdy")).toBe("2026-10-30");
    expect(exportDate("13/13/26, 8:14", "mdy")).toBeNull();
  });

  it("detects the order from a part over 12", () => {
    expect(detectDateOrder(chats)).toBe("mdy");
    const uk: ExportChat = { file: "x", messages: [{ at: "30/10/2026, 08:14", author: "A", text: "hi" }] };
    expect(detectDateOrder([uk])).toBe("dmy");
  });
});

describe("orders from exports", () => {
  it("finds the broadcast menu and reads each customer's orders that day", async () => {
    const llm = new FakeLlm();
    const texts = findMenuTexts(chats, "Tiffin Kitchen", "mdy");
    expect([...texts.keys()]).toEqual(["2026-10-30"]);
    expect(texts.get("2026-10-30")).toBe(MENU);

    const items = await parseMenuText(llm, MENU);
    const orders = await extractOrders(llm, chats, "Tiffin Kitchen", new Map([["2026-10-30", items]]), "mdy");

    const priya = orders.find((o) => o.customer === "Priya")!;
    expect(priya.lines.map((l) => [l.name, l.qty])).toEqual([
      ["Dal Makhani", 2],
      ["Roti", 3],
    ]);
    expect(priya.totalCents).toBe(1500);
    expect(priya.check).toEqual([]);

    const rahul = orders.find((o) => o.customer === "Rahul")!;
    expect(rahul.cancelled).toBe(true);
    expect(rahul.lines).toEqual([]);

    const meera = orders.find((o) => o.customer === "Meera")!;
    expect(meera.lines).toEqual([]);
    expect(meera.check.join()).toMatch(/biryani/);

    // The day before had no menu, so Priya's "2 roti" on 10/29 isn't read.
    expect(orders.every((o) => o.date === "2026-10-30")).toBe(true);

    const summary = daySummary("2026-10-30", orders);
    expect(summary).toContain("1 orders, $15.00");
    expect(summary).toContain("2 × Dal Makhani");
    expect(summary).toMatch(/Rahul: cancelled/);
    expect(summary).toMatch(/Meera: unclear/);

    const csv = ordersCsv(orders).trim().split("\n");
    expect(csv[0]).toBe('"date","customer","items","total","status","check","messages"');
    expect(csv).toHaveLength(4);
    expect(csv.find((r) => r.includes("Priya"))).toContain('"ok"');
    expect(csv.find((r) => r.includes("Meera"))).toContain('"check"');
  });

  it("flags customers who wrote on a day with no menu", async () => {
    const llm = new FakeLlm();
    const orders = await extractOrders(llm, chats, "Tiffin Kitchen", new Map(), "mdy", ["2026-10-29"]);
    expect(orders).toEqual([expect.objectContaining({ customer: "Priya", check: ["no menu found for this day"] })]);
  });

  it("keeps CSV cells from running as spreadsheet formulas", () => {
    expect(csvCell("=HYPERLINK(1)")).toBe(`"'=HYPERLINK(1)"`);
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
  });
});
