# Owner assistant and kitchen page (WhatsForm flow)

The kitchen owner's tools while customers order through WhatsForm ([`whatsform-interim.md`](whatsform-interim.md)):
- a **WhatsApp chat** with a private assistant, where she keeps her dishes and sets the daily menu by typing normally (since 2026-11-10, after her feedback that the page was one interface too many)
- a **kitchen page** (web): the dashboard for orders, sales and what to make. Dishes and menus can still be edited there; it's the same data

Customers never message this number. Overview, data and backlog: [`README.md`](README.md).

It's the normal Preppr app with two settings:
- `OWNER_ONLY=1`: only `OWNER_NUMBERS` get answers. Anyone else is recorded (`messages.intent = owner_only_ignored`) and ignored.
- `ORDER_CHANNEL=whatsform`: Publish replies with a broadcast containing the permanent form link; the form shows the menu itself. There's no order summary at cutoff, and `/help` shows the short list.

## Kitchen page

`/app` on WhatsApp sends a private link, valid 30 days. The page lives at `/admin/kitchen`.
- **Sign-in:** the same signed link as the chat viewer, then a cookie. Only `OWNER_NUMBERS` can sign in. Needs `ADMIN_SECRET` and `PUBLIC_URL`.
- **Form protection:** posts must be same-site (`Sec-Fetch-Site`, or `Origin` as a fallback) on top of the Lax cookie.

**Today tab**
1. **No menu yet:** only **Create today's menu** (or **Add your first dish** if she has none). Everything else is greyed out.
2. **Menu card:** the date, "N items on the menu" with dish chips, and **Edit**. Edit opens the picker page: her dishes with a checkbox per size, with today's choices pre-ticked, then **Save menu**.
   - Menus set here have **no cutoff**: they run to 23:59, and the broadcast says "Order here 👉 link".
3. **Send today's broadcast:** the order form link (saved once) and the broadcast message to copy. The form itself shows the published menu by itself ([`whatsform-interim.md`](whatsform-interim.md)).
4. **Orders and sales:** two tiles, from `form_responses`.
5. **Needs a look:** a banner when submissions had answers that didn't match the menu.
6. **What to make:** sizes with units add up ("Palak Paneer — 56 oz (5× 8oz, 1× 16oz)"). S/M/L and Half/Full are counted, and plain dishes are a count.
7. **Orders:** name, time, items, area, note, total, and a **remove** link for test orders.
8. **Connect WhatsForm (one time):** the Custom Script line (`/wf.js`) and the private webhook URL.

**Products tab:** her dishes with sizes, **Edit**, and **+ Add dish**.
- The add form has a name field and six size + price rows. For a single price, she fills in only the price and it becomes "each".
- Duplicate names and bad prices are refused. Remove asks first and is soft (old menus keep the dish).
- The numbers match `/menu 1,2,3` on WhatsApp.

## Plain chat: dishes and the daily menu

She types normally, no commands to remember. Every change ends in a preview with buttons, and nothing is saved or published before she taps.

| She types | What happens |
|---|---|
| `add samosa 2 each`, `dal 8oz 6, 16oz 10`, `new dish aloo gobi small 6 large 10` | Save / Cancel preview. A dish she already has keeps the sizes she didn't mention |
| `dal 16oz is 11 now`, `paneer large ka price 13 kar do` | Edit preview with "replaces …" |
| `we don't make chole any more` | Remove / Keep |
| `today dal, paneer and roti`, `today 1 3 5`, `tomorrow dal (16oz), roti cutoff 11` | Menu preview → Publish → form lines + broadcast |
| `add kheer`, `no roti`, `only the big dal`, `cutoff 11` | Changes the menu she's working on and shows a new preview |
| `same as yesterday`, `same as Monday but no rice, add kheer` | Copies an earlier menu at today's prices; dishes no longer on her list are left out and named |
| `kitna banana hai`, `who ordered`, `message to forward` | Same as `/what`, `/orders`, `/message` |

