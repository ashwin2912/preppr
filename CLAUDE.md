# Preppr

WhatsApp ordering bot for small home kitchens (tiffin services). Customers order in plain chat on the kitchen's existing WhatsApp Business number, connected to the Cloud API through coexistence (the owner keeps the Business app); the owner runs the day with WhatsApp commands from a personal number; at cutoff the kitchen gets totals and a delivery list. Single kitchen per deployment today. README.md has the product overview; docs/ has setup guides and the deployment plan.

## Commands

```sh
pnpm install
pnpm test            # vitest: flows, payments, reliability, sheet, alerts, admin, rules parser (PGlite, fake WhatsApp, fake parser)
pnpm typecheck       # tsc --noEmit (includes test/)
pnpm build           # tsup → dist/index.js
pnpm simulate        # full fake day printed to stdout; uses a real model if LLM env is set
pnpm test:parser     # real-model eval on test/fixtures/orders.json (costs money; needs a working LLM in .env)
pnpm test:owner      # real-model eval of owner chat on test/fixtures/owner-messages.json (same)
pnpm dev             # local server; no DATABASE_URL = in-memory PGlite (data lost on restart)
pnpm db:generate     # after editing src/db/schema.ts; commit the new drizzle/ files
pnpm import:customers <contacts.vcf|customers.csv> [--dry-run]
pnpm import:chat-export <file.txt|folder> [--fixtures out.json]
pnpm orders:from-backup [--check] [--backup dir] [--date d] [--no-open]  # orders from an iPhone backup (dev run)
pnpm build:mac       # bun --compile → dist/preppr-orders-{arm64,x64} (single-file Mac tool, ad-hoc signed)
pnpm wa:sync [--from-db|file.json]  # coexistence history/contacts: meta = request from Meta (24 h); --from-db = replay raw_webhooks; file = 360dialog Hub download
pnpm wa:webhook:set  # d360: set webhook URL + X-Preppr-Secret header, poll until applied
pnpm wa:templates:sync  # create daily_order_open (utility) if missing, print status
pnpm wa:check        # key, webhook, template, DB, last inbound: PASS/FAIL/N/A
```

Before committing: `pnpm typecheck && pnpm test && pnpm build`. The default `.env` LLM may be a retired free model; for `simulate` without a model run `LLM_PROVIDER=anthropic ANTHROPIC_API_KEY= pnpm simulate`.

## Architecture (where things live)

