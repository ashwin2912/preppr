# Preppr

WhatsApp ordering bot for small home kitchens (tiffin services). Customers order in plain chat on a dedicated bot number (WhatsApp Cloud API); the owner runs the day with WhatsApp commands; at cutoff the kitchen gets totals and a delivery list. Single kitchen per deployment today. README.md has the product overview; docs/ has setup guides and the deployment plan.

## Commands

```sh
pnpm install
pnpm test            # vitest: flows, payments, reliability, sheet, alerts, admin, rules parser (PGlite, fake WhatsApp, fake parser)
pnpm typecheck       # tsc --noEmit (includes test/)
pnpm build           # tsup → dist/index.js
pnpm simulate        # full fake day printed to stdout; uses a real model if LLM env is set
pnpm test:parser     # real-model eval on test/fixtures/orders.json (costs money; needs a working LLM in .env)
pnpm dev             # local server; no DATABASE_URL = in-memory PGlite (data lost on restart)
pnpm db:generate     # after editing src/db/schema.ts; commit the new drizzle/ files
pnpm import:customers <contacts.vcf|customers.csv> [--dry-run]
pnpm import:chat-export <file.txt|folder> [--fixtures out.json]
pnpm orders:from-backup [--check] [--backup dir] [--date d] [--no-open]  # orders from an iPhone backup (dev run)
pnpm build:mac       # bun --compile → dist/preppr-orders-{arm64,x64} (single-file Mac tool, ad-hoc signed)
pnpm wa:sync         # coexistence only: request contacts + chat history from Meta, within 24 h of onboarding
```

Before committing: `pnpm typecheck && pnpm test && pnpm build`. The default `.env` LLM may be a retired free model; for `simulate` without a model run `LLM_PROVIDER=anthropic ANTHROPIC_API_KEY= pnpm simulate`.

## Architecture (where things live)

- `src/app.ts`: Hono routes `/webhook` (verify signature, enqueue, 200), `/jobs/cutoff`, `/healthz`, `/readyz`, `/admin/*`. Creates the worker.
- `src/flows/router.ts`: `enqueuePayload` (webhook side: inbox insert, statuses) and `handleInbound` (worker side: messages row, rate limit, route to owner / onboarding / customer).
- `src/jobs/worker.ts` + `queue.ts`: in-process worker draining `inbox` and `outbox`. Claims one row per phone/recipient under a short advisory lock; leases (2 min) recover from crashes. Also runs periodic tasks (watchdog 60 s, sheet sync 30 s) from the start loop only.
- `src/wa/send.ts`: `send()` is the only way to send free-form messages. Checks the 24 h window, then inserts into `outbox` with an idempotency key `<ctx.out.prefix>:<n>` (or an explicit key). `sendTemplate()` is the only path outside the window (approved templates). Never call `wa.send` directly from flows.
- Coexistence (`WA_COEXISTENCE=1`, `docs/coexistence-setup.md`): bot shares the owner's WhatsApp Business app number. `src/flows/coexistence.ts` handles webhook fields `smb_message_echoes` (owner typed in the app → pause bot for that customer), `history`, `smb_app_state_sync` (→ `wa_contacts`); `enqueuePayload` only routes field `messages`. Unknown numbers get no reply unless they ask to order (`UNKNOWN_SENDERS`). `src/jobs/menuPush.ts` replaces broadcast lists: menu text in-window, utility template outside it, opted-in customers only (`customers.menu_opt_in`).
- `src/flows/customer.ts`: ordering. Parse order: `ruleInterpret` (`src/llm/rules.ts`, strict code parser) first, model only when it returns null. Model failure throws `ParserUnavailable` → worker retries → owner gets the message.
- `src/flows/owner.ts`: owner commands (MENU, SUMMARY, ORDERS, CLOSE, OPEN, RESUME, PAID, VERIFY, PENDING, BALANCE, DUES, BLOCK, ADD, NAME, AREA, NOTE, CHATS, OPTIN, OPTOUT) and shared contact cards.
- `src/flows/payments.ts`, `src/domain/ledger.ts`: balance = confirmed orders − verified payments.
- `src/flows/onboarding.ts`: only for unknown numbers (`needsOnboarding = !customer`).
- `src/jobs/cutoff.ts`, `watchdog.ts`, `sheetSync.ts`; `src/sheets/client.ts` (Sheets REST + service-account JWT, no SDK).
- `src/backup/*` + `scripts/backup-orders.ts`: Mac tool `preppr-orders` (docs/backup-orders.md). Reads WhatsApp Business chats from the owner's iPhone backup (decrypts with node:crypto, bplist parser, `sqlite.ts` = bun:sqlite or node:sqlite), feeds `src/domain/exportOrders.ts` (`OrderInput` → `extractFromInputs`, shared with chat exports), writes CSVs. Keep it free of db/flows imports so the Bun binary stays small. Installer: `deploy/mac/install.sh`.
- `src/admin/*`: read-only chat viewer behind an HMAC link from the CHATS command.
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

- `docs/backup-orders.md`: Mac tool for orders from the iPhone backup: owner steps, hosting, `--check`, troubleshooting.
- `docs/pilot-cloudflare.md`: pilot on one machine (laptop now, VPS later): `deploy/pilot/` has the Compose file (app + cloudflared) and the cutoff cron Worker.
- `docs/deployment-plan.md`: how to deploy one kitchen, and how to productize for many.
- `docs/production-readiness.md`: launch checklist and status.
- `docs/coexistence-setup.md`: bot on the owner's existing number (current plan for the first kitchen): behavior, menu template, onboarding, smoke test.
- `docs/meta-setup.md`, `docs/google-sheet-setup.md`, `docs/monitoring.md` (alerts + runbook), `docs/owner-setup.md` (for the kitchen owner).
- `system-design.md`: original architecture and laptop setup (partly superseded by the inbox/outbox design in README "Design notes").

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
