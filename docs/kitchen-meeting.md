# First kitchen meeting: brief, questions, checklist

For the person running the bot, before sitting down with the kitchen. The goal of the first meeting is to **agree on the plan and collect everything we need**, not to connect the number. Connecting the number turns their broadcast lists read-only, so it happens on an agreed switch-over day (see "Switch-over plan").

Related: `owner-setup.md` (what the owner does, in their words), `coexistence-setup.md` (how the shared number works), `deploy.md`, `runbook.md`.

---

## 1. What you need to know going in

### What the bot does, in one paragraph

Customers message the kitchen's existing WhatsApp Business number as they do today. The bot reads each message, turns "2 dal, 3 roti" into an order, sends a summary with Confirm / Change buttons, and records it. At cutoff the owner gets a summary of every order and a delivery list grouped by area, and the bot keeps a ledger of who has paid. The owner keeps using the WhatsApp Business app and sees everything the bot says there. The owner gives commands (`MENU`, `SUMMARY`, `PAID`, `BOT OFF`) from their **personal** WhatsApp on a different number.

### Coexistence: what changes on their phone

Coexistence means the same number lives in the Business app **and** is connected to the API through 360dialog. When it is turned on:

| Changes | Detail |
|---|---|
| **Broadcast lists stop working** | They become read-only straight away. The bot's menu push replaces them. Undoing coexistence later is not documented, so treat it as one-way. |
| **Linked devices are logged out** | WhatsApp Web/desktop are unlinked at onboarding; up to 4 can be re-linked. **WhatsApp for Windows and WearOS are not supported**: messages sent from them never reach the bot. |
| **Some chat features go off in 1:1 chats** | Disappearing messages, view once, live location. |
| **The owner must open the Business app every 14 days** | Otherwise Meta disconnects the number from the API. The bot reminds them after 10 days. |
| **Groups** | Keep working. The bot never sees them. |
| **Chats** | Stay in one place. When the owner types in a chat, the bot goes quiet for that customer for 4 hours (`RESUME <number>` hands back sooner). |
| **Non-customers** | Friends, family, suppliers: the bot says nothing and leaves their chats unread. |

### How the daily menu reaches customers after switch-over

1. A customer who messaged in the last 24 h gets the menu as a normal message (free).
2. Everyone else who opted in gets a short **utility template** ("ordering for Mon is open until 10:30, tap See menu"). It has no dishes or prices, because Meta blocks marketing templates to US numbers. Tapping **See menu** opens the chat and the bot sends the menu.
3. The template needs Meta approval (about a day) and can only be submitted **after** the number is connected. Until then: the owner posts the menu on their WhatsApp Status and in groups with an order link, `wa.me/<number>?text=ORDER`.

### Rollout modes (reassure them: nothing goes out on day one)

- **Shadow:** the bot reads and records everything but sends customers nothing. The owner works exactly as today, and the cutoff summary shows what the bot would have done. A few days, until the parsing looks right.
- **Assist:** the bot sends only order summaries it is sure about. Anything else is held, the owner gets a ping, and `REVIEW` lists what was held.
- **Live:** the bot answers everyone it should.
- **`BOT OFF` / `BOT ON`** from the owner's personal number stops every customer reply instantly, in any mode.

### Costs to be upfront about

- **360dialog:** monthly fee per number (check the current plan on hub.360dialog.com before the meeting). Decide who pays.
- **Meta:** replies within 24 h of a customer's message are free. Utility templates (the daily menu nudge) cost a fraction of a cent each in the US; a template to someone whose 24 h window is open is free. Needs a card in WhatsApp Manager / 360dialog.
- **Hosting:** small VPS + free tiers (Neon, Cloudflare, Sentry). Ours to cover or pass on.

### Things to avoid saying or doing today

- Don't connect the number unless they explicitly accept losing broadcasts today and have a plan for tomorrow's menu.
- Don't take their 360dialog API key over WhatsApp, SMS or email. It is shown once: straight into a password manager.
- Don't promise voice-note orders or photo orders: the bot asks those customers to type and forwards the message to the owner. Transcription is on the backlog.
- Don't promise US marketing messages (offers, menus with prices as templates): Meta blocks them.

---

## 2. Questions to ask

### The business and their day

1. Which days do you cook? Any days off, holidays coming up? (`KITCHEN_DAYS`)
2. What time is the menu usually ready to send? (`MENU_EXPECTED_BY`; the bot alerts if it is late)
3. What is the order cutoff time? Does it change by day? (`CUTOFF_TIME`; a `MENU` message can override it per day)
4. How many orders on a normal day? On a busy day? How many regular customers?
5. Do you deliver, offer pickup, or both? Which delivery areas or routes? Exact names you use. (`AREAS`, comma-separated)
6. Who drives / delivers, and how do they get the delivery list today?
7. What does a typical menu look like? Ask for 3–5 real past menus (photos or text are fine). Fixed thali vs à la carte? Item names in Hindi/Tamil/English? Sizes or half portions?
8. How do customers usually write orders? Ask to see a few real chats (or exported chats, see `owner-setup.md` §4). Common shortcuts ("2 dal 3 roti", "same as yesterday", "aur")? Languages used?
9. Special requests (less spicy, no onion): how do you handle them today? Do they change price?
10. Can customers change or cancel after cutoff? Until when?
11. Minimum order, delivery fee, or discounts for subscriptions / weekly plans?
12. Do some customers have standing orders (every day the same)?

### Payments

13. How do customers pay? Zelle, Venmo, cash, card? Exact handles/numbers to show. (`PAYMENT_INSTRUCTIONS`)
14. Pay per order, weekly, or monthly? Do people run a tab?
15. How do you check who has paid today? Would a weekly "who owes what" list help?

### WhatsApp today

