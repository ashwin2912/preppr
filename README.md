# Preppr

WhatsApp ordering assistant for small kitchens. Customers order in plain chat ("2 dal aur 4 roti, no onion"), Preppr turns that into an itemized order with a total and a Confirm button, and at cutoff the kitchen gets what to cook and a delivery list grouped by area.

Built for a home-style tiffin service doing ~500 orders a day on the official WhatsApp Cloud API. Node 20 + TypeScript, Hono, Postgres (Drizzle), and an LLM for reading messy order text; prices and totals are always computed in code.

- **Ordering in chat:** onboarding (name, area, address), free-text orders in English/Hindi/Hinglish, edits, cancel, "same as yesterday", Confirm/Change buttons.
- **Owner commands over WhatsApp:** `MENU` to publish the day's menu, `SUMMARY`, `ORDERS`, `CLOSE`, `OPEN`, `RESUME`, plus payment commands.
- **Google Sheet:** orders (a tab per day, with kitchen totals), customers with balances, and payments, synced about every 30 s.
- **Payments and balances:** customers report payments in chat ("paid $20 zelle"); the owner verifies with one tap. One ledger covers pay-per-order and prepaid customers.
- **Cutoff summary:** kitchen totals per item, deliveries by area, unconfirmed drafts, anything that needs a human.
- **Safe by default:** webhook signature check, idempotent message handling, per-customer locking, replies only inside WhatsApp's free 24-hour window.
- **Any model:** Claude by default; any OpenAI-compatible API (OpenRouter, Hugging Face, Ollama) for testing.

Roadmap: thermal-printed route sheets, sales history, and prep forecasting.

## How it works

Customers order in a 1:1 WhatsApp chat with a bot on its own number. The owner keeps sending the daily menu from the existing WhatsApp Business app number via broadcast lists; the broadcast carries a `wa.me` "tap to order" link to the bot.

The bot never starts a conversation. It only replies inside the 24-hour customer-service window, which costs nothing. Every send goes through `src/wa/send.ts`, which refuses to send (and logs) when the recipient's last inbound message is more than 24 h old.

## How a day runs

1. Owner DMs the bot: `MENU Mon: Dal makhani 6, Jeera rice 4, Roti 1 each, Paneer bhurji 7. Cutoff 10:30`
2. Bot replies with a preview + **Publish** / **Edit**. Publish opens ordering and sends back a ready-to-forward broadcast message with the `wa.me` link.
3. Owner forwards that message to the broadcast lists from the business app.
4. Customers tap the link → onboarding (name, area, address note) if new → menu → free-text order → itemized summary with total → **Confirm ✅** / **Change ✏️**.
5. At cutoff, Cloud Scheduler hits `/jobs/cutoff`: the menu closes and the owner gets kitchen totals, a delivery list grouped by area, unconfirmed drafts, and anything flagged.

Owner commands: `MENU …`, `SUMMARY`, `ORDERS`, `CLOSE`, `OPEN [11:30]`, `RESUME <number>`, `HELP`.

Payments: customers can just say "paid $20 on zelle". The bot records it as **to verify**, thanks them, and sends the owner **Verify ✅ / Reject ❌** buttons. Balance = confirmed orders − verified payments (negative = prepaid credit), shown on order confirmation when something is due. Owner commands: `PENDING`, `VERIFY <#>`, `REJECT <#>`, `PAID <number> <amount> [cash|zelle|venmo|card]` (recorded as verified), `BALANCE <number>`, `DUES`, `BLOCK <number>`, `UNBLOCK <number>`.

Customers who still reply to the owner's business number out of habit are handled by the owner by hand (a quick reply pointing them to the link). The bot has no involvement there.

## Develop

```sh
pnpm install
pnpm test            # flows + unit tests (in-memory Postgres, fake WhatsApp, fake parser)
pnpm simulate        # prints a full simulated day; uses a real model if one is configured
pnpm test:parser     # ~30 realistic messages against the configured model
pnpm dev             # local server; without DATABASE_URL it uses in-memory PGlite
```

Copy `.env.example` to `.env` and fill it in. The server, `simulate` and `test:parser` read `.env` automatically; variables set in the shell win.

### Trying a free model instead of Claude

The parser model is picked by `LLM_PROVIDER` (`src/llm/index.ts`). Any OpenAI-compatible API works, which is enough to test the whole flow for free:

```sh
# OpenRouter: key from openrouter.ai/keys; pick a model ending in ":free" at openrouter.ai/models?max_price=0
LLM_PROVIDER=openrouter LLM_API_KEY=sk-or-... LLM_MODEL=<model-id>:free pnpm simulate

# Hugging Face: token from huggingface.co/settings/tokens (with "Inference Providers" permission)
LLM_PROVIDER=huggingface LLM_API_KEY=hf_... LLM_MODEL=<org/model> pnpm simulate
```

Free tiers are rate-limited (OpenRouter: about 20 requests/minute and a small daily cap unless the account has credits; Hugging Face: small monthly credits). The adapter retries 429s with backoff. Free models are weaker at Hinglish and edits and may log prompts, so use test data only, and run `pnpm test:parser` before trusting one with real orders.

To receive real webhooks locally: `cloudflared tunnel --url http://localhost:8080`, then put `https://<tunnel>/webhook` in the Meta webhook config.

Schema changes: edit `src/db/schema.ts`, run `pnpm db:generate`, commit the new file in `drizzle/`. Migrations run automatically at startup (or `pnpm db:migrate`).

### Seeding customers

```sh
AREAS="Journal Square,Newport,Heights" DATABASE_URL=... pnpm import:customers customers.csv --dry-run
AREAS="Journal Square,Newport,Heights" DATABASE_URL=... pnpm import:customers customers.csv
```

