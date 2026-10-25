import { describe, expect, it } from "vitest";
import { customers } from "../src/db/schema";
import { LINK_TTL_MS, signViewerToken, verifyViewerToken } from "../src/admin/auth";
import { esc } from "../src/admin/routes";
import { WaSendError } from "../src/wa/client";
import { harness, OWNER } from "./helpers";

const ALICE = "+12015550001";
const BOB = "+12015550002";

type H = Awaited<ReturnType<typeof harness>>;

/** Owner sends CHATS, opens the link; returns the session cookie. */
async function login(h: H, arg = "") {
  const out = await h.say(OWNER, `CHATS ${arg}`.trim());
  const link = out[0]!.body.match(/https:\/\/preppr\.test(\/admin\?\S+)/)![1]!;
  const res = await h.app.request(link);
  expect(res.status).toBe(302);
  const cookie = res.headers.get("set-cookie")!;
  expect(cookie).toMatch(/HttpOnly/i);
  expect(cookie).toMatch(/Secure/i);
  return { cookie: cookie.split(";")[0]!, location: res.headers.get("location")! };
}
const get = (h: H, path: string, cookie?: string) => h.app.request(path, { headers: cookie ? { cookie } : {} });

describe("viewer tokens", () => {
  it("verifies, expires, and rejects tampering", () => {
    const now = new Date("2026-10-19T12:00:00Z");
    const t = signViewerToken("s", OWNER, now);
    expect(verifyViewerToken("s", t, now)).toBe(OWNER);
    expect(verifyViewerToken("s", t, new Date(now.getTime() + LINK_TTL_MS + 1))).toBeNull();
    expect(verifyViewerToken("other", t, now)).toBeNull();
    const [w, e, s] = t.split(".");
    expect(verifyViewerToken("s", `${w}.${Number(e) + 1}.${s}`, now)).toBeNull();
    expect(verifyViewerToken("s", undefined, now)).toBeNull();
  });

  it("escapes HTML", () => {
    expect(esc(`<script>"x"&'`)).toBe("&lt;script&gt;&quot;x&quot;&amp;&#39;");
  });
});

describe("chat viewer", () => {
  it("needs a valid link, then lists the day's conversations with flags", async () => {
    const h = await harness();
    await h.publishMenu();
    await h.db.insert(customers).values([{ phone: ALICE, name: "Alice" }, { phone: BOB, name: "<b>Bob</b>" }]);
    const s = await h.say(ALICE, "2 dal, 3 roti");
    await h.say(ALICE, { replyId: h.buttonsOf(s).find((b) => b.id.startsWith("confirm:"))!.id });
    await h.say(BOB, "1 paneer (extra spicy)"); // needs the model
    await h.say(BOB, "can I talk to aunty");

    expect((await get(h, "/admin")).status).toBe(401);
    expect((await get(h, "/admin?t=bogus")).status).toBe(401);

    const { cookie } = await login(h);
    const res = await get(h, "/admin", cookie);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const html = await res.text();
    expect(html).toContain("Alice");
    expect(html).toContain("confirmed · $15.00");
    expect(html).toContain("&lt;b&gt;Bob&lt;/b&gt;");
    expect(html).not.toContain("<b>Bob</b>");
    expect(html).toContain("Asked for you");
    expect(html).toContain("Read by AI");
    expect(html).toContain("Needs a look (1)");
    expect(html).not.toContain(OWNER); // owner's own chat isn't listed

    const look = await (await get(h, "/admin?f=look", cookie)).text();
    expect(look).toContain("Bob");
    expect(look).not.toContain(">Alice<");
    const search = await (await get(h, "/admin?q=0001", cookie)).text();
    expect(search).toContain("Alice");
    expect(search).not.toContain("Bob");
  });

  it("shows a transcript with delivery status, and CHATS <number> links straight to it", async () => {
    const h = await harness();
    await h.publishMenu();
    await h.db.insert(customers).values({ phone: ALICE, name: "Alice" });
    await h.say(ALICE, "2 dal, 3 roti");
    h.wa.failNext(1, new WaSendError("Graph API 400: recipient not on WhatsApp", 400, 131026, false));
    await h.say(ALICE, "thanks");

    const { cookie, location } = await login(h, ALICE);
    expect(location).toBe(`/admin/c/${encodeURIComponent(ALICE)}`);
    const html = await (await get(h, location, cookie)).text();
    expect(html).toContain("2 dal, 3 roti");
    expect(html).toContain("Total: $15.00");
    expect(html).toContain("<span>Confirm ✅</span>");
    expect(html).toContain("✓ sent");
    expect(html).toContain("⚠ not delivered: Graph API 400: recipient not on WhatsApp");
    expect(html).toContain("Open in WhatsApp");
    expect(html).toContain("All paid up");
  });

  it("says so when the viewer isn't configured", async () => {
    const h = await harness();
    h.cfg.publicUrl = undefined;
    expect(h.texts(await h.say(OWNER, "CHATS"))).toContain("isn't set up");
  });
});

describe("owner shares contacts", () => {
  it("adds them as known customers who skip sign-up", async () => {
    const h = await harness();
    await h.publishMenu();
    const p = h.payload(OWNER, "x") as any;
    const m = p.entry[0].changes[0].value.messages[0];
    delete m.text;
    m.type = "contacts";
    m.contacts = [
      { name: { formatted_name: "Alice A" }, phones: [{ phone: "+1 (201) 555-0001", wa_id: "12015550001" }] },
      { name: { first_name: "Bob" }, phones: [{ phone: "201 555 0002" }, { phone: "12" }] },
    ];
    await h.post(p);
    await h.drain();
    expect(h.wa.sent.at(-1)!.body).toMatch(/Added 2 customers.*1 number\(s\) unreadable/);
    expect(h.texts(await h.say(BOB, "2 dal"))).toContain("Total: $12.00");
  });

  it("tells a customer who sends a contact card to type instead", async () => {
    const h = await harness();
    await h.publishMenu();
    await h.db.insert(customers).values({ phone: ALICE, name: "Alice" });
    const p = h.payload(ALICE, "x") as any;
    const m = p.entry[0].changes[0].value.messages[0];
    delete m.text;
    m.type = "contacts";
    m.contacts = [{ name: { formatted_name: "Someone" }, phones: [{ phone: "2015559999" }] }];
    await h.post(p);
    await h.drain();
    expect(h.wa.sent.find((o) => o.to === ALICE)!.body).toContain("Please type");
  });
});