16. Which number do customers message? Is it the **WhatsApp Business app** (not regular WhatsApp)? Check the app version on the phone: **Settings → Help → App info, needs 2.24.17 or newer.**
17. How long has this number been on the Business app? (Needs at least 7 days of active use.)
18. Do you have a **personal WhatsApp on a different number**? That becomes the owner number for commands and alerts. Anyone else who should get alerts or give commands (spouse, manager)? (`OWNER_NUMBERS`)
19. How many broadcast lists, and roughly how many people on each? Are those people regulars who'd want a daily menu message? (They become `OPTIN` candidates.)
20. Do you use WhatsApp Web, the desktop app, **WhatsApp for Windows**, or a watch? (Windows/WearOS replies won't pause the bot.)
21. Do you use greeting/away messages, quick replies, labels, catalog? (Greeting/away messages that point elsewhere should go off.)
22. Do you post the menu on Status or in groups today?
23. Is there anyone who should **never** get a bot reply (family, suppliers, a delivery driver)? Note their numbers.

### Accounts and ownership

24. Does the business have a **Facebook / Meta Business account (business portfolio)**? Who logs in? Is it verified? Business legal name, address, website or Instagram if they have one.
25. Who should own the 360dialog account and the Meta portfolio? Recommended: the **kitchen owns both**, and we're added as admin. That way the number never depends on us.
26. Who pays the 360dialog fee and the Meta template charges? Card details stay with them; they add it themselves.
27. Is it OK for the bot to import the last months of chat history and contacts at onboarding? (Used to recognise regulars; nothing is sent.)
28. Display name customers should see (must match the business). Kitchen name for messages. (`KITCHEN_NAME`)
29. Do they want a Google Sheet of orders? If yes, which Google account to share it with.

### Switch-over

30. Which day can we switch? Best: an evening after orders are done, ideally before a lighter day.
31. On switch-over evening, can the owner be with the phone for 15–20 minutes (QR scan, confirm in the app)?
32. For the first day or two, are they OK posting the menu on Status and in groups (and to customers who wrote that day) while the template is approved?
33. How long are they happy in shadow mode before the bot replies? Who decides to go live?
34. Best way and time to reach the owner if something looks wrong?

---

## 3. Information to collect (fill in)

| Item | Value | Goes to |
|---|---|---|
| Kitchen name (as customers know it) | | `KITCHEN_NAME` |
| Business WhatsApp number (+1…) | | `BOT_NUMBER` |
| Owner personal number(s) (+1…) | | `OWNER_NUMBERS` |
| Other alert recipients | | `OWNER_NUMBERS` / `OPERATOR_NUMBERS` |
| Business app version on the phone | | must be ≥ 2.24.17 |
| Months on Business app | | ≥ 7 days |
| Cooking days | | `KITCHEN_DAYS` (e.g. `Mon,Tue,Wed,Thu,Fri,Sat`) |
| Menu ready by | | `MENU_EXPECTED_BY` (HH:MM) |
| Order cutoff | | `CUTOFF_TIME` (HH:MM) |
| Time zone | | `TZ` (e.g. `America/New_York`) |
| Delivery areas (exact names) | | `AREAS` |
| Payment instructions (exact text) | | `PAYMENT_INSTRUCTIONS` |
| 3–5 sample menus | | parser test set |
| 5–10 real order chats (export, no media) | | parser test set |
| Broadcast lists: count + size | | `OPTIN` plan |
| Numbers the bot must ignore | | owner notes |
| Meta business portfolio: owner + verified? | | onboarding |
| 360dialog account: who owns + pays | | onboarding |
| Google account for Sheet (optional) | | `SHEET_ID` share |
| Switch-over date and time | | plan |
| Owner contact for emergencies | | runbook |

---

## 4. Checklist on the phone (5 minutes, nothing changes)

- [ ] It is the **WhatsApp Business** app, version **2.24.17+** (Settings → Help → App info).
- [ ] Number in use on the Business app for at least 7 days.
- [ ] Owner has a personal WhatsApp on another number, and it can message the business number.
- [ ] Note linked devices (Settings → Linked devices): any Windows app or watch?
- [ ] Note greeting/away messages and broadcast lists.
- [ ] Phone has enough battery and storage; WhatsApp chat backup is on (good hygiene before onboarding).

---

## 5. Switch-over plan (agree on a day)

**Before (us):** sandbox end-to-end test passes; stack on a VPS (not a laptop); `wa:check` green; menu template text ready.

**Switch-over evening, after orders are done (about 20 minutes with the owner):**

1. 360dialog Hub → add number → **Connect existing WhatsApp Business app** → owner scans the QR in the Business app and confirms.
2. **Tick history and contact sharing.**
3. Copy the API key **into a password manager** (shown once).
4. Download the history/contacts file from the Hub before leaving.
5. We set the webhook (`pnpm wa:webhook:set`), check (`pnpm wa:check`), import history (`pnpm wa:sync <file>`), submit the template (`pnpm wa:templates:sync`), and `OPTIN` the broadcast regulars.
6. Owner sends `HELP` from their personal number to the business number: the reply proves commands work.

**Day 1:** bot in shadow. Owner posts the menu on Status/groups and in chats from the last 24 h. Cutoff summary shows what the bot would have done.

**Day 2+:** once the template is approved, the bot's menu push replaces broadcasts. A few days of shadow, then assist, then live, agreed with the owner.

---

## 6. After the meeting

- Fill in section 3 and put the values in `.env` (never commit `.env`).
- Turn the sample menus and chats into parser test cases.
- Confirm the switch-over date with the owner in writing.
- Decide whether owner-approved **Send menu** should go out in shadow/assist mode (currently blocked like other customer sends; a small change would close the day-1 gap).