- `src/app.ts`: Hono routes `/webhook` + `/webhooks/whatsapp` (verify per provider, store raw body, 200), `/jobs/cutoff` + `/internal/cutoff` (Bearer), `/healthz`, `/readyz`, `/health`, `/admin/*`. Creates the worker.
- `src/wa/provider/`: `WA_PROVIDER=meta|d360` (docs/360dialog.md). `createProvider(cfg)` (send, read, key/webhook/template ops for `pnpm wa:*`), `verifyInbound` (Meta HMAC, or 360dialog `X-Preppr-Secret`). Error mapping in `src/wa/errors.ts`.
- Inbound: webhook → `raw_webhooks` (body as received, deduped) → worker → `src/wa/normalize.ts` (`normalizeInbound`, detects Meta `entry/changes` vs 360dialog `{id,event,data}` by shape) → `applyEvents` in `src/flows/router.ts` (inbox, statuses, echoes, history, contacts, history_declined, unknown = kept + alerted). Tests: `h.post` also runs this step (`worker.ingest()`); `h.postRaw` doesn't. Fixtures: `test/fixtures/webhooks/`.
- `src/flows/router.ts`: `storeWebhook` / `processWebhook` / `applyEvents` and `handleInbound` (worker side: messages row, rate limit, route to owner / onboarding / customer).
- Rollout: `BOT_MODE=shadow|assist|live` and the owner's `BOT OFF`/`BOT ON` (kv `bot:off`) are enforced in one place, `enqueue` in `src/wa/send.ts` (`replyAllowed`): blocked customer sends are stored with outbox status `suppressed` (REVIEW, viewer). In assist, handlers mark safe sends with `ctx.assist` (confident order summary, confirm/change flow). Owner/operator numbers are always allowed. `src/flows/review.ts`: BOT, REVIEW, held-reply ping, summary banner.
- `src/jobs/worker.ts` + `queue.ts`: in-process worker draining `raw_webhooks` (in order), `inbox` and `outbox`. Claims one row per phone/recipient under a short advisory lock; leases (2 min) recover from crashes. Also runs periodic tasks (watchdog 60 s, menu nudge 60 s, sheet sync 30 s) from the start loop only.
- `src/wa/send.ts`: `send()` is the only way to send free-form messages. Checks the 24 h window, then inserts into `outbox` with an idempotency key `<ctx.out.prefix>:<n>` (or an explicit key). `sendTemplate()` is the only path outside the window (approved templates). Never call `wa.send` directly from flows.
- Coexistence (`WA_COEXISTENCE=1`, `docs/coexistence-setup.md`), the target setup; the separate-bot-number mode (flag off) still works but isn't planned: bot shares the owner's WhatsApp Business app number. `src/flows/coexistence.ts` handles webhook fields `smb_message_echoes` (owner typed in the app → pause bot for that customer), `history`, `smb_app_state_sync` (→ `wa_contacts`); `enqueuePayload` only routes field `messages`. Unknown numbers get no reply unless they ask to order (`UNKNOWN_SENDERS`). `src/jobs/menuPush.ts` replaces broadcast lists: menu text in-window, utility template outside it, opted-in customers only (`customers.menu_opt_in`).
- `src/flows/customer.ts`: ordering. Parse order: `ruleInterpret` (`src/llm/rules.ts`, strict code parser) first, model only when it returns null. Model failure throws `ParserUnavailable` → worker retries → owner gets the message.
- `src/flows/owner.ts`: owner commands (MENU, SUMMARY, ORDERS, CLOSE, OPEN, RESUME, BOT OFF/ON, REVIEW, PAID, VERIFY, PENDING, BALANCE, DUES, BLOCK, ADD, NAME, AREA, NOTE, CHATS, OPTIN, OPTOUT) and shared contact cards.
- `src/flows/ownerChat.ts`: owner's plain chat for dishes and menus ("today dal, roti", "same as yesterday but no rice", "dal 16oz is 11", "cutoff 11"). Command words first, then `ruleOwner` (`src/domain/ownerRules.ts`, strict), then `llm.interpretOwner` (dish numbers + size labels only; resolved in code, prices checked against her text). Every change goes through a Save/Publish preview. Working draft: kv `owner_ctx:<phone>`. `src/jobs/menuNudge.ts`: morning "what's on today?" to owners, in-window only. Eval: `pnpm test:owner`.
- `src/flows/catalog.ts` + `src/domain/products.ts`: product list and menu-from-products commands. Product text: strict `parseProductLine` first, `llm.parseProducts` only when it returns null; model prices must appear in the owner's text (`cleanParsedProducts`); nothing saved before the owner taps Save (drafts in kv). Catalog menus store one `MenuItem` per product+size (`product_id`, `size`). `src/flows/menuDraft.ts`: draft + Publish/Edit preview shared with free-text MENU (used when the product list is empty).
- `src/flows/payments.ts`, `src/domain/ledger.ts`: balance = confirmed orders − verified payments.
- `src/flows/onboarding.ts`: only for unknown numbers (`needsOnboarding = !customer`).
- `src/jobs/cutoff.ts`, `watchdog.ts` (also no_inbound, send_failures, app_idle → `notifyOps` = Sentry + WhatsApp to `OPERATOR_NUMBERS`; `healthReport` for `/health`), `sheetSync.ts`; `src/ops/checks.ts` (`wa:check`); `src/sheets/client.ts` (Sheets REST + service-account JWT, no SDK).
- `src/backup/*` + `scripts/backup-orders.ts`: Mac tool `preppr-orders` (docs/backup-orders.md). Reads WhatsApp Business chats from the owner's iPhone backup (decrypts with node:crypto, bplist parser, `sqlite.ts` = bun:sqlite or node:sqlite), feeds `src/domain/exportOrders.ts` (`OrderInput` → `extractFromInputs`, shared with chat exports), writes CSVs. Keep it free of db/flows imports so the Bun binary stays small. Installer: `deploy/mac/install.sh`.
- `src/admin/*`: read-only chat viewer behind an HMAC link from the CHATS command; `src/admin/kitchen.ts` = owner's kitchen page at `/admin/kitchen` (dishes CRUD, publish a menu from ticked sizes, broadcast + permanent form link, Custom Script + webhook setup), link from the APP command (30-day token, same cookie). Tabs: Today (menu first, then orders/sales/what-to-make from `dayOrders`, broadcast), Products, and Customers (devices, .vcf/.csv import). Forms POST; Lax cookie + Sec-Fetch-Site/Origin check.
- `src/flows/formMenu.ts` + `formScript.ts`: one permanent WhatsForm. Its Custom Script loads `/wf.js`, which reads `GET /public/menu.json` (`orderableMenu`: earliest active menu ≥ today before cutoff; no customer data, CORS *) and fills the form's "Your order" text question. Form link saved once (kv `form_link`, `/link`).
- `src/flows/formOrders.ts` + `src/domain/formOrders.ts`: WhatsForm webhook `/webhooks/whatsform/<token>` → `form_responses` ("Your order" read by `parseOrderText`: script format, then strict `ruleInterpret`; legacy per-dish keys still matched; priced in code, customer upserted, unmatched flagged); `prepTotals` adds up unit sizes (oz/ml/g). Payload shape not yet seen for real.
- `src/flows/orderPage.ts` + `src/domain/orderPage.ts`: customer order page `/order` (docs/order-page.md). One shared link; first order sets a random device cookie (`customer_devices`, sha256 only), later visits prefilled; a known number on a new browser sees masked details, its order is flagged and can't replace an existing one. Orders go into `orders` (`source = 'page'`), priced with `priceLines`; owner pinged per change via `send()`. `src/flows/dayOrders.ts`: owner views (kitchen page, `/how /what /orders`) over `orders` + `form_responses`. `ORDER_CHANNEL=page` puts the `/order` link in broadcasts. Shared POST checks in `src/admin/http.ts`, in-memory limits in `src/lib/rateLimit.ts`. Kitchen-page menu saves after orders keep item ids (`keepItemIds`) and refuse dropping/repricing ordered dishes.
- `src/db/schema.ts`: Drizzle schema; migrations in `drizzle/` run at startup.

