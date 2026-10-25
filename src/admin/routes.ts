import type { Context, Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { formatInTimeZone } from "date-fns-tz";
import type { Deps } from "../flows/router";
import { money, shortLines } from "../domain/order";
import { methodLabel } from "../domain/ledger";
import { balanceText } from "../flows/payments";
import { normalizePhone, waLink } from "../lib/phone";
import { addDays, formatDay, localDate } from "../lib/time";
import { LINK_TTL_MS, verifyViewerToken } from "./auth";
import { FLAG_LABEL, listConversations, needsLook, transcript, type Bubble, type ConversationRow } from "./queries";

const COOKIE = "preppr_admin";

export const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

const CSS = `
:root{--bg:#f6f5f2;--card:#fff;--ink:#1d1d1b;--muted:#6b6a66;--line:#e4e2dc;--in:#fff;--out:#dcf3e0;--accent:#1f7a4d;--warn:#b4441f;--chip:#efede7}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--card:#1e1e1c;--ink:#ecebe6;--muted:#a3a29c;--line:#33322f;--in:#262624;--out:#1f3a2a;--accent:#5cc98d;--warn:#f08a65;--chip:#2c2b28}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.4 -apple-system,system-ui,Segoe UI,Roboto,sans-serif}
header{position:sticky;top:0;background:var(--card);border-bottom:1px solid var(--line);padding:12px 16px;display:flex;gap:12px;align-items:center;flex-wrap:wrap;z-index:1}
header h1{font-size:17px;margin:0;flex:1}a{color:var(--accent);text-decoration:none}
main{max-width:760px;margin:0 auto;padding:12px 16px 48px}
.tabs a{padding:4px 10px;border-radius:99px;background:var(--chip);color:var(--ink);font-size:13px}.tabs a.on{background:var(--accent);color:#fff}
form.search{display:flex;gap:6px;margin:10px 0}form.search input{flex:1;padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--ink);font-size:15px}
.row{display:block;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 12px;margin:8px 0;color:var(--ink)}
.row .top{display:flex;justify-content:space-between;gap:8px}.row .name{font-weight:600}.muted{color:var(--muted);font-size:13px}
.snip{color:var(--muted);font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.chip{display:inline-block;font-size:12px;padding:1px 8px;border-radius:99px;background:var(--chip);margin:4px 4px 0 0}
.chip.warn{background:var(--warn);color:#fff}.chip.ok{background:var(--accent);color:#fff}
.side{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 12px;margin:10px 0}
.side h3{margin:0 0 6px;font-size:14px}.side p{margin:2px 0}
.day{text-align:center;color:var(--muted);font-size:12px;margin:16px 0 6px}
.b{max-width:85%;padding:7px 10px;border-radius:10px;margin:4px 0;white-space:pre-wrap;word-wrap:break-word;border:1px solid var(--line)}
.b.in{background:var(--in);margin-right:auto}.b.out{background:var(--out);margin-left:auto}
.meta{font-size:11px;color:var(--muted);margin-top:3px;display:flex;gap:6px;justify-content:flex-end}
.btns{margin-top:4px}.btns span{display:inline-block;border:1px solid var(--accent);color:var(--accent);border-radius:6px;padding:1px 6px;font-size:12px;margin:2px 4px 0 0}
.empty{color:var(--muted);text-align:center;padding:40px 0}`;

function page(title: string, header: string, body: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(title)}</title><style>${CSS}</style></head>
<body><header>${header}</header><main>${body}</main></body></html>`;
}

function deny(c: Context) {
  return c.html(
    page("Link expired", "<h1>Preppr chats</h1>", `<p class="empty">This link has expired or isn't valid.<br>Send <b>CHATS</b> to the bot for a new one.</p>`),
    401,
  );
}

const MEDIA_LABEL: Record<string, string> = {
  audio: "🎤 voice note",
  voice: "🎤 voice note",
  image: "🖼 photo",
  video: "🎞 video",
  document: "📄 document",
  sticker: "sticker",
  contacts: "👤 contact card",
  location: "📍 location",
};

