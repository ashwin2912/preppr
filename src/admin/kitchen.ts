import type { Context, Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { formatInTimeZone } from "date-fns-tz";
import type { Deps } from "../flows/router";
import { formResponses, menus, products, type FormResponse, type Menu, type Product, type ProductSize } from "../db/schema";
import { prepTotals } from "../domain/formOrders";
import { formatFormBroadcast } from "../domain/menu";
import { money } from "../domain/order";
import { formatSizes, isUnitLabel, menuItemsFromPicks, nameKey, shortMoney, type MenuPick } from "../domain/products";
import { activeProducts, getFormLink, setFormLink } from "../flows/catalog";
import { formWebhookPath, responsesFor } from "../flows/formOrders";
import { upsertMenu } from "../flows/menuDraft";
import { formatDay, localDate, zonedInstant } from "../lib/time";
import { esc, page } from "./html";

const SIZE_ROWS = 6;
const BASE = "/admin/kitchen";

const KITCHEN_CSS = `
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px;margin:12px 0}
.card h2{font-size:16px;margin:0 0 10px}
label{display:block;font-size:13px;color:var(--muted);margin:8px 0 3px}
input[type=text],input[type=url],input[type=time],select,textarea{width:100%;padding:9px 10px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--ink);font:inherit}
textarea{min-height:90px;font-size:14px}
.sizes{display:grid;grid-template-columns:1fr 110px;gap:6px}
button,.btn{display:inline-block;border:0;border-radius:8px;background:var(--accent);color:#fff;padding:9px 14px;font:inherit;font-weight:600;cursor:pointer;text-align:center}
button.ghost,.btn.ghost{background:var(--chip);color:var(--ink)}button.danger{background:var(--warn)}button.link{background:none;color:var(--muted);padding:0;font-weight:400;font-size:13px}
.big{display:block;width:100%;padding:14px;font-size:17px}
.list{margin:0;padding:0;list-style:none}.list li{display:flex;justify-content:space-between;align-items:baseline;gap:8px;padding:9px 0;border-top:1px solid var(--line)}
.list li:first-child{border-top:0}.num{color:var(--muted);min-width:1.6em;display:inline-block}
.pick{border-top:1px solid var(--line);padding:8px 0}.pick:first-of-type{border-top:0}.pick b{display:block;margin-bottom:4px}
.pick label{display:inline-flex;align-items:center;gap:6px;color:var(--ink);font-size:15px;margin:2px 14px 2px 0}
.row2{display:flex;gap:8px}.row2>*{flex:1}
.flash{background:var(--accent);color:#fff;border-radius:8px;padding:8px 12px;margin:12px 0}.flash.err{background:var(--warn)}
.copyrow{display:flex;justify-content:flex-end;margin-top:6px}
.tabs{display:flex;gap:6px;margin:12px 0 0}.tabs a{flex:1;text-align:center;padding:8px;border-radius:10px;background:var(--chip);color:var(--ink);font-weight:600}.tabs a.on{background:var(--accent);color:#fff}
.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:12px 0}
.stat{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:10px 12px}.stat b{display:block;font-size:22px}.stat span{color:var(--muted);font-size:12px}
.prep li b{font-size:17px}.off{opacity:.4;pointer-events:none}
details summary{cursor:pointer;font-weight:600}details[open] summary{margin-bottom:8px}
.order .who{font-weight:600}.order .what{color:var(--muted);font-size:14px}
.warnbox{border-left:4px solid var(--warn)}
.head{display:flex;justify-content:space-between;align-items:flex-start;gap:8px}.head h2{margin:0 0 2px}
.bar{position:sticky;bottom:0;display:flex;gap:8px;background:var(--card);padding:12px 0 4px;margin-top:8px;border-top:1px solid var(--line)}.bar>*{flex:1}
code{background:var(--chip);padding:2px 5px;border-radius:5px;font-size:13px;word-break:break-all}`;

const COPY_JS = `<script>document.addEventListener('click',e=>{const b=e.target.closest('[data-copy]');if(!b)return;const t=document.getElementById(b.dataset.copy);navigator.clipboard.writeText(t.value??t.textContent).then(()=>{const o=b.textContent;b.textContent='Copied ✓';setTimeout(()=>b.textContent=o,1500)})})</script>`;

type Viewer = (c: Context) => string | null;

/** Dollars typed in a form ("6", "$6.50") -> cents, or null. */
function dollars(s: string): number | null {
  const m = s.trim().match(/^\$?(\d{1,4}(?:\.\d{1,2})?)$/);
  if (!m) return null;
  const c = Math.round(Number(m[1]) * 100);
  return c > 0 && c < 100_000 ? c : null;
}

/** Product form fields -> clean product, or an error to show. */
export function productFromForm(f: Record<string, string>): { name: string; sizes: ProductSize[] } | { error: string } {
  const name = (f.name ?? "").trim().replace(/\s+/g, " ");
  if (!nameKey(name)) return { error: "Give the dish a name." };
  const sizes: ProductSize[] = [];
  for (let i = 0; i < SIZE_ROWS; i++) {
    const label = (f[`label_${i}`] ?? "").trim();
    const price = (f[`price_${i}`] ?? "").trim();
    if (!label && !price) continue;
    const cents = dollars(price);
    if (!cents) return { error: `Price for "${label || "row " + (i + 1)}" should be a number like 6 or 6.50.` };
    const l = label || "each";
    if (sizes.some((s) => s.label.toLowerCase() === l.toLowerCase())) return { error: `"${l}" is listed twice.` };
    sizes.push({ label: l, price_cents: cents });
  }
  if (!sizes.length) return { error: "Add at least one price (size can be left empty for a single price)." };
  return { name, sizes };
}

const tabs = (on: "today" | "products") =>
  `<nav class="tabs"><a class="${on === "today" ? "on" : ""}" href="${BASE}">Today</a><a class="${on === "products" ? "on" : ""}" href="${BASE}/products">Products</a></nav>`;

function productForm(p: { id?: number; name: string; sizes: ProductSize[] }, error?: string) {
  const rows = Array.from({ length: SIZE_ROWS }, (_, i) => {
    const s = p.sizes[i];
    const price = s?.price_cents ? (s.price_cents / 100).toFixed(s.price_cents % 100 ? 2 : 0) : "";
    return `<input type="text" name="label_${i}" value="${esc(s?.label ?? "")}" placeholder="${i === 0 ? "8oz, S, Half… (or leave empty)" : ""}" autocomplete="off">
<input type="text" name="price_${i}" value="${esc(price)}" placeholder="$" inputmode="decimal" autocomplete="off">`;
  }).join("");
  return `${tabs("products")}${error ? `<div class="flash err">${esc(error)}</div>` : ""}
<form class="card" method="post" action="${p.id ? `${BASE}/p/${p.id}` : `${BASE}/p`}"><h2>${p.id ? "Edit dish" : "Add a dish"}</h2>
<label>Dish name</label><input type="text" name="name" value="${esc(p.name)}" required autocomplete="off">
<label>Sizes and prices</label>
<div class="sizes"><span class="muted">Size / unit</span><span class="muted">Price</span>${rows}</div>
<p class="muted">One price, no sizes? Fill in only the price in the first row. Sizes like 8oz or 500ml are added up in the "What to make" list.</p>
<button type="submit">Save</button> <a class="btn ghost" href="${BASE}/products">Cancel</a></form>
${p.id ? `<form method="post" action="${BASE}/p/${p.id}/remove" onsubmit="return confirm('Remove this dish?')"><button class="danger" type="submit">Remove dish</button></form>` : ""}`;
}

function productsView(list: Product[]) {
  const items = list
    .map((p, i) => `<li><span><span class="num">${i + 1}.</span>${esc(p.name)}<br><span class="muted">${esc(formatSizes(p.sizes))}</span></span><a href="${BASE}/p/${p.id}">Edit</a></li>`)
    .join("");
  return `${tabs("products")}<div class="card"><h2>Everything you sell (${list.length})</h2>
${items ? `<ul class="list">${items}</ul>` : `<p class="muted">No dishes yet. Add the things you make, with their sizes and prices.</p>`}
<p><a class="btn" href="${BASE}/p/new">+ Add dish</a></p>
<p class="muted">The numbers work on WhatsApp too: <b>/menu 1,2,3</b>.</p></div>`;
}

function menuPicker(list: Product[], current: Menu | null) {
  const chosen = new Set((current?.items ?? []).map((i) => `${i.product_id}:${i.size}`));
  const picks = list
    .map(
      (p) => `<div class="pick"><b>${esc(p.name)}</b>${p.sizes
        .map(
          (s, j) =>
            `<label><input type="checkbox" name="s" value="${p.id}:${j}"${chosen.has(`${p.id}:${s.label}`) ? " checked" : ""}> ${esc(isUnitLabel(s.label) ? shortMoney(s.price_cents) + " " + s.label : `${s.label} ${shortMoney(s.price_cents)}`)}</label>`,
        )
        .join("")}</div>`,
    )
    .join("");
  return `<form class="card" method="post" action="${BASE}/menu"><h2>Today's menu</h2>
<p class="muted">Tick what you're making today.</p>
${picks}
<div class="bar"><a class="btn ghost" href="${BASE}">Cancel</a><button type="submit">Save menu</button></div></form>
<p class="muted">Something missing? <a href="${BASE}/p/new">Add a dish</a> first.</p>`;
}

function statsRow(orders: number, salesCents: number, off = false) {
  return `<div class="stats${off ? " off" : ""}"><div class="stat"><b>${off ? "—" : orders}</b><span>orders</span></div>
<div class="stat"><b>${off ? "—" : esc(money(salesCents))}</b><span>sales</span></div></div>`;
}

/** Top card: the day, what's on the menu, and Edit. */
function menuSummary(m: Menu, tz: string) {
  const names = [...new Set(m.items.map((i) => (i.size && i.name.endsWith(` ${i.size}`) ? i.name.slice(0, -i.size.length - 1) : i.name)))];
  return `<div class="card"><div class="head"><div><h2>${esc(formatDay(m.date, tz))}</h2>
<p class="muted">${m.items.length} item${m.items.length === 1 ? "" : "s"} on the menu</p></div><a class="btn ghost" href="${BASE}/menu">Edit</a></div>
<div>${names.map((n) => `<span class="chip">${esc(n)}</span>`).join("")}</div></div>`;
}

function prepCard(m: Menu, responses: FormResponse[]) {
  const rows = prepTotals(
    m.items,
    responses.flatMap((r) => r.lines),
  );
  const items = rows
    .map((r) => `<li><span>${esc(r.name)}${r.detail ? `<br><span class="muted">${esc(r.detail)}</span>` : ""}</span><b>${esc(r.amount)}</b></li>`)
    .join("");
  return `<div class="card prep"><h2>What to make</h2>${items ? `<ul class="list">${items}</ul>` : `<p class="muted">No orders yet. Totals show up here as orders come in.</p>`}</div>`;
}

/** The order form shows the published menu by itself: only the broadcast is left to do (and the link, once). */
function formSteps(m: Menu, link: string | null, deps: Deps) {
  return `<details class="card" open><summary>${link ? "Send today's broadcast" : "Set up your order form link (one time)"}</summary>
${link ? `<p class="muted">Your order form shows this menu now.</p>` : ""}
<label>Order form link${link ? "" : " (paste it once)"}</label>
<form method="post" action="${BASE}/link" class="row2"><input type="url" name="url" value="${esc(link ?? "")}" placeholder="https://whatsform.com/…"><button type="submit" style="flex:0">Save</button></form>
<label>Send this to your broadcast list</label>
<textarea id="bc" readonly rows="9">${esc(formatFormBroadcast(m, deps.cfg, link, false))}</textarea>
<div class="copyrow"><button type="button" class="ghost" data-copy="bc">Copy message</button></div></details>`;
}

function ordersCard(responses: FormResponse[], tz: string) {
  const items = responses
    .map((r) => {
      const who = r.name ?? r.customerPhone ?? "Someone";
      const what = r.lines.map((l) => `${l.qty}× ${l.name}`).join(", ") || "no dishes matched";
      const where = [r.area, r.address].filter(Boolean).join(" · ");
      return `<li class="order"><span><span class="who">${esc(who)}</span> <span class="muted">${esc(formatInTimeZone(r.createdAt, tz, "h:mm a"))}</span><br>
<span class="what">${esc(what)}</span>${where ? `<br><span class="muted">${esc(where)}</span>` : ""}${r.note ? `<br><span class="muted">📝 ${esc(r.note)}</span>` : ""}
${r.unmatched.length ? `<br><span class="chip warn">check: ${esc(r.unmatched.join("; "))}</span>` : ""}</span>
<span><b>${esc(money(r.totalCents))}</b><form method="post" action="${BASE}/o/${r.id}/cancel" onsubmit="return confirm('Remove this order?')"><button class="link" type="submit">remove</button></form></span></li>`;
    })
    .join("");
  return `<div class="card"><h2>Orders (${responses.length})</h2>${items ? `<ul class="list">${items}</ul>` : `<p class="muted">Orders from your WhatsForm show up here.</p>`}</div>`;
}

function connectCard(deps: Deps) {
  const url = `${deps.cfg.publicUrl ?? ""}${formWebhookPath(deps)}`;
  const script = `<script src="${deps.cfg.publicUrl ?? ""}/wf.js"></script>`;
  return `<details class="card"><summary>Connect WhatsForm (one time)</summary>
<p>One order form, used every day. It needs a <b>Text Input</b> question called <b>Your order</b> (required), plus name, phone and address.</p>
<p>1. <b>Settings → Integrations → Custom Script</b>: paste this, so the form shows today's menu:</p>
<p><code id="sc">${esc(script)}</code></p><div class="copyrow"><button type="button" class="ghost" data-copy="sc">Copy script</button></div>
<p>2. <b>Settings → Integrations → Webhook</b>, method <b>POST</b>: paste this, so orders show up here:</p>
<p><code id="wh">${esc(url)}</code></p><div class="copyrow"><button type="button" class="ghost" data-copy="wh">Copy URL</button></div>
<p class="muted">The webhook link is private: don't share it.</p></details>`;
}

/**
 * The owner's kitchen page. Today: menu first, then orders, sales, what to
 * make, and the WhatsForm steps. Products: everything she sells. Same sign-in
 * as the chat viewer (APP command link).
 */
export function registerKitchen(app: Hono, deps: Deps, viewer: Viewer, noStore: (c: Context) => void) {
  const tz = deps.cfg.tz;
  const kpage = (title: string, body: string) => page(title, `<h1>${esc(deps.cfg.kitchenName)}</h1>`, `<style>${KITCHEN_CSS}</style>${body}${COPY_JS}`);
  const denied = (c: Context) =>
    c.html(page("Link expired", "<h1>Kitchen</h1>", `<p class="empty">This link has expired or isn't valid.<br>Send <b>/app</b> to the assistant on WhatsApp for a new one.</p>`), 401);
  /**
   * Cookie is SameSite=Lax; also refuse form posts from another site. Browsers send
   * `Origin: null` when the page's referrer policy hides it, so fall back to Sec-Fetch-Site.
   */
  const sameOrigin = (c: Context) => {
    const site = c.req.header("sec-fetch-site");
    if (site) return site === "same-origin";
    const origin = c.req.header("origin");
    if (!origin || origin === "null") return true; // old browsers; the Lax cookie already blocks cross-site posts
    try {
      return new URL(origin).host === (c.req.header("host") ?? new URL(c.req.url).host);
    } catch {
      return false;
    }
  };
  const guard = (c: Context, post = false) => {
    noStore(c);
    // Pages here carry no token in the URL, so same-origin referrers are fine (and keep Origin real).
    c.header("Referrer-Policy", "same-origin");
    return viewer(c) && (!post || sameOrigin(c));
  };
  const form = async (c: Context) => {
    const body = await c.req.parseBody({ all: true });
    const one: Record<string, string> = {};
    const all: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(body)) {
      const vals = (Array.isArray(v) ? v : [v]).filter((x): x is string => typeof x === "string");
      all[k] = vals;
      one[k] = vals[0] ?? "";
    }
    return { one, all };
  };
  const flashOf = (c: Context) => {
    const ok = c.req.query("ok");
    const err = c.req.query("err");
    return ok ? `<div class="flash">${esc(ok)}</div>` : err ? `<div class="flash err">${esc(err)}</div>` : "";
  };
  const back = (c: Context, msg: string, err = false, to = BASE) => c.redirect(`${to}?${err ? "err" : "ok"}=${encodeURIComponent(msg)}`, 303);

  app.get(BASE, async (c) => {
    if (!guard(c)) return denied(c);
    const today = localDate(deps.now(), tz);
    const [m] = await deps.db.select().from(menus).where(eq(menus.date, today));

    if (!m) {
      const list = await activeProducts(deps.db);
      const start = list.length
        ? `<a class="btn big" href="${BASE}/menu">Create today's menu</a>`
        : `<p>First add the dishes you sell.</p><a class="btn big" href="${BASE}/p/new">Add your first dish</a>`;
      return c.html(
        kpage(
          "Today",
          `${tabs("today")}${flashOf(c)}<div class="card"><h2>${esc(formatDay(today, tz))}</h2><p class="muted">No menu for today yet.</p>${start}</div>
<div class="off">${statsRow(0, 0, true)}<div class="card prep"><h2>What to make</h2><p class="muted">Shows up once the menu is out.</p></div><div class="card"><h2>Orders</h2></div></div>`,
        ),
      );
    }

    const responses = await responsesFor(deps, m.id);
    const sales = responses.reduce((s, r) => s + r.totalCents, 0);
    const link = await getFormLink(deps.db);
    const unmatched = responses.filter((r) => r.unmatched.length || !r.lines.length).length;
    const warn = unmatched
      ? `<div class="card warnbox"><b>${unmatched} order${unmatched === 1 ? "" : "s"} need a look</b><p class="muted">Some answers didn't match today's menu, usually because a form question was renamed. Check them below and in your Google Sheet.</p></div>`
      : "";
    const body =
      tabs("today") +
      flashOf(c) +
      menuSummary(m, tz) +
      formSteps(m, link, deps) +
      statsRow(responses.length, sales) +
      warn +
      prepCard(m, responses) +
      ordersCard(responses, tz) +
      connectCard(deps);
    return c.html(kpage("Today", body));
  });

  app.get(`${BASE}/menu`, async (c) => {
    if (!guard(c)) return denied(c);
    const list = await activeProducts(deps.db);
    if (!list.length) return back(c, "Add your dishes first.", true, `${BASE}/products`);
    const [current] = await deps.db.select().from(menus).where(eq(menus.date, localDate(deps.now(), tz)));
    return c.html(kpage("Today's menu", flashOf(c) + menuPicker(list, current ?? null)));
  });

  app.get(`${BASE}/products`, async (c) => {
    if (!guard(c)) return denied(c);
    return c.html(kpage("Products", flashOf(c) + productsView(await activeProducts(deps.db))));
  });

  app.get(`${BASE}/p/new`, (c) => {
    if (!guard(c)) return denied(c);
    return c.html(kpage("Add dish", productForm({ name: "", sizes: [] })));
  });

  app.get(`${BASE}/p/:id`, async (c) => {
    if (!guard(c)) return denied(c);
    const [p] = await deps.db.select().from(products).where(and(eq(products.id, Number(c.req.param("id"))), eq(products.active, true)));
    if (!p) return back(c, "That dish doesn't exist any more.", true, `${BASE}/products`);
    return c.html(kpage(p.name, productForm(p)));
  });

  // Create, or update when :id is given. Names are unique; a removed dish with the same name comes back.
  const save = async (c: Context, id: number | null) => {
    if (!guard(c, true)) return denied(c);
    const { one } = await form(c);
    const parsed = productFromForm(one);
    const shown = { ...(id ? { id } : {}), name: one.name ?? "" };
    if ("error" in parsed) return c.html(kpage("Dish", productForm({ ...shown, sizes: sizesEcho(one) }, parsed.error)), 400);
    const key = nameKey(parsed.name);
    const now = deps.now();
    const [same] = await deps.db.select().from(products).where(eq(products.nameKey, key));
    if (same && same.id !== id && (same.active || id)) {
      return c.html(kpage("Dish", productForm({ ...shown, sizes: parsed.sizes }, `You already have a dish called ${same.name}.`)), 400);
    }
    if (id) {
      await deps.db.update(products).set({ name: parsed.name, nameKey: key, sizes: parsed.sizes, updatedAt: now }).where(eq(products.id, id));
    } else {
      await deps.db
        .insert(products)
        .values({ name: parsed.name, nameKey: key, sizes: parsed.sizes, aliases: [], createdAt: now, updatedAt: now })
        .onConflictDoUpdate({ target: products.nameKey, set: { name: parsed.name, sizes: parsed.sizes, active: true, updatedAt: now } });
    }
    return back(c, `Saved ${parsed.name} ✓`, false, `${BASE}/products`);
  };
  app.post(`${BASE}/p`, (c) => save(c, null));
  app.post(`${BASE}/p/:id`, (c) => save(c, Number(c.req.param("id"))));

  app.post(`${BASE}/p/:id/remove`, async (c) => {
    if (!guard(c, true)) return denied(c);
    const [p] = await deps.db.update(products).set({ active: false, updatedAt: deps.now() }).where(eq(products.id, Number(c.req.param("id")))).returning();
    return back(c, p ? `Removed ${p.name}.` : "That dish doesn't exist any more.", !p, `${BASE}/products`);
  });

  // Today's menu from ticked sizes. No cutoff in the page: WhatsForm takes orders, so it runs to end of day.
  app.post(`${BASE}/menu`, async (c) => {
    if (!guard(c, true)) return denied(c);
    const { all } = await form(c);
    const list = await activeProducts(deps.db);
    const chosen = new Set(all.s ?? []);
    const picks: MenuPick[] = list
      .map((product) => ({ product, sizes: product.sizes.filter((_, j) => chosen.has(`${product.id}:${j}`)) }))
      .filter((p) => p.sizes.length);
    if (!picks.length) return back(c, "Tick at least one dish.", true, `${BASE}/menu`);
    const date = localDate(deps.now(), tz);
    const cutoffAt = zonedInstant(date, "23:59", tz);
    const r = await upsertMenu(deps.db, { date, cutoffAt, items: menuItemsFromPicks(picks), cutoffWasDefault: false }, "active", deps.now());
    if ("blockedBy" in r) return back(c, `Today's menu already has ${r.blockedBy} order(s), so it can't be replaced.`, true);
    return back(c, "Menu saved ✓");
  });

  app.post(`${BASE}/link`, async (c) => {
    if (!guard(c, true)) return denied(c);
    const { one } = await form(c);
    const url = (one.url ?? "").trim();
    if (url && !/^https?:\/\/\S+$/.test(url)) return back(c, "That doesn't look like a link.", true);
    await setFormLink(deps.db, url, deps.now());
    return back(c, url ? "Link saved: it's in the broadcast message now." : "Link cleared.");
  });

  app.post(`${BASE}/o/:id/cancel`, async (c) => {
    if (!guard(c, true)) return denied(c);
    await deps.db.update(formResponses).set({ status: "cancelled" }).where(eq(formResponses.id, Number(c.req.param("id"))));
    return back(c, "Order removed.");
  });
}

function sizesEcho(f: Record<string, string>): ProductSize[] {
  const out: ProductSize[] = [];
  for (let i = 0; i < SIZE_ROWS; i++) {
    const label = f[`label_${i}`] ?? "";
    const cents = dollars(f[`price_${i}`] ?? "");
    if (label || cents) out.push({ label, price_cents: cents ?? 0 });
  }
  return out;
}
