import { randomBytes } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Context, Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { Tx } from "../db/client";
import { customerDevices, customers, menus, orders, type Customer, type CustomerDevice, type Menu, type Order, type OrderLine } from "../db/schema";
import { cleanText, hashToken, linesFromForm, maskAddress, maskName, newDeviceToken, phoneTail } from "../domain/orderPage";
import { money, orderTotal, priceLines } from "../domain/order";
import { esc, CSS } from "../admin/html";
import { clientIp, readForm, sameOrigin } from "../admin/http";
import { errFields, log } from "../lib/log";
import { normalizePhone } from "../lib/phone";
import { rateLimiter } from "../lib/rateLimit";
import { formatDay, localDate } from "../lib/time";
import { send } from "../wa/send";
import { orderableMenu, publicMenu, type PublicMenu } from "./formMenu";
import type { Deps } from "./router";

/**
 * The customer order page (docs/order-page.md). One shared link, /order. The first
 * order asks for phone, name and address and leaves a random device cookie; later
 * visits from that browser open with the details filled in. A number we already
 * know, typed on a new browser, only sees masked details, and its order is flagged
 * and can't replace an order already placed. Prices always come from the menu.
 */

const COOKIE = "po";
const PATH = "/order";
const COOKIE_MAX_AGE = 400 * 24 * 3600; // Chrome's cap
const MAX = { name: 60, address: 200, note: 200 };

/** Per instance (Railway runs one). */
export const ORDER_LIMITS = {
  lookupPerIp: { max: 10, windowMs: 15 * 60_000 },
  submitPerIp: { max: 20, windowMs: 15 * 60_000 },
  changesPerPhone: { max: 20, windowMs: 24 * 3600_000 },
};

type Device = CustomerDevice & { customer: Customer };

/** What the form needs to know about who's ordering. */
type Who =
  | { kind: "new" } // no cookie, nothing typed yet: ask for the phone
  | { kind: "signup"; phone: string } // unknown number: ask name + address
  | { kind: "masked"; phone: string; customer: Customer } // known number, new or untrusted browser
  | { kind: "trusted"; customer: Customer };

const ORDER_CSS = `
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px;margin:12px 0}
.card h2{font-size:17px;margin:0 0 4px}
.dish{padding:10px 0;border-top:1px solid var(--line)}.dish:first-of-type{border-top:0}.dish b{display:block}
.size{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:6px}
.size .lbl{flex:1}.size .lbl span{color:var(--muted)}
.step{display:flex;align-items:center;gap:4px}
.step button{width:40px;height:40px;border-radius:10px;border:1px solid var(--line);background:var(--chip);color:var(--ink);font-size:20px;line-height:1;cursor:pointer}
.step input{width:48px;height:40px;text-align:center;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--ink);font:inherit;font-size:17px}
label{display:block;font-size:13px;color:var(--muted);margin:10px 0 3px}
input[type=text],input[type=tel],select,textarea{width:100%;padding:11px 12px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--ink);font:inherit;font-size:16px}
textarea{min-height:60px}
.go{display:block;width:100%;border:0;border-radius:10px;background:var(--accent);color:#fff;padding:15px;font:inherit;font-size:17px;font-weight:600;cursor:pointer}
.ghostbtn{background:none;border:0;color:var(--muted);font:inherit;font-size:14px;padding:6px 0;cursor:pointer;text-decoration:underline}
.bar{position:sticky;bottom:0;background:var(--bg);padding:10px 0 14px;border-top:1px solid var(--line)}
.total{display:flex;justify-content:space-between;font-size:17px;margin-bottom:8px}
.err{background:var(--warn);color:#fff;border-radius:8px;padding:10px 12px;margin:12px 0}
.ok{background:var(--accent);color:#fff;border-radius:8px;padding:10px 12px;margin:12px 0}
.lines{margin:0;padding:0;list-style:none}.lines li{display:flex;justify-content:space-between;gap:8px;padding:6px 0;border-top:1px solid var(--line)}.lines li:first-child{border-top:0}
.who b{font-size:16px}`;

