import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import { customers, messages, waContacts } from "../src/db/schema";
import { BOT, harness, OWNER, testEnv } from "./helpers";

const ALICE = "+12015550001";
const BOB = "+12015550002";
const FRIEND = "+12015550009";
const HOUR = 60 * 60 * 1000;

const shared = () => harness({ env: { WA_COEXISTENCE: "1" } });

describe("coexistence: owner and bot on one number", () => {
  it("refuses a config where the owner number is the bot number", () => {
    expect(() => loadConfig({ ...testEnv, OWNER_NUMBERS: BOT } as unknown as NodeJS.ProcessEnv)).toThrow(/personal number/);
  });

  it("pauses the bot for a customer the owner replies to in the app; RESUME turns it back on", async () => {
    const h = await shared();
    await h.db.insert(customers).values({ phone: ALICE, name: "Alice", area: "Heights" });
    await h.publishMenu();
    await h.say(ALICE, "hi");

    expect(await h.echo(ALICE, "Hi Alice, ji, sending your usual today?")).toEqual([]);
    const [row] = await h.db.select().from(messages).where(eq(messages.source, "app"));
    expect(row).toMatchObject({ phone: ALICE, direction: "out", body: "Hi Alice, ji, sending your usual today?" });

    const readBefore = h.wa.read.length;
    expect(await h.say(ALICE, "yes 2 dal")).toEqual([]);
    expect(h.wa.read.length).toBe(readBefore); // owner's app keeps the chat unread

    await h.say(OWNER, `RESUME ${ALICE}`);
    expect(h.texts(await h.say(ALICE, "2 dal"))).toContain("Total: $12.00");
  });

  it("ignores a repeated echo delivery and echoes to unknown numbers", async () => {
    const h = await shared();
    await h.echo(FRIEND, "see you tonight", "wamid.e1");
    await h.echo(FRIEND, "see you tonight", "wamid.e1");
    expect(await h.db.select().from(messages).where(eq(messages.source, "app"))).toHaveLength(1);
    expect(await h.db.select().from(customers)).toHaveLength(0);
  });

  it("stays silent for unknown numbers that don't ask to order, and onboards those that do", async () => {
    const h = await shared();
    await h.publishMenu();
    expect(await h.say(FRIEND, "Are you coming to the party?")).toEqual([]);
    const [m] = await h.db.select().from(messages).where(eq(messages.phone, FRIEND));
    expect(m!.intent).toBe("unknown_silent");
    expect(await h.db.select().from(customers)).toHaveLength(0);

    expect(h.texts(await h.say(BOB, "ORDER"))).toContain("What name should we put on your orders?");
  });

  it("still onboards any new number without coexistence", async () => {
    const h = await harness();
    expect(h.texts(await h.say(FRIEND, "Are you coming to the party?"))).toContain("What name");
  });

  it("stores history and contact sync without replying or routing", async () => {
    const h = await shared();
    const ts = String(Math.floor((h.clock.now.getTime() - 30 * 24 * HOUR) / 1000));
    const history = {
      history: [
        {
          metadata: { phase: 0, chunk_order: 1, progress: 100 },
          threads: [
            {
              id: ALICE.slice(1),
              messages: [
                { id: "wamid.h1", from: ALICE.slice(1), timestamp: ts, type: "text", text: { body: "2 roti and dal please" } },
                { id: "wamid.h2", from: BOT.slice(1), to: ALICE.slice(1), timestamp: ts, type: "text", text: { body: "ok ji" } },
              ],
            },
          ],
        },
      ],
    };
    expect(await h.postChange("history", history)).toEqual([]);
    expect(await h.postChange("history", history)).toEqual([]);
    const rows = await h.db.select().from(messages).where(eq(messages.source, "history"));
    expect(rows.map((r) => [r.phone, r.direction]).sort()).toEqual([
      [ALICE, "in"],
      [ALICE, "out"],
    ]);

    await h.postChange("smb_app_state_sync", {
      state_sync: [
        { type: "contact", action: "add", contact: { full_name: "Alice Rao", phone_number: ALICE.slice(1) } },
        { type: "contact", action: "add", contact: { full_name: "Plumber", phone_number: FRIEND.slice(1) } },
        { type: "contact", action: "remove", contact: { phone_number: FRIEND.slice(1) } },
      ],
    });
    expect(await h.db.select().from(waContacts)).toEqual([expect.objectContaining({ phone: ALICE, name: "Alice Rao" })]);
    expect(await h.db.select().from(customers)).toHaveLength(0);
  });

  it("ignores webhook fields it doesn't know", async () => {
    const h = await shared();
    const out = await h.postChange("account_update", { messages: [{ id: "x", from: ALICE.slice(1), type: "text", text: { body: "hi" } }] });
    expect(out).toEqual([]);
    expect(await h.db.select().from(messages)).toHaveLength(0);
  });
});