**How it's read** (`src/flows/ownerChat.ts`):
1. Exact command words (`/how`, `ORDERS`, `/add-product …`) run as before.
2. Strict code rules (`src/domain/ownerRules.ts`): `today <dishes>`, `same as <day>`, `cutoff <time>`, dish lines with prices. Any doubt goes to the model.
3. The model (`llm.interpretOwner`, prompt `OWNER_SYSTEM`) picks one action and refers to dishes by their number in her list and to sizes by their exact labels. Code resolves both and lists anything it can't match back to her. Prices must appear in her message (or be the size's current price, for edits).
4. "The menu she's working on" is the draft from her last preview (kv `owner_ctx:<phone>`, 2 hours, cleared on Publish), else the next menu from today on.
5. Cutoff on a draft: new preview. On a published menu: changed in place (it may already have orders), then `/message` gives the updated broadcast.

**Morning nudge** (`src/jobs/menuNudge.ts`, every minute from the worker): on a kitchen day, in the 3 hours after `MENU_EXPECTED_BY`, with no menu (not even a draft) for today, each owner gets "What's on today? Last time (Mon): …" with **Same as Mon** and **Show my dishes**. Once a day, and only if her 24-hour window is open (no template). She may often be outside the window (her last message was yesterday morning), so in practice it fires on days she has already messaged the bot.

**Real-model check:** `pnpm test:owner` runs `test/fixtures/owner-messages.json` (English and Hinglish phrasings) against the model in `.env`.

## WhatsApp commands

`/help` shows the plain-chat examples above, then these read-only commands:

| Command | Reply |
|---|---|
| `/how` | Today at a glance: orders, sales, menu, whether the form link is saved, orders that need a look |
| `/what` | What to make, same as the page |
| `/orders` | Today's orders, numbered, with a total |
| `/message` | Today's broadcast with the form link filled in, ready to forward |
| `/app` | The kitchen page link |

The slash is optional (`what` = `/what`).

The older command forms still work (`/help all` lists everything):

| Command | What it does |
|---|---|
| `/products` | The numbered product list |
| `/add-product Dal 8oz 6, 16oz 10` | Add a dish (one per line). Preview → Save |
| `/edit-product 3 …` | Change a dish's sizes or prices |
| `/remove-product 3` | Take a dish off the list |
| `/menu 1,2,3 [cutoff 11am]` / `/menu tomorrow: dal, roti` | Draft a menu → Publish → form lines and broadcast |
| `/link <url>` | Save the order form link (once; it goes into every broadcast) |

**How dish text is read:** a strict code parser first (`parseProductLine`). Only if it fails does the model read it (`llm.parseProducts`). Any price the model returns must appear in her text. Nothing is saved before she taps Save.

## Orders from WhatsForm (webhook)

