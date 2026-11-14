# Coexistence: the bot on the owner's existing number

Setup for running the bot on the number customers already message, the one in the owner's **WhatsApp Business app**. Meta calls this *coexistence*: the number stays live in the app on the owner's phone and is also connected to the Cloud API. Chats, contacts and history stay in one place, and the owner sees every bot reply in the app.

Use this instead of `meta-setup.md` step 8 (adding a new bot number). Steps 1–3, 5 and 7 of `meta-setup.md` still apply (portfolio, verification, app, webhook, system-user token).

Meta's dashboards and rules change often. The reference is Meta's guide: <https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users/>.

---

## What changes for the kitchen

| | Separate bot number | Coexistence |
|---|---|---|
| Customers message | a new number | the number they already have |
| Daily menu | owner forwards it to broadcast lists | the bot sends it (see "Menu push") |
| Broadcast lists | keep working | **disabled** (existing lists become read-only) |
| Owner commands (MENU, SUMMARY…) | from the owner's phone to the bot | from the owner's **personal** WhatsApp to the business number |
| Owner replies by hand | in the bot chat via a wa.me link | in the app, as today; the bot pauses for that chat |
| Groups | unaffected | unaffected, but the bot never sees them |
| Disappearing messages, view once, live location | unaffected | turned off in 1:1 chats |
| Linked devices (WhatsApp Web, desktop) | unaffected | unlinked at onboarding; re-link up to 4. WhatsApp for Windows and WearOS aren't supported, and messages sent from them don't reach the bot |
| Cost | free replies | free replies; template messages are paid (see below). Messages the owner types in the app stay free |

## How the bot behaves on a shared number

Set `WA_COEXISTENCE=1`. Then:

- **Unknown numbers:** the bot stays silent unless the message asks to order ("order", "menu", "tiffin", or a tap on the menu message). Friends, family and suppliers are left to the owner. The message is tagged `unknown_silent` in the chat viewer. To change this, set `UNKNOWN_SENDERS=onboard`.
- **The owner replies in a chat from the app:** the bot pauses for that customer for 4 hours (same as "talk to aunty"). The owner sends `RESUME <number>` from their personal number to hand back early.
- **Chats the bot stays out of stay unread** in the app, so the owner still notices them.
- **Owner alerts** (needs you, payments to verify, cutoff summary) go to `OWNER_NUMBERS`, the owner's personal number. They say "Reply to them in your WhatsApp Business app" instead of giving a wa.me link.
- **The chat viewer** (`CHATS`) shows what the owner typed in the app as "you, in the app".

`OWNER_NUMBERS` must not include `BOT_NUMBER`; the app refuses to start if it does.

## Menu push (replaces broadcast lists)

When the owner taps **Publish**, the bot asks "Send the menu to N customers who asked for it?" and also gives an order link (`wa.me/<number>?text=ORDER`) for the owner's Status or groups. On **Send menu**:

- A customer who messaged in the last 24 h gets the menu itself, as a normal message (free).
- Anyone else gets the **utility template** below. Its **See menu** button opens the chat, and the bot then sends the menu.
- Each customer gets it once per menu, however many times the button is tapped.

Only customers who opted in get it:

- After a customer's first confirmed order the bot asks once: "Want a message each day when ordering opens?".
- `STOP` from a customer turns it off and `START` turns it back on.
- The owner uses `OPTIN <number>` or `OPTOUT <number>`. `OPTIN ALL` opts in every customer who hasn't said no, for regulars who already get the broadcast. **The owner is responsible for those customers having agreed to get messages from the kitchen** (Meta's opt-in policy).

### Why a utility template with no menu in it

Meta still blocks **marketing** templates to US (+1) numbers. The pause started in April 2025 and no end date has been announced. A template listing dishes and prices counts as marketing, so it would never arrive. The template only says ordering is open. That keeps it utility, and the menu goes out as a free message once the customer taps.

Create it in **WhatsApp Manager → Message templates → Create**:

- Category **Utility**, name `daily_order_open` (or set `MENU_TEMPLATE`), language English US (`MENU_TEMPLATE_LANG=en_US`).
- Body: `Hi {{1}}, ordering for {{2}} is open until {{3}}. Tap below to see today's menu or skip.`
  - Samples: `Priya`, `Mon Oct 19`, `10:30 AM`.
