# Current system (as deployed, 2026-11-12)

This is a snapshot of what runs for the first kitchen today: **customers order through WhatsForm**, and the owner uses a WhatsApp assistant plus a kitchen web page. The full chat-ordering bot (repo README) is built but **not** running. Details and history: [`README.md`](README.md). Owner side: [`owner-assistant.md`](owner-assistant.md). Form side: [`whatsform-interim.md`](whatsform-interim.md).

## Pieces

| Piece | What it does | Code |
|---|---|---|
| Preppr app (Railway) | One Node process: HTTP routes + in-process worker (inbox/outbox, periodic jobs) | `src/index.ts`, `src/app.ts`, `src/jobs/worker.ts` |
| Owner assistant (WhatsApp) | Owner messages a Meta **test number**. Plain chat sets dishes and the day's menu (Save/Publish previews). Commands `/how` `/what` `/orders` `/message` `/app`, plus `/products` `/add-product` `/edit-product` `/remove-product` `/menu` `/link` | `src/flows/ownerChat.ts`, `ownerDay.ts`, `catalog.ts`, `owner.ts` |
| Owner-only mode | `OWNER_ONLY=1`: any other number is stored, never answered | `src/flows/router.ts` |
| Kitchen page | `/admin/kitchen` (link from `/app`, 30-day token + cookie). Today: menu, form setup card, orders, sales, what to make, broadcast. Products: dishes and sizes | `src/admin/kitchen.ts` |
| Order form | One permanent WhatsForm. Its Custom Script loads `/wf.js`, which reads `/public/menu.json` and draws the menu with +/− into the "Your order" question. Notes tell the customer the order is saved on Submit, then to tap Send in WhatsApp | `src/flows/formScript.ts`, `formMenu.ts` |
| Order page (built, not switched on) | `/order`: one shared link. First order asks phone, name, address and remembers the browser (cookie); later visits are prefilled. Orders go into `orders` (priced in code), owner pinged per order. Details: [`order-page.md`](order-page.md) | `src/flows/orderPage.ts`, `src/flows/dayOrders.ts` |
| Order intake | WhatsForm webhook `POST /webhooks/whatsform/<token>` → `form_responses`. "Your order" parsed (script format, then strict rules), priced in code from the menu, customer upserted (empty fields only), unreadable lines flagged | `src/flows/formOrders.ts`, `src/domain/formOrders.ts` |
| Model | Groq `openai/gpt-oss-120b`, only for loose dish/menu text from the owner. Prices it returns must appear in her text; nothing saved until she taps Save/Publish | `src/llm/*` |

`ORDER_CHANNEL=whatsform`: Publish replies with the broadcast text (form link included); no cutoff summary is sent. `ORDER_CHANNEL=page` is the same on the owner side, with the `/order` link in the broadcast.

## Flow of a day

1. Owner: `today dal, paneer, roti` → **Publish** (or ticks sizes on the kitchen page).
2. App replies with the broadcast; she forwards it to her WhatsApp Business broadcast list.
3. Customer opens the form link, taps + on dishes, fills name / phone / address, taps **Submit on WhatsApp**.
4. WhatsForm posts the submission to our webhook (saved now) and opens WhatsApp with the order typed out to the kitchen's own number. The customer taps Send (only so it shows in her chat; WhatsApp never lets a page send).
5. Owner checks `/how`, `/what`, `/orders` or the kitchen page. The form shows "closed" after the menu's cutoff.

## HTTP routes

| Route | Purpose |
|---|---|
| `/webhook`, `/webhooks/whatsapp` | Meta webhook (HMAC verified, raw body stored, then worker) |
| `/webhooks/whatsform/:token` | WhatsForm submissions |
| `/order`, `/order/start`, `/order/forget` | Customer order page (device cookie, same-origin POSTs, rate limited) |
| `/public/menu.json`, `/wf.js` | Public menu (no customer data, CORS `*`) and form script |
| `/admin/kitchen`, `/admin`, `/admin/c/:phone` | Kitchen page (Today, Products, Customers); read-only chat viewer |
| `/healthz`, `/readyz`, `/health` | Liveness, DB readiness, watchdog report |
| `/jobs/cutoff`, `/internal/cutoff` | Bearer-protected cutoff job (unused in WhatsForm mode) |

## Hosting and accounts

| What | Where |
|---|---|
| App | Railway project `preppr` (kitchen Gmail account), `https://preppr-production.up.railway.app`. Deploy: `.env.assistant` → `sh scripts/railway-push-env.sh` → `railway up` (never `railway redeploy`) |
| Database | Neon project `preppr`, branch `main`; migrations run at start |
| WhatsApp | Meta app under the kitchen's business portfolio, test number (≤5 verified recipients). User token expires **2027-01-06** |
| Form | WhatsForm, owner's account (Standard plan for webhook + Custom Script) |
| Secrets | `.env.assistant` (local, gitignored) and Railway variables |

## Data

Neon Postgres (`src/db/schema.ts`): `products`, `menus`, `form_responses`, `customers`, `kv` (`form_link`, drafts), and message tables (`messages`, `raw_webhooks`, `inbox`, `outbox`, `wa_statuses`). `orders` holds order-page orders (`source = 'page'`) once customers use `/order`; `customer_devices` the remembered browsers (token hashes). `payments` is empty in this mode. The kitchen page and `/how /what /orders` read `orders` and `form_responses` together. Outside: WhatsForm Responses / Google Sheet (backup source of truth), and the customer's message in the owner's WhatsApp Business app.

## Known limits

- Customers retype name, phone and address every time on WhatsForm: one shared link, so the form can't know who opened it. (Fixed by the order page.)
- WhatsForm webhook payload shape not yet confirmed with a real submission.
- Customers must tap Send for the order to appear in the owner's chat (the order is saved either way).
- Test number only; token is a user token, not a system-user token.
- No uptime alert, Sentry DSN, or backups beyond Neon's restore window.

## Next

Switch to the order page (`ORDER_CHANNEL=page`, [`order-page.md`](order-page.md) "Switch-over") after a test order on a real phone. Backlog for the current system: [`README.md`](README.md#backlog-in-order).
