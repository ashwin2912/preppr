# Order page (`/order`): our own replacement for WhatsForm

Customers order on a page the app serves. Orders go straight into our database, priced in code. Returning customers don't retype their details. There is no "tap Send in WhatsApp" step. WhatsForm keeps working alongside it until switch-over (`ORDER_CHANNEL`).

Code: `src/flows/orderPage.ts` (routes, page), `src/domain/orderPage.ts` (masking, form fields, tokens), `src/flows/dayOrders.ts` (owner views over both sources). Tests: `test/orderPage.test.ts`.

## One link for everyone

The daily broadcast carries **one** link: `https://<PUBLIC_URL>/order`. WhatsApp broadcast lists send identical text to everyone, and the kitchen number isn't on the API yet, so per-customer links can't be delivered. The page recognises people by their browser instead.

## The customer's side

1. **First order.** The page shows the menu ("Menu for Wed, Nov 11 · Order by 10:30 AM") and asks for their WhatsApp number. A new number then gets dishes with − / + steppers and a running total, plus name, delivery address, area and an optional note. They tap **Place order** and see a confirmation with lines and total.
2. On that first order the server saves the customer and sets a cookie (`po`) holding a random token. Only the token's sha256 is stored (`customer_devices`).
3. **Every later visit from that browser** opens straight to the menu with their details filled in, and their current order if they have one. They can change amounts and tap **Update order**, or **Cancel my order**, until the cutoff. One order per customer per menu.
4. **After the cutoff** the page says "Ordering is closed" and shows their order for the day, if any.

### New phone, new browser, cleared cookies

They type their number. If we already know it, the page shows only **masked** details ("Welcome back, P\*\*\*a · phone ending 0111 · delivering to …Apt 4B"), plus an optional "different address this time" field. Then:

- The order is saved, **flagged** "new device", and the owner's ping says to check it.
- If that number already has an order for the day (from their usual phone, or by chat), the new browser **can't replace or cancel it**. It's told to use the phone it ordered from or message the kitchen.
- The browser gets an *untrusted* cookie: it stays masked and its orders stay flagged until the owner taps **it's them ✓** on the order in the kitchen page. Then it's trusted like any other.

Saved name and address are never changed from an untrusted browser.

## The owner's side

- **Ping per order**: one WhatsApp line to each owner number for every new, changed or cancelled order ("🧾 New order: Priya (Heights) · 2× Dal 8oz, 4× Roti — $16.00 · 📍 address · 📝 note"). It goes through `send()`, so it only goes out while the owner's 24 h window is open, and a resubmit with no change sends nothing.
- **Kitchen page, Today**: orders from the page, WhatsForm and chat in one list, each labelled. Flagged ones show "check: new device" and **it's them ✓**. **remove** works for all sources. The order page link + copy button replace the WhatsForm cards when `ORDER_CHANNEL=page`.
- **Kitchen page, Customers**: everyone saved, last order date, and **forget N devices** (that phone asks for the number again). **Import** a `.vcf` or `.csv` (≤1 MB; same parser as `pnpm import:customers`). A `.vcf` brings in every contact on it. Existing details are never blanked.
- `/how`, `/what`, `/orders`, `/message` read both sources. `/message` and Publish put the `/order` link in the broadcast.

## Menu edits after orders

Menu item ids are positional, so rebuilding a menu used to shift them under existing orders. A save from the kitchen page now carries ids over (same product+size, or same name). It is allowed after orders exist **as long as every ordered dish stays at its price**; adding dishes is fine. A WhatsApp menu edit (which goes back to a draft) is still refused once there are orders. WhatsForm responses count as orders here too.

## Security

- Device token: 256 random bits, cookie `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/order`, 400 days; sha256 only in the DB.
- POSTs: same-origin check (`Sec-Fetch-Site`, else `Origin`), shared with the kitchen page (`src/admin/http.ts`).
- Rate limits (in memory, one instance; `ORDER_LIMITS`): phone step 10 per 15 min per IP, submit 20 per 15 min per IP, 20 order changes per phone per day. The IP is the last `X-Forwarded-For` hop (the one Railway's proxy adds).
- Prices only from the menu (`priceLines` / `orderTotal`). Quantities 1–50, only ids on the open menu.
- Headers: CSP with a per-response script nonce, no external scripts, `form-action 'self'`, `frame-ancestors 'none'`, `Referrer-Policy: no-referrer`, `noindex`, `no-store`.
- Every customer string is HTML-escaped (`esc`). The phone step shows nothing about anyone; known numbers see masked details only.

## Known limits

- The cookie lives in one browser. Another phone, Safari vs WhatsApp's in-app browser, a private tab or cleared data all mean the masked flow again.
- Anyone who knows a customer's number can see the masked details and place a flagged order in their name (never replacing theirs). The owner sees the flag and the ping.
- No phone verification (no OTP): the kitchen number isn't on the API.
- Page orders are `orders` rows with status `confirmed`, so they count as owed in BALANCE / DUES and show in the Sheet export when that's on.
- Menus saved on the kitchen page run to 23:59: no cutoff is shown and the page closes at midnight. Set a real one on WhatsApp (*cutoff 11*).
- The page shows the earliest open menu only; tomorrow's appears after today's cutoff.

## Switch-over from WhatsForm

1. Deploy (migration `0010` adds `customer_devices` and the `orders` columns `source`, `note`, `address`, `flag_reason`). `/order` works in any channel, so test it first: publish a menu, order from a phone, check the kitchen page and `/orders`.
2. Optionally import customers on the kitchen page (Customers → Import).
3. Set `ORDER_CHANNEL=page` in `.env.assistant`, `sh scripts/railway-push-env.sh`, `railway up`. Publish and `/message` now carry the `/order` link.
4. Keep the WhatsForm webhook connected for a few days: late form orders still show up.