CSV header: `phone,name,area,address_note` (optional extra column `notes`). Phones are normalized to E.164 (US default). Areas must match `AREAS` (case-insensitive); unknown areas are reported and left empty, so the bot asks for them. Blank cells never overwrite existing values. A customer with a name and an area skips onboarding.

## Docs

- [docs/meta-setup.md](docs/meta-setup.md): WhatsApp Cloud API setup, step by step. Start business verification early; it takes days.
- [docs/monitoring.md](docs/monitoring.md): Sentry and UptimeRobot setup, what each alert means, runbook.
- [docs/google-sheet-setup.md](docs/google-sheet-setup.md): Google Sheet export of orders, customers and payments.
- [docs/production-readiness.md](docs/production-readiness.md): what's left before launch, reliability work, parsing cost options.
- [system-design.md](system-design.md): architecture and flow diagrams, running on a laptop.

## Deploy (Cloud Run + Cloud Scheduler)

```sh
gcloud run deploy preppr --source . --region us-east4 \
  --no-cpu-throttling --min-instances 1 --max-instances 2 \
  --set-env-vars TZ=America/New_York,AREAS="Journal Square,Newport,Heights",... \
  --set-secrets WA_TOKEN=wa-token:latest,WA_APP_SECRET=wa-app-secret:latest,ANTHROPIC_API_KEY=anthropic-key:latest,DATABASE_URL=database-url:latest,JOB_SECRET=job-secret:latest,SENTRY_DSN=sentry-dsn:latest,GOOGLE_SERVICE_ACCOUNT_JSON=sheets-key:latest
```

`--no-cpu-throttling` is required. The webhook returns 200 immediately and keeps working afterwards; with default throttling Cloud Run starves that work of CPU. `--min-instances 1` avoids cold starts.

Cutoff job: the cutoff time can differ per menu, so call the job every 5 minutes through the morning. It is idempotent.

```sh
gcloud scheduler jobs create http preppr-cutoff --location us-east4 \
  --schedule "*/5 9-14 * * *" --time-zone America/New_York \
  --uri https://<service>/jobs/cutoff --http-method POST \
  --headers X-Job-Secret=<JOB_SECRET>
```

If the owner hasn't messaged the bot in 24 h (normally the morning `MENU` covers this), the summary can't be sent for free. The job keeps it pending and delivers it on a later run after the owner messages the bot, or the owner can send `SUMMARY` at any time.

## Design notes

- **Durable inbox:** the webhook saves each inbound message to the `inbox` table before returning 200 (a failed save returns 500 so Meta redelivers). A worker in the same process handles it, retrying twice (5 s, 30 s) before giving up with an apology. A crash loses nothing: unfinished rows are picked up again when their 2-minute lease expires.
- **Idempotency:** the inbox is unique on `wamid`, so a duplicate delivery stops there.
- **Per-customer ordering:** the worker claims at most one message per phone at a time, oldest first, so two quick messages from one person can't race. No transaction is held during the model call.
- **Outbox:** every reply is queued in `outbox` and sent by the worker with retries (2 s → 3 min backoff, 6 attempts; Graph 4xx errors fail at once). Keys are `<inbound wamid>:<n>`, so a retried handler can't send a reply twice. A recipient's messages always go out in order.
- **Rate limit:** more than 20 messages from one customer in 10 minutes are recorded and ignored (`intent = rate_limited`).
- **Code first, model second:** `src/llm/rules.ts` reads simple messages ("hi", "2 dal, 3 roti", "thanks", "cancel") without a model call. It's strict: anything with a note, an edit, an unknown word or an ambiguous alias goes to the model. Logs show `source: rules|model`. If the model is down, those simple orders keep working; other messages are retried for about 35 s and then forwarded to the owner, and the customer is told a person will reply.
- **Money:** the model only returns item ids and quantities. Prices and totals are computed in code from the menu (`src/domain/order.ts`).
- **Clarify once, then hand off:** low confidence or unmatched items get one clarifying question. If the reply is still unclear, the owner gets a handoff and the bot pauses for that customer for 4 h (or until `RESUME`).
- **Stale buttons:** Confirm button ids carry the order version, so an old summary can't confirm a newer edit.
- Every message (in and out) is stored in `messages` with the bot's intent label, for debugging and building eval sets.

## Layout

```
src/app.ts              routes: /webhook, /jobs/cutoff, /healthz, /readyz
src/flows/router.ts     dedupe, lock, owner vs customer, takeover, onboarding
src/flows/owner.ts      owner commands, menu publish
src/flows/customer.ts   ordering, edits, cancel, questions, confirm buttons
src/flows/onboarding.ts name → area → address note
src/flows/handoff.ts    owner notification + bot pause
src/flows/payments.ts   reported payments, verify/reject, PAID/BALANCE/DUES/BLOCK
src/domain/ledger.ts    balances (confirmed orders − verified payments)
src/jobs/worker.ts      inbox/outbox worker (src/jobs/queue.ts: claiming)
src/jobs/watchdog.ts    alerts: no menu, late summary, stuck queue, unverified payments
src/jobs/sheetSync.ts   DB → Google Sheet (src/sheets/client.ts: REST + service account)
src/jobs/cutoff.ts      close menus, send summary once
src/domain/*            menu/order/summary formatting and math, CSV import
src/llm/anthropic.ts    Claude prompts (structured outputs)
src/wa/*                Graph API client, signature check, guarded send
```

## Status

Working MVP: tested end to end on Meta's test number, not yet in production. What's left before launch is tracked in [docs/production-readiness.md](docs/production-readiness.md).

## License

[MIT](LICENSE)
