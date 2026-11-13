import type { Context, Hono } from "hono";
import { and, count, desc, eq, isNull, max } from "drizzle-orm";
import { formatInTimeZone } from "date-fns-tz";
import type { Deps } from "../flows/router";
import { customerDevices, customers, menus, orders, products, type Customer, type Menu, type Product, type ProductSize } from "../db/schema";
import { importCustomers, parseContactsVcf, parseCustomersCsv, type ImportReport } from "../domain/importCustomers";
import { prepTotals } from "../domain/formOrders";
import { formatFormBroadcast } from "../domain/menu";
import { money } from "../domain/order";
import { formatSizes, isUnitLabel, menuItemsFromPicks, nameKey, shortMoney, type MenuPick } from "../domain/products";
import { activeProducts, orderLink, setFormLink } from "../flows/catalog";
import { cancelDayOrder, dayOrders, trustDayOrder, type DayOrder } from "../flows/dayOrders";
import { formWebhookPath } from "../flows/formOrders";
import { blockedText, upsertMenu } from "../flows/menuDraft";
import { formatDay, localDate, zonedInstant } from "../lib/time";
import { esc, page } from "./html";
import { readForm, sameOrigin } from "./http";

const SIZE_ROWS = 6;
const IMPORT_MAX_BYTES = 1_000_000;
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

const tabs = (on: "today" | "products" | "customers") =>
  `<nav class="tabs"><a class="${on === "today" ? "on" : ""}" href="${BASE}">Today</a><a class="${on === "products" ? "on" : ""}" href="${BASE}/products">Products</a><a class="${on === "customers" ? "on" : ""}" href="${BASE}/customers">Customers</a></nav>`;

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

function prepCard(m: Menu, list: DayOrder[]) {
  const rows = prepTotals(
    m.items,
    list.flatMap((r) => r.lines),
  );
  const items = rows
    .map((r) => `<li><span>${esc(r.name)}${r.detail ? `<br><span class="muted">${esc(r.detail)}</span>` : ""}</span><b>${esc(r.amount)}</b></li>`)
    .join("");
  return `<div class="card prep"><h2>What to make</h2>${items ? `<ul class="list">${items}</ul>` : `<p class="muted">No orders yet. Totals show up here as orders come in.</p>`}</div>`;
}

/** The order form/page shows the published menu by itself: only the broadcast is left to do (and, for WhatsForm, the link once). */
function formSteps(m: Menu, link: string | null, deps: Deps) {
  const page = deps.cfg.orderChannel === "page";
  const linkRow = page
    ? `<label>Your order page</label><p><code id="ol">${esc(link ?? "set PUBLIC_URL")}</code></p><div class="copyrow"><button type="button" class="ghost" data-copy="ol">Copy link</button></div>`
    : `<label>Order form link${link ? "" : " (paste it once)"}</label>
<form method="post" action="${BASE}/link" class="row2"><input type="url" name="url" value="${esc(link ?? "")}" placeholder="https://whatsform.com/…"><button type="submit" style="flex:0">Save</button></form>`;
  return `<details class="card" open><summary>${link ? "Send today's broadcast" : "Set up your order form link (one time)"}</summary>
${link ? `<p class="muted">Your order ${page ? "page" : "form"} shows this menu now.</p>` : ""}
${linkRow}
<label>Send this to your broadcast list</label>
<textarea id="bc" readonly rows="9">${esc(formatFormBroadcast(m, deps.cfg, link, false))}</textarea>
<div class="copyrow"><button type="button" class="ghost" data-copy="bc">Copy message</button></div></details>`;
}

const SOURCE_LABEL: Record<DayOrder["source"], string> = { page: "order page", form: "WhatsForm", bot: "chat" };