1. **Connect:** on the Today tab, open **Connect WhatsForm** for the URL `/webhooks/whatsform/<token>` (the token is derived from `ADMIN_SECRET`; a GET on the URL answers "OK" for checking).
2. **In WhatsForm:** the order form → Settings → Integrations → Webhook → POST → that URL. The "Your order" answer is read as order text (our script's format, or typed); older one-number-per-dish questions ("Dal – 8oz – $6") still match too.
3. **What the app does with each submission** (`src/flows/formOrders.ts`, `src/domain/formOrders.ts`):
   - **Answers become order lines:** keys are matched to the day's menu lines (`Dal – 8oz – $6`, `Dal – 8oz`, or `Dal 8oz`, normalized), and number answers become lines.
   - **Prices come from the menu in code;** the form's own Total is ignored.
   - **Customer details:** name, phone, area, address and note are picked up by key. The customer is saved to `customers`, filling only empty fields.
   - **Unknown answers are kept, not dropped:** an answer that matches nothing (e.g. a renamed question) is stored in `unmatched` and flagged on the page.
   - **Redeliveries:** deduped on WhatsForm's response number, or a hash of the body.
   - **Which menu:** the submission is attached to today's menu (or the latest published one).
4. **Unverified:** WhatsForm's real payload shape. After the first real submission, check `select raw, lines_json, unmatched from form_responses order by id desc limit 1` and adjust the parser if needed.

## Deployment (as running)

| | |
|---|---|
| App | Railway project `preppr`, service `preppr` → `https://preppr-production.up.railway.app` |
| DB | Neon project `preppr`, branch `main` (pooled URL in `DATABASE_URL`) |
| WhatsApp | Meta app `887855374352099` in the kitchen's business portfolio; test number +1 555-178-8619 |
| Model | Groq `openai/gpt-oss-120b` (`LLM_PROVIDER=openai`, `LLM_BASE_URL=https://api.groq.com/openai/v1`) |

Variables, as in `.env.assistant`, which is gitignored:
- **WhatsApp:** `WA_PROVIDER=meta`, `WA_TOKEN`, `WA_PHONE_NUMBER_ID`, `WA_APP_SECRET`, `WA_VERIFY_TOKEN`, `BOT_NUMBER`, `WA_DRY_RUN=0`
- **People:** `OWNER_NUMBERS`
- **Mode:** `OWNER_ONLY=1`, `ORDER_CHANNEL=whatsform`, `BOT_MODE=live`
- **Model:** `LLM_PROVIDER`, `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`
- **Kitchen:** `KITCHEN_NAME`, `TZ`, `CUTOFF_TIME`, `AREAS` (required by config, unused here)
- **Set directly in Railway:** `DATABASE_URL`, `JOB_SECRET`, `ADMIN_SECRET`, `PUBLIC_URL`

### Operations

- **Change variables:** edit `.env.assistant`, run `sh scripts/railway-push-env.sh` (values go through stdin and are never printed), then `railway up --ci`. **Don't use `railway redeploy`**: it re-runs the previous deployment with the old variables.
- **Logs:** `railway logs`. Health: `/healthz`.
- **Renew the WhatsApp token** (expires **2027-01-06**). Either:
  - set up a system user properly (see below), or
  - take a fresh temporary token from API Setup, put it in `WA_TOKEN`, and exchange it for a 60-day one: `GET /oauth/access_token?grant_type=fb_exchange_token&client_id=<app id>&client_secret=<app secret>&fb_exchange_token=<token>`. Push it, then `railway up`.
- **Permanent token (system user):** in the kitchen's Business Settings:
  1. **System users** → Add (Admin).
  2. **Assign assets:** the app (**Full control**) and the WhatsApp account (Full control).
  3. **Generate token:** expiry Never, with `whatsapp_business_messaging` and `whatsapp_business_management`.

  "No permissions available" means the app isn't assigned to the system user, or isn't owned by the business (Accounts → Apps → Connect an app ID).

### Setting up a new test number or app (lessons from today)

1. **Create the app under the kitchen's business portfolio**, not ours. Ours got locked (Meta error 131031, "Business Account locked").
2. **Verify the "To" numbers** (API Setup → To → Manage phone number list). These are the only numbers that can use a test number.
3. **Set the webhook** (WhatsApp → Configuration): callback `…/webhook`, the verify token, and subscribe **messages**.
4. **Subscribe the WhatsApp account to the app.** API Setup doesn't always do this, and without it nothing arrives:
   - check: `GET /<waba id>/subscribed_apps` must list our app
   - fix: `POST /<waba id>/subscribed_apps` with the token
5. **After changing the app secret,** deploy with `railway up`. If the logs show `webhook rejected: bad signature`, the running app has an old `WA_APP_SECRET`, or another app is still posting to our URL.

## Smoke test

From an owner number:
1. On WhatsApp: `add dal 8oz 6, 16oz 10` → Save, `add roti 1 each` → Save, `paneer tikka S 5 M 8 L 12` → Save. `/products` lists 3.
2. `today dal, roti` → preview; `add paneer large` → new preview; `cutoff 11` → new preview; Publish. Check the broadcast. `/link <url>`, then open the form link: it shows the menu. On `/app`, Today shows the same menu with the form link saved.
3. Next day: `same as yesterday but no roti` → preview without Roti.
4. Submit a test order through the WhatsForm form (or POST to the webhook URL). Check the Today tab, `/how`, `/what` and `/orders`.
5. From a phone not in `OWNER_NUMBERS`: message the test number. It should get no reply.
6. `railway up` again, then check `/app` → Products still lists everything (the data is in Neon).