- Buttons: two **quick replies**, `See menu` and `Skip today`, in that order.
- No prices, dishes, offers or emoji promotions.

If Meta changes the category to **Marketing**, edit the wording and resubmit. Until it's approved as utility, US customers won't get the push. Fallback: the owner posts the menu on their WhatsApp Status with the order link, and customers message in.

Cost: utility templates are charged per message at Meta's rate for the customer's country (a fraction of a cent each in the US; check Meta's current rate card). A template sent to a customer whose 24 h window is already open is free. Add a payment method in WhatsApp Manager.

Messaging limit: a new portfolio can start about 250 business-initiated conversations per 24 h. The bot warns the owner when a push goes over that. Business verification raises it.

## Onboarding the number

Meta only allows coexistence onboarding through **Embedded Signup**, run by a **Tech Provider** or a **Solution Partner (BSP)**. Not decided yet:

- **Tech Provider (us):**
  1. Our portfolio gets verified.
  2. The app passes App Review for `whatsapp_business_messaging` and `whatsapp_business_management`.
  3. We host an Embedded Signup page (v5: coexistence is on by default; v2/v3 were turned off 2026-10-15). Full steps: [`tech-provider.md`](tech-provider.md).

  This takes about 1–3 weeks, but it's direct Cloud API with no per-number fee, and it's also the Stage 3 plan. The signup page is built (`src/signup/routes.ts`), not yet run against Meta.
- **BSP (e.g. 360dialog):** their hosted Embedded Signup does the onboarding. Faster, but there's a monthly fee per number. Point the bot at their API:
  - `WA_API_URL`: their messages endpoint.
  - `WA_AUTH_HEADER`: their API-key header, e.g. `D360-API-KEY`.
  - `WA_TOKEN`: the key.

  Webhook payloads are the same Cloud API format.

### Before onboarding

- The owner's phone has **WhatsApp Business app 2.24.17 or newer**.
- The number has been in active use in the Business app (at least 7 days; longer is safer).
- The owner has a **personal WhatsApp** on another number for owner commands.
- The bot is running and the webhook URL works (`pilot-cloudflare.md` steps 1–5).
- The webhook subscribes to **`messages`, `smb_message_echoes`, `history`, `smb_app_state_sync`**. Contact sync arrives on the WABA-level webhook.
- The menu template is submitted (approval can take a day).

### Onboarding day

1. The owner runs Embedded Signup and picks "connect your existing WhatsApp Business app". They confirm on the phone when the Business app asks, and choose to share chat history.
2. We note the **phone number ID** and set `WA_PHONE_NUMBER_ID`, `BOT_NUMBER` (the shared number), `OWNER_NUMBERS` (the personal number) and `WA_COEXISTENCE=1`, then restart. Coexistence numbers don't need the `/register` PIN step.
3. **Within 24 hours:** `pnpm wa:sync`. This asks Meta for the contacts and up to 6 months of chat history. Each can be requested once; after 24 h the owner must onboard again. History lands in `messages` (source `history`) and contacts in `wa_contacts`. Neither creates customers or sends anything.
4. Import regulars as customers as before (`pnpm import:customers`, or the owner shares contacts from the personal number), then `OPTIN` the ones who get the daily menu.
5. Smoke test (below).

### Smoke test

- A friendly customer sends "hi": the bot replies; the owner sees both messages in the app.
- The owner types to that customer in the app; the customer's next message gets no bot reply; `RESUME` from the personal number turns it back on.
- A message from a non-customer ("are you open Sunday?") gets no bot reply and stays unread in the app.
- `MENU …` from the personal number → **Publish** → **Send menu**. A customer who wrote today gets the menu; one who didn't gets the template; **See menu** shows the menu; an order goes through.
- `SUMMARY` arrives on the personal number; the next morning's cutoff summary arrives.
- Logs: no `bad webhook signature`, `window_closed` for owner alerts, or error `131049` (template blocked as marketing).

## Gotchas

- **The owner must open the Business app at least every 14 days**, or Meta disconnects the number from the API.
- Messages sent from unsupported linked devices (Windows app, WearOS) don't reach the bot, so the bot won't pause for those replies. Reply from the phone or a supported device.
- Throughput is fixed at 20 messages/second, which is plenty for one kitchen.