## Rules that matter

- **Money is computed in code**, never by the model: the model returns item ids and quantities only (`priceLines`, `orderTotal` in `src/domain/order.ts`).
- **The rules parser must stay strict**: any doubt returns null so the model decides. `test/rules.test.ts` checks it never contradicts a fixture it answers; keep that passing when adding patterns.
- **All time comes from `ctx.now()` / `deps.now()`** (tests use a fake clock). Don't use `new Date()` in flows or jobs, except the worker's periodic scheduling.
- **Outbound sends are queued**; tests must `await h.drain()` before checking `h.wa.sent`.
- **Handlers can run more than once** (retries, crash recovery): keep writes idempotent (upserts, unique keys, `onConflictDoNothing`), and send via `send()` so idempotency keys dedupe replies.
- **Customer-supplied text is untrusted**: HTML-escape in `src/admin/routes.ts` (`esc`), write RAW to Sheets, never put message bodies into Sentry (`src/lib/sentry.ts` drops body/raw/text).
- **The 24 h customer-service window** is enforced in `send()`. The only template is the coexistence menu push (`daily_order_open`, utility). Meta blocks marketing templates to US numbers, so never put dishes, prices or promotions in a template.
- Schema changes: edit `src/db/schema.ts`, `pnpm db:generate`, commit the SQL and `drizzle/meta`. Don't hand-edit applied migrations.
- Tests use the `harness()` in `test/helpers.ts` (PGlite, `DryRunWaClient`, `FakeLlm`, fake clock, worker concurrency 1). Use `vi.mock` for failure injection, as in `test/reliability.test.ts`.
- Match the surrounding style: small modules, plain functions, short doc comments on exported functions, no classes except clients.

## Docs

- `docs/README.md`: start here: what's running for the kitchen now, where data lives, backlog.
- `docs/360dialog.md`: verified 360dialog endpoints, envelopes, sandbox limits, differences from Meta.
- `docs/deploy.md`: step-by-step go-live (prod compose, tunnel, Neon, wa:* scripts, cron, smoke test). `docs/runbook.md`: BOT OFF, webhook stopped, key rotated, history missing, restore, shadow → live.
- `docs/backup-orders.md`: Mac tool for orders from the iPhone backup: owner steps, hosting, `--check`, troubleshooting.
- `docs/pilot-cloudflare.md`: pilot on one machine (laptop now, VPS later): `deploy/pilot/` has the Compose file (app + cloudflared) and the cutoff cron Worker.
- `docs/deployment-plan.md`: how to deploy one kitchen, and how to productize for many.
- `docs/production-readiness.md`: launch checklist and status.
- `docs/owner-assistant.md`: owner-only menu assistant for the WhatsForm flow (commands, setup on a test number, smoke test). `docs/whatsform-interim.md`: the WhatsForm stopgap itself. `docs/order-page.md`: our own `/order` page that replaces it.
- `docs/coexistence-setup.md`: bot on the owner's existing number (current plan for the first kitchen): behavior, menu template, onboarding, smoke test.
- `docs/meta-setup.md`, `docs/google-sheet-setup.md`, `docs/monitoring.md` (alerts + runbook), `docs/owner-setup.md` (for the kitchen owner).
- `system-design.md`: original architecture and laptop setup (partly superseded by the inbox/outbox design in README "Design notes").

## Status (2026-11-12)

- **Order page built (branch `order-page`)**, tested with the harness; not yet deployed or tried on a real phone. Switch-over steps: docs/order-page.md.

## Status (2026-11-07)