function ordersCard(list: DayOrder[], tz: string) {
  const items = list
    .map((r) => {
      const who = r.name ?? r.phone ?? "Someone";
      const what = r.lines.map((l) => `${l.qty}× ${l.name}`).join(", ") || "no dishes";
      const where = [r.area, r.address].filter(Boolean).join(" · ");
      const trust = r.canTrust
        ? `<form method="post" action="${BASE}/o/${esc(r.key)}/trust"><button class="link" type="submit">it's them ✓</button></form>`
        : "";
      return `<li class="order"><span><span class="who">${esc(who)}</span> <span class="muted">${esc(formatInTimeZone(r.createdAt, tz, "h:mm a"))} · ${SOURCE_LABEL[r.source]}</span><br>
<span class="what">${esc(what)}</span>${where ? `<br><span class="muted">${esc(where)}</span>` : ""}${r.note ? `<br><span class="muted">📝 ${esc(r.note)}</span>` : ""}
${r.check.length ? `<br><span class="chip warn">check: ${esc(r.check.join("; "))}</span>` : ""}</span>
<span><b>${esc(money(r.totalCents))}</b>${trust}<form method="post" action="${BASE}/o/${esc(r.key)}/cancel" onsubmit="return confirm('Remove this order?')"><button class="link" type="submit">remove</button></form></span></li>`;
    })
    .join("");
  return `<div class="card"><h2>Orders (${list.length})</h2>${items ? `<ul class="list">${items}</ul>` : `<p class="muted">Orders show up here as customers send them.</p>`}</div>`;
}

type CustomerRow = { customer: Customer; lastOrder: string | null; devices: number };

function customersView(rows: CustomerRow[], report?: string) {
  const items = rows
    .map(({ customer: c, lastOrder, devices }) => {
      const where = [c.area, c.addressNote].filter(Boolean).join(" · ");
      const forget = devices
        ? `<form method="post" action="${BASE}/customers/${encodeURIComponent(c.phone)}/forget" onsubmit="return confirm('Their phone will ask for their number again. Continue?')"><button class="link" type="submit">forget ${devices} device${devices === 1 ? "" : "s"}</button></form>`
        : "";
      return `<li><span><b>${esc(c.name ?? "—")}</b> <span class="muted">${esc(c.phone)}</span>${where ? `<br><span class="muted">${esc(where)}</span>` : ""}${lastOrder ? `<br><span class="muted">last order ${esc(lastOrder)}</span>` : ""}</span><span>${forget}</span></li>`;
    })
    .join("");
  return `${tabs("customers")}${report ?? ""}<div class="card"><h2>Customers (${rows.length})</h2>
<p class="muted">Customers are saved the first time they order on the order page. Their phone remembers them after that.</p>
${items ? `<ul class="list">${items}</ul>` : `<p class="muted">No customers yet.</p>`}</div>
<form class="card" method="post" action="${BASE}/customers/import" enctype="multipart/form-data"><h2>Import customers</h2>
<p class="muted">A contacts file (.vcf) from your phone, or a .csv with columns phone,name,area,address_note. Existing details are never blanked. A .vcf brings in every contact on it, so export only your customers if you can.</p>
<input type="file" name="file" accept=".vcf,.csv,text/vcard,text/csv" required>
<p><button type="submit">Import</button></p></form>`;
}