/** Steppers and the running total. The page works without it (plain number inputs). */
const STEPPER_JS = `document.addEventListener('click',function(e){var b=e.target.closest('[data-step]');if(!b)return;var i=document.getElementById(b.getAttribute('data-for'));var v=(parseInt(i.value,10)||0)+parseInt(b.getAttribute('data-step'),10);i.value=Math.max(0,Math.min(50,v));t()});
document.addEventListener('input',t);function t(){var s=0;document.querySelectorAll('input[data-price]').forEach(function(i){s+=(parseInt(i.value,10)||0)*parseInt(i.getAttribute('data-price'),10)});var el=document.getElementById('tot');if(el)el.textContent='$'+(s/100).toFixed(2)}t();`;

function shell(c: Context, kitchen: string, title: string, body: string, status: 200 | 400 | 403 | 409 | 429 = 200) {
  const nonce = randomBytes(16).toString("base64");
  c.header("Content-Security-Policy", `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`);
  c.header("Referrer-Policy", "no-referrer");
  c.header("X-Robots-Tag", "noindex");
  c.header("Cache-Control", "no-store");
  c.header("X-Content-Type-Options", "nosniff");
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(title)}</title><style>${CSS}${ORDER_CSS}</style></head>
<body><header><h1>${esc(kitchen)}</h1></header><main>${body}</main><script nonce="${nonce}">${STEPPER_JS}</script></body></html>`;
  return c.html(html, status);
}

function linesList(lines: OrderLine[], totalCents: number) {
  return `<ul class="lines">${lines.map((l) => `<li><span>${l.qty} × ${esc(l.name)}</span><span>${esc(money(l.qty * l.unit_cents))}</span></li>`).join("")}
<li><b>Total</b><b>${esc(money(totalCents))}</b></li></ul>`;
}

function menuHead(pm: PublicMenu) {
  return `<div class="card"><h2>Menu for ${esc(pm.day ?? "")}</h2><p class="muted">${pm.cutoff ? `Order by ${esc(pm.cutoff)}. You can change your order until then.` : "Order today. You can change your order until the end of the day."}</p></div>`;
}

function stepperRows(pm: PublicMenu, qty: Map<string, number>) {
  return pm.dishes
    .map(
      (d) =>
        `<div class="dish"><b>${esc(d.name)}</b>${d.sizes
          .map((s) => {
            const id = `q_${s.id}`;
            return `<div class="size"><span class="lbl">${s.label ? `${esc(s.label)} <span>${esc(s.price)}</span>` : `<span>${esc(s.price)}</span>`}</span>
<span class="step"><button type="button" data-step="-1" data-for="${esc(id)}" aria-label="One less">−</button><input type="number" inputmode="numeric" min="0" max="50" id="${esc(id)}" name="${esc(id)}" value="${qty.get(s.id) ?? 0}" data-price="${s.price_cents}" aria-label="${esc(s.name)}"><button type="button" data-step="1" data-for="${esc(id)}" aria-label="One more">+</button></span></div>`;
          })
          .join("")}</div>`,
    )
    .join("");
}

function areaSelect(areas: string[], current: string | null) {
  if (!areas.length) return "";
  return `<label for="area">Area</label><select id="area" name="area"><option value="">—</option>${areas
    .map((a) => `<option${a === current ? " selected" : ""}>${esc(a)}</option>`)
    .join("")}</select>`;
}

type FormState = { qty: Map<string, number>; name?: string; address?: string; area?: string; note?: string; altAddress?: string; error?: string };

/** The phone step: nothing about anyone is shown until a number is typed. */
function phoneStep(pm: PublicMenu, error?: string, phone = "") {
  return `${menuHead(pm)}${error ? `<div class="err">${esc(error)}</div>` : ""}
<form class="card" method="post" action="${PATH}/start"><h2>Your WhatsApp number</h2>
<p class="muted">So the kitchen knows who's ordering. This phone remembers you after your first order.</p>
<input type="tel" name="phone" value="${esc(phone)}" autocomplete="tel" placeholder="(201) 555-0123" required>
<p><button class="go" type="submit">Next</button></p></form>`;
}

function detailsBlock(who: Exclude<Who, { kind: "new" }>, st: FormState, areas: string[]) {
  if (who.kind === "trusted") {
    const c = who.customer;
    return `<div class="card"><h2>Your details</h2>