function orderChip(r: { status: string; totalCents: number } | null) {
  if (!r) return `<span class="chip">no order</span>`;
  const cls = r.status === "confirmed" ? "ok" : "";
  return `<span class="chip ${cls}">${esc(r.status)} · ${money(r.totalCents)}</span>`;
}

function listView(rows: ConversationRow[], date: string, f: string, q: string, tz: string) {
  const qs = (o: Record<string, string>) => `/admin?${new URLSearchParams({ date, ...(f ? { f } : {}), ...(q ? { q } : {}), ...o })}`;
  const items = rows
    .map((r) => {
      const name = r.customer?.name ?? r.phone;
      const flags = r.flags.map((fl) => `<span class="chip ${fl === "model" ? "" : "warn"}">${esc(FLAG_LABEL[fl])}</span>`).join("");
      return `<a class="row" href="/admin/c/${encodeURIComponent(r.phone)}">
<div class="top"><span class="name">${esc(name)}</span><span class="muted">${esc(formatInTimeZone(r.lastAt, tz, "h:mm a"))}</span></div>
<div class="muted">${esc(r.customer?.area ?? "No area")} · ${r.inCount} message${r.inCount === 1 ? "" : "s"}</div>
<div class="snip">${esc(r.lastText ?? "")}</div>
<div>${orderChip(r.order)}${flags}</div></a>`;
    })
    .join("");
  const look = rows.filter(needsLook).length;
  return `<div class="tabs">
<a class="${f ? "" : "on"}" href="${esc(qs({ f: "" }))}">All (${rows.length})</a>
<a class="${f === "look" ? "on" : ""}" href="${esc(qs({ f: "look" }))}">Needs a look (${look})</a></div>
<form class="search" method="get" action="/admin"><input type="hidden" name="date" value="${esc(date)}">${f ? `<input type="hidden" name="f" value="${esc(f)}">` : ""}
<input name="q" value="${esc(q)}" placeholder="Search name or number" autocomplete="off"></form>
${items || `<p class="empty">No conversations${q || f ? " match" : ` on ${esc(formatDay(date, tz))}`}.</p>`}`;
}

function bubbleView(b: Bubble, tz: string) {
  const time = esc(formatInTimeZone(b.at, tz, "h:mm a"));
  if (b.dir === "in") {
    const text = b.text ? esc(b.text) : `<i>${esc(MEDIA_LABEL[b.type] ?? b.type)}</i>`;
    const tags = [b.intent ? esc(b.intent) : "", b.parser === "model" ? "read by AI" : ""].filter(Boolean).join(" · ");
    return `<div class="b in">${text}<div class="meta">${tags ? `<span>${tags}</span>` : ""}<span>${time}</span></div></div>`;
  }
  const m = b.msg;
  const extra =
    m.kind === "buttons"
      ? `<div class="btns">${m.buttons.map((x) => `<span>${esc(x.title)}</span>`).join("")}</div>`
      : m.kind === "list"
        ? `<div class="btns">${m.rows.map((x) => `<span>${esc(x.title)}</span>`).join("")}</div>`
        : "";
  const state =
    b.queue === "failed" || b.delivery === "failed"
      ? `<span style="color:var(--warn)">⚠ not delivered${b.error ? `: ${esc(b.error)}` : ""}</span>`
      : b.queue !== "done"
        ? "⏳ sending"
        : b.delivery === "read"
          ? `<span style="color:var(--accent)">✓✓ read</span>`
          : b.delivery === "delivered"
            ? "✓✓ delivered"
            : "✓ sent";
  return `<div class="b out">${esc(m.body)}${extra}<div class="meta"><span>${state}</span><span>${time}</span></div></div>`;
}

