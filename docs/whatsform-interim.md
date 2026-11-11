# WhatsForm: one order form that shows today's menu

A stopgap until customers order in chat. There is **one permanent WhatsForm form with one link**. It shows whatever menu the owner published on WhatsApp, so she never edits WhatsForm day to day. Orders reach the kitchen page and `/how` `/what` `/orders` through the webhook.

Owner's assistant and kitchen page: [`owner-assistant.md`](owner-assistant.md). Overview: [`README.md`](README.md).

Checked in the kitchen's WhatsForm account (Standard plan) on 2026-11-11.

## The owner's day

1. On WhatsApp: *today dal, paneer, roti* → **Publish**. (Or tick dishes on the kitchen page.)
2. The bot replies with the broadcast, which already contains the form link. She forwards it to her broadcast list.
3. That's all. The form shows the new menu as soon as she publishes and says "closed" after the cutoff.

## The customer's side

1. They tap the link. The form shows "Menu for Wed, Nov 11 · Order by 10:30 AM", each dish and size with its price and **− / +** buttons, and a running total.
2. They fill in name, phone and address and tap **Submit on WhatsApp**.
3. WhatsApp opens with the order typed out ("2 × Dal 8oz, 4 × Roti (total $16)") to the kitchen's number. They tap Send.

The order is saved at step 2 (webhook, and WhatsForm Responses) even if they never tap Send. An empty order, or one sent after closing time, is blocked on the form.

## How it works

- **Custom Script** (WhatsForm: Settings → Integrations → Custom Script) holds one line: `<script src="https://<PUBLIC_URL>/wf.js"></script>`. We serve that file (`src/flows/formScript.ts`), so it can change without touching WhatsForm.
- The script loads `GET /public/menu.json` (`src/flows/formMenu.ts`): the earliest published menu, today or later, whose cutoff hasn't passed. It has dishes, sizes and prices only, no customer data, and is open to any origin (CORS `*`).
- It draws the menu above the form's **Your order** question, hides that question, and writes the order into it. WhatsForm's React form accepts the value (checked in Chrome on their form).
- **Webhook** (Settings → Integrations → Webhook, POST to the URL on the kitchen page): `src/domain/formOrders.ts` reads "Your order". It tries our exact format first, then the strict order rules for typed orders ("2 dal 8oz and 4 roti"). It prices everything again in code from the menu. Anything it can't read shows up as "needs a look".
- **If the script fails to load**, the plain "Your order" box stays visible with an example, and customers type their order.
- The form link is saved once (`/link <url>` on WhatsApp, or on the kitchen page). It goes into every broadcast (`kv` key `form_link`).

## One-time setup (about 15 minutes)

Make one form (e.g. *Order*). The link can be shortened in Settings → General → Form Link.

| Question | Type | Required |
|---|---|---|
| Your order | Text Input. The title must be exactly "Your order"; the script finds it by that title | yes |
| Your name | Text Input | yes |
| Your WhatsApp number | Phone | yes |
| Address / pickup | Text Input | yes |
| Notes (spice level, allergies…) | Text Input | no |

Then:

1. **Settings → Integrations → Custom Script:** paste the script line from the kitchen page (Today → Connect WhatsForm).
2. **Settings → Integrations → Webhook:** POST, with the URL from the same card.
3. **Settings → General:** WhatsApp number = the kitchen's business number.
4. Send `/link <form link>` to the assistant once.
5. Test: publish a menu, open the form link on a phone, add dishes, submit. Check `/orders`.

## If something goes wrong

- **The form shows the plain "Your order" box instead of the menu:** the menu didn't load. Check `https://<PUBLIC_URL>/public/menu.json` in a browser, and that Custom Script still has the line. Customers can still type orders meanwhile.
- **The form says closed but she wants to take orders:** the menu's cutoff has passed. Publish a menu with a later cutoff (*cutoff 2pm*).
- **No orders on the kitchen page:** check the webhook is connected. WhatsForm Responses (or Export as CSV) has every order.
- **An order "needs a look":** the customer typed something the rules couldn't read. The text is shown on the order.
- **A customer wants to change their order:** they message the kitchen as usual.

## Later

- **Customers ordering in chat** (the Preppr bot) replaces WhatsForm, with the same dishes, menus and customers.
- **Coexistence:** once her number is connected to the bot, broadcast lists become read-only. The link then goes out through the bot's menu push (`src/jobs/menuPush.ts`).
