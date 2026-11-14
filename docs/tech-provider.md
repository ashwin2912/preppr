# Becoming a Meta Tech Provider (WhatsApp)

Why: Meta only lets a business onboard an existing WhatsApp Business app number (coexistence) through **Embedded Signup**, run by a Tech Provider or a Solution Partner (BSP). Becoming a Tech Provider ourselves means direct Cloud API, no per-number fee, and the same path self-serve signup needs later (`deployment-plan.md` §5.2). The alternative is 360dialog's hosted signup (`360dialog.md`), which is already built and works today, for a monthly fee per number.

Status (2026-11-14): code for step 7 built and tested with fakes (see below); dashboard steps (1, 3, 5, 6) not started, the user does them next; verification later. Steps below are from Meta's pages read on 2026-11-14 (sources at the end). Meta's dashboards move often; if a menu item has moved, follow the current page.

## Instructions for the Claude Code session doing this

The user gives you Chrome (Claude in Chrome) logged into Facebook. You drive Meta's dashboards; the user does anything that is identity, legal or a secret.

**Start:**
1. Load the browser tools in one ToolSearch call (see the system prompt), call `tabs_context_mcp`, work in a new tab.
2. Read this whole file, then `docs/meta-setup.md` (how the current app was set up) and `docs/coexistence-setup.md` ("Onboarding the number").
3. Ask the user the **open decisions** below before clicking anything.
4. Keep a checklist in this file: tick steps under "Progress" as they finish, with the date. Commit only if the user asks.