- **Interim: WhatsForm for order capture** while the bot is built (`docs/whatsform-interim.md`). Owner broadcasts a per-day form (one number question per dish+size), orders land in a Google Sheet; totals per dish are v2.
- **Owner assistant + kitchen page: deployed (2026-11-07)** on Railway (`preppr-production.up.railway.app`), Neon `preppr`/`main`, Groq model, Meta test number in the kitchen's business portfolio. `OWNER_ONLY=1`, `ORDER_CHANNEL=whatsform`. Owner uses the kitchen page (`/app`) for dishes and the daily menu, and `/how` `/what` `/orders` `/message` on WhatsApp. WhatsForm orders arrive by webhook into `form_responses` (payload shape not yet verified with a real submission). What's running, where data lives and the backlog: `docs/README.md`. Variables: `.env.assistant` → `sh scripts/railway-push-env.sh` → `railway up` (never `railway redeploy`).

- **Plan: staging kitchen before the real phone** (docs/deploy.md "Staging"). A number we own runs in the WhatsApp Business app, is onboarded to 360dialog with coexistence (our account), and has its own `.env.staging`, Neon branch and tunnel. Every script and the prod compose read `$ENV_FILE` when set. Use it to rehearse switch-over, capture real coexistence payloads into fixtures, and get kitchen feedback.

## Status (2026-11-05)

- **360dialog provider built (2026-11-05)**, tested with fakes and fixtures; not yet run against the sandbox or the real number. Voice-note/image download + transcription is backlog (docs/production-readiness.md). Echo and template sync can't be tested on the sandbox; check them on onboarding day. History for direct 360dialog clients likely comes from the Hub, not our webhook: check the real file with `pnpm wa:sync <file>`.

## Status (2026-10-28)

- **Built and tested (fakes):** ordering flows, owner commands, payments/ledger, cutoff, watchdog alerts, delivery statuses, Sheet sync, chat viewer, contact import, chat-export import.
- **Stage 0 pilot, first kitchen: in progress.**
  - Hosting decided: laptop now, small VPS later, same `deploy/pilot/docker-compose.yml` (app + `cloudflared` named tunnel), Neon free tier, cutoff via Cloudflare Worker cron (`deploy/pilot/cutoff-cron`). App can't run on Cloudflare Workers/Containers (long-running worker), so Cloudflare is only tunnel + cron.
  - Pilot files checked: Compose config valid, Worker bundles (`wrangler deploy --dry-run`), app endpoints and cutoff auth checked with `node dist/index.js`. Not yet run under Docker or against Meta.
  - Meta: the kitchen owner owns the business portfolio and WABA; we are invited as admin and do the app, system-user token and webhook. Week 1 on Meta's test number (owner + up to 4 customers). Owner instructions were sent as WhatsApp messages (not in the repo).
  - **Number (decided 2026-10-28): coexistence on the owner's existing WhatsApp Business number**, so customers and history stay in one chat. Owner commands come from the owner's personal number. Code built and tested with fakes (`test/coexistence.test.ts`). Not yet tried against a real coexistence number.
  - Onboarding path still open: become a Tech Provider (Embedded Signup page not built yet) or use a BSP (`WA_API_URL`, `WA_AUTH_HEADER`).
- **Next:** owner finishes portfolio + verification + admin invite; buy domain on Cloudflare, create tunnel, Neon project, fill `.env`; run the Compose stack on the laptop; webhook on test number; smoke test (`docs/pilot-cloudflare.md` step 9). Then: choose Tech Provider or BSP, submit the `daily_order_open` utility template, onboard the owner's number, `pnpm wa:sync` within 24 h, coexistence smoke test (`docs/coexistence-setup.md`).

## Open items

- `preppr-orders` (iPhone backup tool) tested only on a synthetic backup; confirm domain, ChatStorage columns, `@lid` share and message types with `--check` on the owner's Mac. Binaries need a public host (`PREPPR_BASE_URL` in `deploy/mac/install.sh`).
- Parser not yet evaluated on real customer messages (collect with `pnpm import:chat-export --fixtures`, or from the coexistence history sync: `messages.source = 'history'`).
- Coexistence webhook payload shapes (`message_echoes`, `history`, `state_sync`) are from Meta/BSP docs, parsed loosely; check them against real payloads on onboarding day.
- Not yet deployed with a permanent database; the Sheet and Sentry integrations are tested only against fakes/mocks.
- `docs/deployment-plan.md` refers to a README "How to test" checklist that doesn't exist; the pilot smoke list is in `docs/pilot-cloudflare.md`.
- CI runs tests on PGlite only; a real-Postgres CI job is still to add.
- Migrations run at startup on every instance; for multi-instance deploys run `pnpm db:migrate` as a separate step (see deployment plan).