function importReport(file: string, r: ImportReport) {
  const bad = r.badPhones.length ? `<br>Skipped ${r.badPhones.length} invalid number${r.badPhones.length === 1 ? "" : "s"}: ${esc(r.badPhones.slice(0, 5).map((b) => b.phone).join(", "))}` : "";
  const areas = r.areaMismatches.length ? `<br>${r.areaMismatches.length} area${r.areaMismatches.length === 1 ? "" : "s"} didn't match your list (left empty).` : "";
  return `<div class="flash">${esc(file)}: ${r.inserted} added, ${r.updated} updated.${bad}${areas}</div>`;
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
  const guard = (c: Context, post = false) => {
    noStore(c);
    // Pages here carry no token in the URL, so same-origin referrers are fine (and keep Origin real).
    c.header("Referrer-Policy", "same-origin");
    return viewer(c) && (!post || sameOrigin(c));
  };
  const form = readForm;
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

    const list = await dayOrders(deps.db, m.id);
    const sales = list.reduce((s, r) => s + r.totalCents, 0);
    const link = await orderLink(deps);
    const flagged = list.filter((r) => r.check.length).length;
    const warn = flagged
      ? `<div class="card warnbox"><b>${flagged} order${flagged === 1 ? "" : "s"} need a look</b><p class="muted">See "check" on the orders below: a WhatsForm answer that didn't match the menu, or an order from a phone we haven't seen for that number (tap "it's them" if it's fine).</p></div>`
      : "";
    const body =
      tabs("today") +
      flashOf(c) +
      menuSummary(m, tz) +
      formSteps(m, link, deps) +
      statsRow(list.length, sales) +
      warn +
      prepCard(m, list) +
      ordersCard(list, tz) +
      (deps.cfg.orderChannel === "whatsform" ? connectCard(deps) : "");
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
    if ("blockedBy" in r) return back(c, blockedText(r), true, `${BASE}/menu`);
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

  app.post(`${BASE}/o/:key/cancel`, async (c) => {
    if (!guard(c, true)) return denied(c);
    const ok = await cancelDayOrder(deps.db, c.req.param("key"), deps.now());
    return back(c, ok ? "Order removed." : "That order doesn't exist.", !ok);
  });

  app.post(`${BASE}/o/:key/trust`, async (c) => {
    if (!guard(c, true)) return denied(c);
    const ok = await trustDayOrder(deps.db, c.req.param("key"), deps.now());
    return back(c, ok ? "Marked OK ✓ Their phone shows their saved details from now on." : "That order doesn't exist.", !ok);
  });

  const customerRows = async (): Promise<CustomerRow[]> => {
    const last = deps.db
      .select({ phone: orders.customerPhone, date: max(menus.date).as("last_date") })
      .from(orders)
      .innerJoin(menus, eq(orders.menuId, menus.id))
      .where(eq(orders.status, "confirmed"))
      .groupBy(orders.customerPhone)
      .as("last");
    const devs = deps.db
      .select({ phone: customerDevices.customerPhone, n: count().as("n") })
      .from(customerDevices)
      .where(isNull(customerDevices.revokedAt))
      .groupBy(customerDevices.customerPhone)
      .as("devs");
    const rows = await deps.db
      .select({ customer: customers, lastDate: last.date, devices: devs.n })
      .from(customers)
      .leftJoin(last, eq(last.phone, customers.phone))
      .leftJoin(devs, eq(devs.phone, customers.phone))
      .orderBy(desc(last.date), customers.name);
    return rows.map((r) => ({ customer: r.customer, lastOrder: r.lastDate ? formatDay(r.lastDate, tz) : null, devices: Number(r.devices ?? 0) }));
  };

  app.get(`${BASE}/customers`, async (c) => {
    if (!guard(c)) return denied(c);
    return c.html(kpage("Customers", flashOf(c) + customersView(await customerRows())));
  });

  app.post(`${BASE}/customers/import`, async (c) => {
    if (!guard(c, true)) return denied(c);
    if (Number(c.req.header("content-length") ?? 0) > IMPORT_MAX_BYTES + 20_000) return back(c, "That file is too big (1 MB max).", true, `${BASE}/customers`);
    const { files } = await form(c);
    const file = files.file;
    if (!file || !file.size) return back(c, "Choose a .vcf or .csv file.", true, `${BASE}/customers`);
    if (file.size > IMPORT_MAX_BYTES) return back(c, "That file is too big (1 MB max).", true, `${BASE}/customers`);
    const text = await file.text();
    const isVcf = /\.vcf$/i.test(file.name) || /BEGIN:VCARD/i.test(text.slice(0, 2000));
    const { rows, report } = isVcf ? parseContactsVcf(text) : parseCustomersCsv(text, deps.cfg.areas);
    if (!rows.length) return back(c, "No phone numbers found in that file.", true, `${BASE}/customers`);
    await importCustomers(deps.db, rows, report, deps.now());
    return c.html(kpage("Customers", customersView(await customerRows(), importReport(file.name, report))));
  });

  app.post(`${BASE}/customers/:phone/forget`, async (c) => {
    if (!guard(c, true)) return denied(c);
    await deps.db
      .update(customerDevices)
      .set({ revokedAt: deps.now() })
      .where(and(eq(customerDevices.customerPhone, c.req.param("phone")), isNull(customerDevices.revokedAt)));
    return back(c, "Done: their phone will ask for their number next time.", false, `${BASE}/customers`);
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