export function registerAdmin(app: Hono, deps: Deps) {
  const secret = deps.cfg.adminSecret;
  const tz = deps.cfg.tz;

  /** The signed-in owner, or null. */
  const viewer = (c: Context) => {
    if (!secret) return null;
    const owner = verifyViewerToken(secret, getCookie(c, COOKIE), deps.now());
    return owner && deps.cfg.ownerNumbers.includes(owner) ? owner : null;
  };
  const noStore = (c: Context) => {
    c.header("Cache-Control", "no-store");
    c.header("X-Robots-Tag", "noindex");
    c.header("Referrer-Policy", "no-referrer");
  };

  app.get("/admin", async (c) => {
    noStore(c);
    const t = c.req.query("t");
    if (t) {
      // Link from the CHATS command: swap the token into a cookie and drop it from the URL.
      if (!secret || !verifyViewerToken(secret, t, deps.now())) return deny(c);
      setCookie(c, COOKIE, t, { httpOnly: true, secure: true, sameSite: "Lax", path: "/admin", maxAge: LINK_TTL_MS / 1000 });
      const next = c.req.query("next");
      return c.redirect(next?.startsWith("/admin") && !next.startsWith("//") ? next : "/admin", 302);
    }
    if (!viewer(c)) return deny(c);

    const today = localDate(deps.now(), tz);
    const d = c.req.query("date");
    const date = d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : today;
    const f = c.req.query("f") === "look" ? "look" : "";
    const q = (c.req.query("q") ?? "").trim().toLowerCase();
    let rows = await listConversations(deps.db, date, tz, deps.cfg.ownerNumbers);
    if (f) rows = rows.filter(needsLook);
    const digits = q.replace(/\D/g, "");
    if (q)
      rows = rows.filter(
        (r) => (digits && r.phone.replace(/\D/g, "").includes(digits)) || (r.customer?.name ?? "").toLowerCase().includes(q),
      );
    const nav = `<a href="/admin?date=${addDays(date, -1)}">‹</a><h1>${esc(formatDay(date, tz))}</h1>${date < today ? `<a href="/admin?date=${addDays(date, 1)}">›</a>` : ""}`;
    return c.html(page(`Chats ${date}`, nav, listView(rows, date, f, q, tz)));
  });

  app.get("/admin/c/:phone", async (c) => {
    noStore(c);
    if (!viewer(c)) return deny(c);
    const phone = normalizePhone(c.req.param("phone"));
    if (!phone) return c.html(page("Not found", `<a href="/admin">‹ Chats</a>`, `<p class="empty">Unknown number.</p>`), 404);
    const days = Math.min(Math.max(Number(c.req.query("days")) || 7, 1), 90);
    const t = await transcript(deps.db, phone, deps.now(), days);
    const name = t.customer?.name ?? phone;

    let lastDay = "";
    const bubbles = t.bubbles
      .map((b) => {
        const day = localDate(b.at, tz);
        const sep = day !== lastDay ? `<div class="day">${esc(formatDay(day, tz))}</div>` : "";
        lastDay = day;
        return sep + bubbleView(b, tz);
      })
      .join("");
    const c0 = t.customer;
    const paused = c0?.humanTakeoverUntil && c0.humanTakeoverUntil > deps.now();
    const side = `<div class="side"><h3>${esc(name)}</h3>
<p class="muted">${esc(phone)} · ${esc(c0?.area ?? "No area")}${c0?.status === "blocked" ? " · <b>blocked</b>" : ""}${paused ? " · <b>bot paused</b>" : ""}</p>
${c0?.addressNote ? `<p>📍 ${esc(c0.addressNote)}</p>` : ""}${c0?.notes ? `<p>📝 ${esc(c0.notes)}</p>` : ""}
<p>${esc(balanceText(t.balance))}</p>
${t.recentOrders.map((o) => `<p class="muted">${esc(formatDay(o.date, tz))}: ${esc(shortLines(o.order.lines))} — ${money(o.order.totalCents)} (${esc(o.order.status)})</p>`).join("")}
${t.payments.map((p) => `<p class="muted">#${p.id} ${money(p.amountCents)} ${esc(methodLabel(p.method))} — ${esc(p.status === "pending" ? "to verify" : p.status)}</p>`).join("")}
<p><a href="${esc(waLink(phone))}">Open in WhatsApp ↗</a></p></div>`;
    const more = days < 90 ? `<p class="muted" style="text-align:center"><a href="?days=${Math.min(days * 4, 90)}">Show older messages</a></p>` : "";
    return c.html(
      page(name, `<a href="/admin">‹ Chats</a><h1>${esc(name)}</h1>`, side + more + (bubbles || `<p class="empty">No messages in the last ${days} days.</p>`)),
    );
  });
}
