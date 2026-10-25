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
```

Before committing: `pnpm typecheck && pnpm test && pnpm build`. The default `.env` LLM may be a retired free model; for `simulate` without a model run `LLM_PROVIDER=anthropic ANTHROPIC_API_KEY= pnpm simulate`.

## Architecture (where things live)

- `src/app.ts`: Hono routes `/webhook` (verify signature, enqueue, 200), `/jobs/cutoff`, `/healthz`, `/readyz`, `/admin/*`. Creates the worker.
- `src/flows/router.ts`: `enqueuePayload` (webhook side: inbox insert, statuses) and `handleInbound` (worker side: messages row, rate limit, route to owner / onboarding / customer).
- `src/jobs/worker.ts` + `queue.ts`: in-process worker draining `inbox` and `outbox`. Claims one row per phone/recipient under a short advisory lock; leases (2 min) recover from crashes. Also runs periodic tasks (watchdog 60 s, sheet sync 30 s) from the start loop only.
- `src/wa/send.ts`: `send()` is the only way to send. Checks the 24 h window, then inserts into `outbox` with an idempotency key `<ctx.out.prefix>:<n>`. Never call `wa.send` directly from flows.
- `src/flows/customer.ts`: ordering. Parse order: `ruleInterpret` (`src/llm/rules.ts`, strict code parser) first, model only when it returns null. Model failure throws `ParserUnavailable` → worker retries → owner gets the message.
- `src/flows/owner.ts`: owner commands (MENU, SUMMARY, ORDERS, CLOSE, OPEN, RESUME, PAID, VERIFY, PENDING, BALANCE, DUES, BLOCK, ADD, NAME, AREA, NOTE, CHATS) and shared contact cards.
- `src/flows/payments.ts`, `src/domain/ledger.ts`: balance = confirmed orders − verified payments.
- `src/flows/onboarding.ts`: only for unknown numbers (`needsOnboarding = !customer`).
- `src/jobs/cutoff.ts`, `watchdog.ts`, `sheetSync.ts`; `src/sheets/client.ts` (Sheets REST + service-account JWT, no SDK).
- `src/admin/*`: read-only chat viewer behind an HMAC link from the CHATS command.
- `src/db/schema.ts`: Drizzle schema; migrations in `drizzle/` run at startup.

## Rules that matter

- **Money is computed in code**, never by the model: the model returns item ids and quantities only (`priceLines`, `orderTotal` in `src/domain/order.ts`).
- **The rules parser must stay strict**: any doubt returns null so the model decides. `test/rules.test.ts` checks it never contradicts a fixture it answers; keep that passing when adding patterns.
- **All time comes from `ctx.now()` / `deps.now()`** (tests use a fake clock). Don't use `new Date()` in flows or jobs, except the worker's periodic scheduling.
- **Outbound sends are queued**; tests must `await h.drain()` before checking `h.wa.sent`.
- **Handlers can run more than once** (retries, crash recovery): keep writes idempotent (upserts, unique keys, `onConflictDoNothing`), and send via `send()` so idempotency keys dedupe replies.
- **Customer-supplied text is untrusted**: HTML-escape in `src/admin/routes.ts` (`esc`), write RAW to Sheets, never put message bodies into Sentry (`src/lib/sentry.ts` drops body/raw/text).
- **The 24 h customer-service window** is enforced in `send()`; the bot sends no templates yet.
- Schema changes: edit `src/db/schema.ts`, `pnpm db:generate`, commit the SQL and `drizzle/meta`. Don't hand-edit applied migrations.
- Tests use the `harness()` in `test/helpers.ts` (PGlite, `DryRunWaClient`, `FakeLlm`, fake clock, worker concurrency 1). Use `vi.mock` for failure injection, as in `test/reliability.test.ts`.
- Match the surrounding style: small modules, plain functions, short doc comments on exported functions, no classes except clients.

## Docs

- `docs/deployment-plan.md`: how to deploy one kitchen, and how to productize for many.
- `docs/production-readiness.md`: launch checklist and status.
- `docs/meta-setup.md`, `docs/google-sheet-setup.md`, `docs/monitoring.md` (alerts + runbook), `docs/owner-setup.md` (for the kitchen owner).
- `system-design.md`: original architecture and laptop setup (partly superseded by the inbox/outbox design in README "Design notes").

## Open items

- Parser not yet evaluated on real customer messages (collect with `pnpm import:chat-export --fixtures`).
- Not yet deployed with a permanent database; the Sheet and Sentry integrations are tested only against fakes/mocks.
- CI runs tests on PGlite only; a real-Postgres CI job is still to add.
- Migrations run at startup on every instance; for multi-instance deploys run `pnpm db:migrate` as a separate step (see deployment plan).