**The user does, not you (stop and hand over):**
- Logging in, passwords, 2FA codes, security checkups.
- Accepting terms, platform policies, data-processing or legal attestations (read them the summary, let them click).
- Business verification identity: legal name, registration documents, ID uploads, phone/email/domain confirmation codes.
- Recording the App Review videos (screen recordings; you can't make video). Write them the exact script (step 4).
- Paying: adding cards.
- Anything that sends a message to a real customer or the kitchen owner.

**You can do:** navigate, read pages, fill non-legal settings (app name, icon upload from a file they give you, category, URLs, OAuth toggles, allowed domains, webhook fields), create the Embedded Signup configuration, draft App Review written explanations, and build the code (step 7).

**Never:**
- Put tokens, app secrets, config ids with secrets, or the user's personal details into this file, a commit, or a chat outside this session. Non-secret ids (app id, config id, WABA id, phone number id) can go in `.env.assistant`. Secrets (app secret, access tokens) go only into `.env.assistant` / Railway variables via `sh scripts/railway-push-env.sh`, never echoed.
- Delete or change the **existing** app, WABA, phone numbers, webhook or system user that production uses (`preppr-production.up.railway.app`, `WA_PROVIDER=meta`, test number). Production must keep working the whole time. Create new things beside them.
- Submit App Review or business verification without the user confirming the final screen.
- Trigger browser dialogs (see system prompt); if a page asks to confirm with a dialog, ask the user to click it.

If a page is stuck, errors twice, or asks for something not in this file, stop and ask.

## Open decisions (ask first)

1. **Whose business portfolio.** The Tech Provider is *us* (Preppr's business), not the kitchen. Today the kitchen owner owns the portfolio and app; we're admins (`meta-setup.md`). Options:
   - (a) **New portfolio for our business + new app** in it (clean; recommended). The kitchen's portfolio stays as the client.
   - (b) Use an existing portfolio of ours if the user already has one (check Business Settings for portfolios they own).
2. **Legal entity and website** for verification: which company name, address, phone, and a website on our own domain whose name matches. Verification fails on mismatches.
3. **Privacy policy URL.** The app has none yet. Either the user has one on the company site, or build `/privacy` in this app (short page: what we store: customer name, phone, address, orders, messages; why; retention; contact email; deletion requests). Needs the contact email from the user.
4. **App icon**: 1024×1024 PNG from the user.
5. **Domain for the signup page**: `preppr-production.up.railway.app` for now, or a custom domain.

## Steps

### 1. App with the WhatsApp use case
- In the chosen portfolio: developers.facebook.com → My Apps → Create app → use case **Connect with customers through WhatsApp** → link the portfolio.
- App Dashboard → Use cases → WhatsApp → Customize → **Tech Provider onboarding** (left menu). This page lists the steps. Choose **Onboard without a partner**.

### 2. Business verification
- From the Tech Provider onboarding page: **Start verification**. Needs business name, address, phone, email, website, and a way for Meta to contact us; documents if Meta can't find the business. (User fills; you can navigate.)
- App Review can't start until this is verified. No timeline published; expect days to a couple of weeks. Do steps 5–7 meanwhile.

### 3. App settings
App settings → Basic: app icon, privacy policy URL, category (e.g. Business and pages / Messaging). Also fill any other required field the dashboard flags (data deletion instructions URL, contact email) — the docs don't list them, the dashboard does.

### 4. App Review (after verification)
Request **Advanced access** for exactly two permissions; nothing else (extra permissions are a common rejection reason):

| Permission | Written explanation (draft, adjust) | Video (one per permission, no screenshots) |
|---|---|---|
| `whatsapp_business_messaging` | Preppr is an ordering assistant for home kitchens. It sends order confirmations, the daily menu and replies to customers on the kitchen's own WhatsApp number, on the kitchen's behalf. | Send a message to a test recipient and show it arriving in WhatsApp (phone or web). Accepted: the API Setup page's cURL send in the App Dashboard. |
| `whatsapp_business_management` | We read the kitchen's WhatsApp account and phone number after Embedded Signup, subscribe our webhook to it, and create the utility template `daily_order_open` for its daily menu message. | Create a message template, in our app or in WhatsApp Manager. |

Video script for the user (QuickTime → New Screen Recording, ~1 min each): show the App Dashboard with the app name visible → do the action → show the result (message on the phone / template in the list). Upload, then **Begin App Review** → submit. Drafts aren't reviewed. Average turnaround about 24 hours. If rejected, read the reason, fix only that, resubmit.

### 5. Facebook Login for Business (Embedded Signup config)
- Facebook Login for Business → Settings → Client OAuth settings: **Yes** for Client OAuth login, Web OAuth login, Enforce HTTPS, Embedded Browser OAuth Login, Use Strict Mode for redirect URIs, Login with the JavaScript SDK.
- Add the signup domain (HTTPS only) to **Allowed domains** and **Valid OAuth redirect URIs**.
- Configurations → Create from template → **WhatsApp Embedded Signup Configuration With 60 Expiration Token**. Tick only WhatsApp assets (no catalogs, pages, ads).
- Save the **configuration id** → `.env.assistant` as `ES_CONFIG_ID` (not secret). App id → `META_APP_ID`.

### 6. Webhooks
App Dashboard → WhatsApp → Configuration: callback `https://<domain>/webhooks/whatsapp`, verify token from `.env.assistant`. Subscribe fields: `messages`, `account_update`, `history`, `smb_app_state_sync`, `smb_message_echoes`. Verify token: the same `WA_VERIFY_TOKEN` production uses, so the GET check passes without changes. The new app's **app secret** goes into `.env.assistant` as `ES_APP_SECRET` (the user pastes it; never into chat). The server accepts webhook signatures from either `WA_APP_SECRET` or `ES_APP_SECRET`, so there's no secret swap on onboarding day, and uses `ES_APP_SECRET` for the signup code exchange.

### 7. Build the Embedded Signup page (code) — built 2026-11-14
Built in `src/signup/routes.ts` (tests: `test/signup.test.ts`). On when `META_APP_ID`, `ES_CONFIG_ID`, `PUBLIC_URL` and `ADMIN_SECRET` are set (plus `ES_APP_SECRET` for a separate app). Owner (or we, on a test kitchen) opens the kitchen page → **Connect WhatsApp (one time)** card → 12-hour `/signup?t=` link. `/signup` has its own CSP (nonce + `connect.facebook.net`, `*.facebook.com` frames); `/signup/complete` swaps the code (Graph `ES_GRAPH_VERSION`, default v27.0), calls `subscribed_apps`, stores ids in kv `signup:<phone_number_id>` with the business token **sealed** (AES-GCM, key from `ADMIN_SECRET`), and messages the owner. `pnpm wa:signup:env --file .env.assistant [phone_number_id]` writes `WA_TOKEN`, `WA_WABA_ID`, `WA_PHONE_NUMBER_ID` into the env file without printing the token, then `sh scripts/railway-push-env.sh` on onboarding day.

Original notes (still the reference):
Can start before App Review: anyone with a role on the app (App roles → Roles) can run it with standard access.
- Route on the kitchen side, e.g. `GET /admin/connect` (owner-only, behind the kitchen cookie). Loads `https://connect.facebook.net/en_US/sdk.js` — needs its own CSP (script-src for that host, frame-src/connect-src facebook.com); keep the rest of the app's strict CSP unchanged.
- `FB.init({ appId, version: '<latest Graph version, v27.0 when read>' })`, then `FB.login(cb, { config_id, response_type: 'code', override_default_response_type: true, extras: { setup: {} } })`. **Embedded Signup v5: coexistence ("connect existing WhatsApp Business app") is on by default**; no `featureType` needed. (v2/v3 were turned off 2026-10-15.)
- Listen for `window` `message` events from a `facebook.com` origin with `type: 'WA_EMBEDDED_SIGNUP'`: `FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING` (coexistence) gives `waba_id` and `phone_number_id`; `CANCEL` gives `current_step`; `ERROR` gives a message. Closing the popup on the last screen counts as done.
- POST the `code` to the server **immediately** (it lives 30 seconds): exchange for a business token (`/oauth/access_token` with app id + secret), then `POST /<waba_id>/subscribed_apps`. Coexistence numbers skip `/register`.
- Single kitchen today: show the ids and store the token as a secret (Railway variable), not in the DB in plain text. Multi-tenant storage is Stage 3.
- Tests with fakes like the rest (`test/helpers.ts`); never call Meta from tests.

### 8. Onboarding day (with the kitchen owner)
Checklist in `coexistence-setup.md` "Before onboarding" / "Onboarding day". Key points: WhatsApp Business **2.24.17+**, companion devices (WhatsApp Web/desktop) get unlinked, **within 24 h** run `pnpm wa:sync` (contacts and history, once each), owner adds a card in WhatsApp Manager. Coexistence numbers are fixed at 20 messages/second.

## Progress

- [ ] Open decisions answered
- [ ] 1. App created, Tech Provider onboarding page open
- [ ] 2. Business verification submitted / verified
- [ ] 3. App settings complete
- [ ] 4. App Review submitted / approved
- [ ] 5. Embedded Signup configuration created
- [ ] 6. Webhooks subscribed
- [x] 7a. Signup page built, tested with fakes (2026-11-14)
- [ ] 7b. Signup page tested for real by an app tester (needs steps 1, 5, 6, deploy, and a test WhatsApp Business app number, not the kitchen's)
- [ ] 8. Kitchen onboarded

## Sources
- [Become a Tech Provider](https://developers.facebook.com/documentation/business-messaging/whatsapp/solution-providers/get-started-for-tech-providers)
- [App Review for Tech Providers](https://developers.facebook.com/documentation/business-messaging/whatsapp/solution-providers/app-review)
- [Embedded Signup implementation](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/implementation.md)
- [Onboard WhatsApp Business app users (coexistence)](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users.md)