<p class="muted">Phone ${esc(c.phone)}</p>
<label for="name">Name</label><input type="text" id="name" name="name" maxlength="${MAX.name}" value="${esc(st.name ?? c.name ?? "")}" autocomplete="name" required>
<label for="address">Delivery address</label><input type="text" id="address" name="address" maxlength="${MAX.address}" value="${esc(st.address ?? c.addressNote ?? "")}" autocomplete="street-address" required>
${areaSelect(areas, st.area ?? c.area)}
<label for="note">Note for the kitchen (optional)</label><input type="text" id="note" name="note" maxlength="${MAX.note}" value="${esc(st.note ?? "")}"></div>`;
  }
  if (who.kind === "signup") {
    return `<div class="card"><h2>Your details</h2>
<p class="muted">Phone ${esc(who.phone)} · <a href="${PATH}?again=1">change</a></p><input type="hidden" name="phone" value="${esc(who.phone)}">
<label for="name">Name</label><input type="text" id="name" name="name" maxlength="${MAX.name}" value="${esc(st.name ?? "")}" autocomplete="name" required>
<label for="address">Delivery address</label><input type="text" id="address" name="address" maxlength="${MAX.address}" value="${esc(st.address ?? "")}" autocomplete="street-address" required>
${areaSelect(areas, st.area ?? null)}
<label for="note">Note for the kitchen (optional)</label><input type="text" id="note" name="note" maxlength="${MAX.note}" value="${esc(st.note ?? "")}"></div>`;
  }
  const c = who.customer;
  const name = maskName(c.name);
  const addr = maskAddress(c.addressNote);
  return `<div class="card who"><h2>Welcome back${name ? `, <b>${esc(name)}</b>` : ""}</h2>
<p class="muted">Phone ending ${esc(phoneTail(who.phone))}${addr ? ` · delivering to <b>${esc(addr)}</b>` : ""}</p><input type="hidden" name="phone" value="${esc(who.phone)}">
<label for="alt_address">Different address this time? (optional)</label><input type="text" id="alt_address" name="alt_address" maxlength="${MAX.address}" value="${esc(st.altAddress ?? "")}">
<label for="note">Note for the kitchen (optional)</label><input type="text" id="note" name="note" maxlength="${MAX.note}" value="${esc(st.note ?? "")}">
<p class="muted">New phone? The kitchen confirms it's you, then your details show here.</p></div>`;
}

function orderForm(pm: PublicMenu, who: Exclude<Who, { kind: "new" }>, st: FormState, areas: string[], existing: Order | null) {
  const forget =
    who.kind === "trusted" || existing
      ? `<form method="post" action="${PATH}/forget"><button class="ghostbtn" type="submit">Not ${who.kind === "trusted" ? esc(who.customer.name ?? "you") : "you"}? Use a different number</button></form>`
      : "";
  const cancel = existing
    ? `<button class="ghostbtn" type="submit" name="action" value="cancel" formnovalidate>Cancel my order</button>`
    : "";
  return `${menuHead(pm)}${existing ? `<div class="ok">You've ordered. Change the amounts below and tap Update, or cancel.</div>` : ""}${st.error ? `<div class="err">${esc(st.error)}</div>` : ""}
<form method="post" action="${PATH}"><div class="card">${stepperRows(pm, st.qty)}</div>
${detailsBlock(who, st, areas)}
<div class="bar"><div class="total"><span>Total</span><b id="tot">—</b></div><button class="go" type="submit" name="action" value="save">${existing ? "Update order" : "Place order"}</button>${cancel}</div></form>${forget}`;
}

function closedView(kitchen: string, order: { menu: Menu; order: Order } | null, tz: string, note?: string) {
  const mine = order
    ? `<div class="card"><h2>Your order for ${esc(formatDay(order.menu.date, tz))}</h2>${linesList(order.order.lines, order.order.totalCents)}</div>`
    : "";
  return `<div class="card"><h2>Ordering is closed</h2><p>${note ? esc(note) + " " : ""}The next menu opens here when ${esc(kitchen)} publishes it.</p></div>${mine}`;
}

function doneView(pm: PublicMenu, o: Order, cancelled: boolean) {
  if (cancelled) return `<div class="ok">Your order is cancelled.</div><p><a href="${PATH}">Order again</a></p>`;
  return `<div class="ok">Order received ✓ The kitchen has it.</div>
<div class="card"><h2>${esc(pm.day ?? "")}</h2>${linesList(o.lines, o.totalCents)}${o.address ? `<p class="muted">Delivering to ${esc(o.address)}</p>` : ""}${o.note ? `<p class="muted">📝 ${esc(o.note)}</p>` : ""}
<p class="muted">${pm.cutoff ? `You can change it until ${esc(pm.cutoff)}.` : "You can change it until the end of the day."}</p></div>
<p><a href="${PATH}">Change my order</a></p>`;
}

/** Same lines, note and address: a resubmit, nothing to save or tell the owner. */
const sameOrder = (o: Order, lines: OrderLine[], note: string | null, address: string | null) =>
  o.status === "confirmed" && JSON.stringify(o.lines) === JSON.stringify(lines) && o.note === note && o.address === address;

function pingText(name: string, area: string | null, o: Order, kind: "new" | "changed" | "cancelled", address: string | null) {
  const who = `${name}${area ? ` (${area})` : ""}`;
  if (kind === "cancelled") return `❌ Order cancelled: ${who}`;
  const what = o.lines.map((l) => `${l.qty}× ${l.name}`).join(", ");
  const flag = o.flagged ? `\n⚠️ Ordered from a new phone for this number: check it's them (/app)` : "";
  return `${kind === "new" ? "🧾 New order" : "✏️ Order changed"}: ${who}\n${what} — ${money(o.totalCents)}${address ? `\n📍 ${address}` : ""}${o.note ? `\n📝 ${o.note}` : ""}${flag}`;
}