describe("coexistence: menu push instead of broadcast lists", () => {
  async function setup() {
    const h = await shared();
    await h.db.insert(customers).values([
      { phone: ALICE, name: "Alice Rao", area: "Heights", menuOptIn: true },
      { phone: BOB, name: "Bob", area: "Newport", menuOptIn: true },
      { phone: FRIEND, name: "Not asked", area: "Newport" },
    ]);
    // Alice wrote this morning (window open); Bob last wrote two days ago.
    await h.say(ALICE, "thanks");
    return h;
  }

  it("offers a push on publish, then sends the menu in-window and the template outside it, once", async () => {
    const h = await setup();
    const pub = await h.publishMenu();
    expect(h.texts(pub)).toContain("Send the menu to 2 customers");
    expect(h.texts(pub)).toContain(`https://wa.me/${BOT.slice(1)}?text=ORDER`);
    const push = h.buttonsOf(pub).find((b) => b.id.startsWith("menu_push:"))!;

    const out = await h.say(OWNER, { replyId: push.id });
    const alice = out.find((o) => o.to === ALICE)!;
    const bob = out.find((o) => o.to === BOB)!;
    expect(alice.kind).toBe("text");
    expect(alice.body).toContain("Dal Makhani");
    expect(bob).toMatchObject({ kind: "template", name: "daily_order_open", params: ["Bob", expect.any(String), "10:30 AM"] });
    expect(out.find((o) => o.to === FRIEND)).toBeUndefined();
    const report = out.find((o) => o.to === OWNER)!.body;
    expect(report).toContain("Sent to 2 customers (1 in chat, 1 as");
    expect(report).toContain("1 customer hasn't asked for it yet");

    const again = await h.say(OWNER, { replyId: push.id });
    expect(again.filter((o) => o.to !== OWNER)).toEqual([]);
    expect(h.texts(again)).toContain("Already sent");
  });

  it("template See menu opens the chat with the menu; Skip today just acknowledges", async () => {
    const h = await setup();
    const pub = await h.publishMenu();
    await h.say(OWNER, { replyId: h.buttonsOf(pub).find((b) => b.id.startsWith("menu_push:"))!.id });
    const bob = h.wa.sent.find((o) => o.to === BOB && o.kind === "template")!;
    if (bob.kind !== "template") throw new Error("expected template");

    expect(h.texts(await h.say(BOB, { templateButton: bob.buttons[0]!, title: "See menu" }))).toContain("Dal Makhani");
    expect(h.texts(await h.say(BOB, { templateButton: bob.buttons[1]!, title: "Skip today" }))).toContain("See you next time");
  });

  it("STOP opts out, START opts back in; OPTIN ALL skips customers who said no", async () => {
    const h = await setup();
    expect(h.texts(await h.say(ALICE, "STOP"))).toContain("no more daily messages");
    expect((await h.db.select().from(customers).where(eq(customers.phone, ALICE)))[0]!.menuOptIn).toBe(false);

    expect(h.texts(await h.say(OWNER, "OPTIN ALL"))).toContain("1 customer will get");
    expect((await h.db.select().from(customers).where(eq(customers.phone, FRIEND)))[0]!.menuOptIn).toBe(true);
    expect((await h.db.select().from(customers).where(eq(customers.phone, ALICE)))[0]!.menuOptIn).toBe(false);

    expect(h.texts(await h.say(ALICE, "start"))).toContain("back on");
    expect((await h.db.select().from(customers).where(eq(customers.phone, ALICE)))[0]!.menuOptIn).toBe(true);
  });

  it("asks a customer once, after their first confirmed order", async () => {
    const h = await shared();
    await h.publishMenu();
    await h.onboard(ALICE, "Alice");
    const summary = await h.say(ALICE, "2 dal");
    const confirm = h.buttonsOf(summary).find((b) => b.id.startsWith("confirm:"))!;
    const done = await h.say(ALICE, { replyId: confirm.id });
    expect(h.texts(done)).toContain("each day when ordering opens");
    expect(h.texts(await h.say(ALICE, { replyId: "optin_yes" }))).toContain("We'll message you");
    expect((await h.db.select().from(customers).where(eq(customers.phone, ALICE)))[0]!.menuOptIn).toBe(true);

    const again = await h.say(ALICE, "1 roti");
    const done2 = await h.say(ALICE, { replyId: h.buttonsOf(again).find((b) => b.id.startsWith("confirm:"))!.id });
    expect(h.texts(done2)).not.toContain("each day when ordering opens");
  });
});