/** Register GET/POST /order, POST /order/start and POST /order/forget. */
export function registerOrderPage(app: Hono, deps: Deps) {
  const tz = deps.cfg.tz;
  const kitchen = deps.cfg.kitchenName;
  const lookups = rateLimiter(ORDER_LIMITS.lookupPerIp.max, ORDER_LIMITS.lookupPerIp.windowMs);
  const submits = rateLimiter(ORDER_LIMITS.submitPerIp.max, ORDER_LIMITS.submitPerIp.windowMs);
  const changes = rateLimiter(ORDER_LIMITS.changesPerPhone.max, ORDER_LIMITS.changesPerPhone.windowMs);
  const secure = (deps.cfg.publicUrl ?? "https://").startsWith("https://");

  async function deviceOf(c: Context): Promise<Device | null> {
    const token = getCookie(c, COOKIE);
    if (!token || token.length > 100) return null;
    const [row] = await deps.db
      .select({ device: customerDevices, customer: customers })
      .from(customerDevices)
      .innerJoin(customers, eq(customerDevices.customerPhone, customers.phone))
      .where(and(eq(customerDevices.tokenHash, hashToken(token)), isNull(customerDevices.revokedAt)));
    return row ? { ...row.device, customer: row.customer } : null;
  }

  const orderOf = async (menuId: number, phone: string) => {
    const [o] = await deps.db.select().from(orders).where(and(eq(orders.menuId, menuId), eq(orders.customerPhone, phone)));
    return o ?? null;
  };

  const live = (o: Order | null) => (o && o.status === "confirmed" ? o : null);
  const qtyOf = (o: Order | null) => new Map((live(o)?.lines ?? []).map((l) => [l.item_id, l.qty]));
  const tooMany = (c: Context) => shell(c, kitchen, "Slow down", `<div class="err">Too many tries. Wait a few minutes and try again.</div>`, 429);

  /** Who's ordering, from the cookie or a typed phone; null when the phone isn't valid. */
  async function whoFrom(dev: Device | null, typed: string | undefined): Promise<Exclude<Who, { kind: "new" }> | null> {
    if (dev) return dev.trusted ? { kind: "trusted", customer: dev.customer } : { kind: "masked", phone: dev.customerPhone, customer: dev.customer };
    const phone = normalizePhone(typed);
    if (!phone) return null;
    const [cust] = await deps.db.select().from(customers).where(eq(customers.phone, phone));
    return cust ? { kind: "masked", phone, customer: cust } : { kind: "signup", phone };
  }

  app.get(PATH, async (c) => {
    try {
      const now = deps.now();
      const menu = await orderableMenu(deps.db, now, tz);
      const dev = await deviceOf(c);
      if (dev) await deps.db.update(customerDevices).set({ lastSeenAt: now }).where(eq(customerDevices.id, dev.id));
      if (!menu) {
        const [today] = await deps.db.select().from(menus).where(eq(menus.date, localDate(now, tz)));
        const mine = dev && today ? live(await orderOf(today.id, dev.customerPhone)) : null;
        return shell(c, kitchen, "Closed", closedView(kitchen, mine && today ? { menu: today, order: mine } : null, tz));
      }
      const pm = publicMenu(menu, kitchen, tz);
      if (!dev) return shell(c, kitchen, "Order", phoneStep(pm));
      const existing = live(await orderOf(menu.id, dev.customerPhone));
      const who = (await whoFrom(dev, undefined))!;
      return shell(c, kitchen, "Order", orderForm(pm, who, { qty: qtyOf(existing), note: existing?.note ?? undefined }, deps.cfg.areas, existing));
    } catch (e) {
      log.error("order page failed", errFields(e));
      return c.text("Something went wrong. Try again in a minute.", 500);
    }
  });

  // Phone typed on a browser we don't know: show the order form for that number.
  app.post(`${PATH}/start`, async (c) => {
    if (!sameOrigin(c)) return c.text("forbidden", 403);
    const now = deps.now();
    if (!lookups.hit(clientIp(c), now)) return tooMany(c);
    const menu = await orderableMenu(deps.db, now, tz);
    if (!menu) return shell(c, kitchen, "Closed", closedView(kitchen, null, tz), 409);
    const pm = publicMenu(menu, kitchen, tz);
    const { one } = await readForm(c);
    const who = await whoFrom(null, one.phone);
    if (!who) return shell(c, kitchen, "Order", phoneStep(pm, "That doesn't look like a phone number. Include the area code.", one.phone), 400);
    return shell(c, kitchen, "Order", orderForm(pm, who, { qty: new Map() }, deps.cfg.areas, null));
  });

  app.post(`${PATH}/forget`, async (c) => {
    if (!sameOrigin(c)) return c.text("forbidden", 403);
    const token = getCookie(c, COOKIE);
    if (token) await deps.db.update(customerDevices).set({ revokedAt: deps.now() }).where(eq(customerDevices.tokenHash, hashToken(token)));
    deleteCookie(c, COOKIE, { path: PATH, secure });
    return c.redirect(PATH, 303);
  });

  app.post(PATH, async (c) => {
    if (!sameOrigin(c)) return c.text("forbidden", 403);
    const now = deps.now();
    if (!submits.hit(clientIp(c), now)) return tooMany(c);
    const menu = await orderableMenu(deps.db, now, tz);
    if (!menu) return shell(c, kitchen, "Closed", closedView(kitchen, null, tz, "Your order wasn't saved: ordering closed."), 409);
    const pm = publicMenu(menu, kitchen, tz);
    const { one } = await readForm(c);
    const dev = await deviceOf(c);
    const who = await whoFrom(dev, one.phone);
    if (!who) return shell(c, kitchen, "Order", phoneStep(pm, "Enter your WhatsApp number first."), 400);
    const phone = who.kind === "trusted" ? who.customer.phone : who.phone;
    const trusted = who.kind !== "masked";

    const cancel = one.action === "cancel";
    const parsed = linesFromForm(one, menu.items);
    const priced = priceLines(parsed.raw, menu.items);
    const st: FormState = {
      qty: new Map(parsed.raw.map((r) => [r.item_id, r.qty])),
      name: one.name,
      address: one.address,
      area: one.area,
      note: one.note,
      altAddress: one.alt_address,
    };
    const again = (error: string, status: 400 | 409 = 400) =>
      shell(c, kitchen, "Order", orderForm(pm, who, { ...st, error }, deps.cfg.areas, null), status);
    const problems = [...parsed.problems, ...priced.problems];
    if (!cancel && problems.length) return again(problems.join(" "));

    const name = cleanText(one.name, MAX.name);
    const address = cleanText(one.address, MAX.address);
    const area = deps.cfg.areas.includes(one.area ?? "") ? one.area! : null;
    if (!cancel && who.kind !== "masked" && (!name || !address)) return again("Add your name and delivery address.");

    const existing = await orderOf(menu.id, phone);
    // A browser we can't vouch for may only touch an order made the same way.
    if (!trusted && live(existing) && existing!.flagReason !== "new device") {
      return again("This number already has an order today. To change it, use the phone you ordered from, or message the kitchen.", 409);
    }
    if (cancel && !live(existing)) return again("There's no order to cancel.");
    if (!cancel && !priced.lines.length) return again(live(existing) ? "Pick at least one dish, or tap Cancel my order." : "Pick at least one dish.");
    if (!changes.hit(phone, now)) return tooMany(c);

    const note = cleanText(one.note, MAX.note);
    const orderAddress = trusted ? address : (cleanText(one.alt_address, MAX.address) ?? who.customer.addressNote);
    const lines = priced.lines;
    if (!cancel && existing && sameOrder(existing, lines, note, orderAddress)) return shell(c, kitchen, "Order received", doneView(pm, existing, false));

    let token: string | null = null;
    const saved = await deps.db.transaction(async (tx: Tx) => {
      if (who.kind === "signup") {
        await tx
          .insert(customers)
          .values({ phone, name, area, addressNote: address, createdAt: now, updatedAt: now })
          .onConflictDoUpdate({
            target: customers.phone,
            set: {
              name: sql`coalesce(${customers.name}, excluded.name)`,
              area: sql`coalesce(${customers.area}, excluded.area)`,
              addressNote: sql`coalesce(${customers.addressNote}, excluded.address_note)`,
              updatedAt: now,
            },
          });
      } else if (who.kind === "trusted" && !cancel) {
        await tx.update(customers).set({ name, addressNote: address, area: area ?? who.customer.area, updatedAt: now }).where(eq(customers.phone, phone));
      }
      if (!dev) {
        token = newDeviceToken();
        await tx.insert(customerDevices).values({ tokenHash: hashToken(token), customerPhone: phone, trusted, createdAt: now, lastSeenAt: now });
      }
      if (cancel) {
        const [o] = await tx.update(orders).set({ status: "cancelled", updatedAt: now }).where(eq(orders.id, existing!.id)).returning();
        return o!;
      }
      const values = {
        lines,
        totalCents: orderTotal(lines),
        status: "confirmed" as const,
        source: "page" as const,
        confidence: null,
        flagged: !trusted,
        flagReason: trusted ? null : "new device",
        note,
        address: orderAddress,
        updatedAt: now,
      };
      const [o] = await tx
        .insert(orders)
        .values({ menuId: menu.id, customerPhone: phone, createdAt: now, ...values })
        .onConflictDoUpdate({ target: [orders.menuId, orders.customerPhone], set: values })
        .returning();
      return o!;
    });
    if (token) setCookie(c, COOKIE, token, { httpOnly: true, secure, sameSite: "Lax", path: PATH, maxAge: COOKIE_MAX_AGE });

    const kind = cancel ? "cancelled" : live(existing) ? "changed" : "new";
    const [cust] = await deps.db.select().from(customers).where(eq(customers.phone, phone));
    log.info("page order", { orderId: saved.id, menuId: menu.id, kind, flagged: saved.flagged, lines: saved.lines.length });
    await pingOwners(deps, saved, pingText(cust?.name ?? phone, cust?.area ?? null, saved, kind, orderAddress));
    return shell(c, kitchen, cancel ? "Cancelled" : "Order received", doneView(pm, saved, cancel));
  });
}

/** One WhatsApp line per order change to each owner (only while their 24 h window is open). Never fails the order. */
async function pingOwners(deps: Deps, o: Order, text: string) {
  // updatedAt alone can repeat within a millisecond; the content tells two edits apart.
  const version = hashToken(JSON.stringify([o.status, o.lines, o.note, o.address])).slice(0, 12);
  for (const owner of deps.cfg.ownerNumbers) {
    try {
      await send(deps, { kind: "text", to: owner, body: text }, `order:${o.id}:${o.updatedAt.getTime()}:${version}:${owner}`);
    } catch (e) {
      log.error("order ping failed", { orderId: o.id, ...errFields(e) });
    }
  }
}
