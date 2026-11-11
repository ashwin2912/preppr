# Runbook

First move for anything customer-facing going wrong: **the owner sends `BOT OFF`**. Customers then get no bot replies at all. Messages are still recorded, and the owner answers in the Business app. `BOT ON` restores the configured `BOT_MODE`.

Quick state check: `curl -s https://wa.<domain>/health` and `pnpm wa:check`.

## Webhook stopped (`alert=no_inbound`, `lastInboundAt` old)

1. `curl https://wa.<domain>/health`.
   - Fails: the tunnel or the app is down. Run `docker compose --env-file .env -f deploy/pilot/docker-compose.prod.yml ps` and check `logs cloudflared` and `logs app`. Restart with `up -d`.
   - OK: go to step 2.
2. `pnpm wa:check`.
   - "webhook set" FAIL: run `pnpm wa:webhook:set`.
   - "key valid" FAIL: see "Key rotated".
3. Sentry shows many `webhook_auth_rejected`: 360dialog is sending an old secret. Run `pnpm wa:webhook:set`, since it re-sends the header.
4. Still nothing: 360dialog status page / support. Check `GET /health_status` in `wa:check` (`can_send_message`).

Messages that arrived while we returned errors are redelivered by 360dialog (up to 24 h–7 days) and deduped.

## Key rotated / `alert=send_config` (401)

Generating a new 360dialog key **revokes the old one immediately**.

1. Put the new key in `.env` (`WA_TOKEN`) and restart: `docker compose ... up -d`.
2. `pnpm wa:webhook:set` (the docs don't say rotation drops the webhook, but re-set it anyway), then `pnpm wa:check`.
3. Sends that failed meanwhile are in `outbox` with status `failed`. Customers whose window is still open can be re-sent by resetting those rows to `pending` (SQL below). Otherwise the owner follows up by hand.

```sql
update outbox set status='pending', attempts=0, next_attempt_at=now(), last_error=null
where status='failed' and created_at > now() - interval '6 hours';
```

## History missing after onboarding

1. Did it arrive? Run `select id, shape, status, received_at from raw_webhooks where body_json->>'event' in ('history','smb_app_state_sync') or body_json::text like '%"history"%' order by id;`
   - Rows exist: `pnpm wa:sync --from-db`.
   - `alert=history_declined` fired: the owner turned history sharing off during the QR step. It can't be re-requested without re-onboarding, so go to step 3.
2. No rows: as a direct client, download history from the 360dialog Hub, then `pnpm wa:sync <file.json>`. If the file shape isn't recognized, it prints 0 chunks. Keep the file and look at it. `normalizeFile` in `src/wa/normalize.ts` is where to add the shape.
3. Last resort: the owner exports the busiest chats (WhatsApp → chat → Export chat → Without media), then `pnpm import:chat-export <folder> --fixtures test/fixtures/real.json`.

## Bot misbehaving (wrong orders, wrong replies, loops)

1. Owner: `BOT OFF`.
2. Find it: send `CHATS <number>` for the viewer, or check Sentry. `REVIEW` shows held replies.
3. Fix or roll back (`git checkout <good> && docker compose ... up -d --build`), then `BOT ON`.
4. One customer only: the owner simply replies in the Business app. That pauses the bot for that customer for 4 h (`RESUME <number>` to undo).

## Unknown webhook shape (`alert=webhook_unknown_shape`)

Nothing is lost. Look at it with `select body_json from raw_webhooks where shape='unknown' or last_error is not null order by id desc limit 5;`. Add the shape to `src/wa/normalize.ts` with a fixture in `test/fixtures/webhooks/`. Then replay: `update raw_webhooks set status='pending', attempts=0, next_attempt_at=now() where id=<id>;`

## Business app idle (`alert=app_idle`)

The owner must open the WhatsApp Business app at least every 13 days, or coexistence disconnects. The owner got a reminder; call them if there's no echo by the next day.

## Restore a backup

```sh
rclone ls r2:$R2_BUCKET/preppr/          # or the R2 dashboard
pg_restore --clean --no-owner -d "$DATABASE_URL" preppr-YYYYMMDD-HHMMSS.dump
```

Restore into a fresh Neon branch first if you're unsure, and point `DATABASE_URL` at it.

## Shadow → assist → live

| Stage | `BOT_MODE` | Customers see | Move on when |
|---|---|---|---|
| 1 | `shadow` | nothing from the bot; owner works as before | A few days of `ORDERS` / cutoff summaries match what the owner actually took |
| 2 | `assist` | order summary + Confirm **only** when the parser is sure (rules, or model ≥ `ASSIST_MIN_CONFIDENCE`); everything else waits for the owner (one ✋ ping per customer per day, `REVIEW` lists all) | Few held replies, and no wrong summaries |
| 3 | `live` | everything | — |

Change `BOT_MODE` in `.env`, then `docker compose ... up -d`. `/health` shows the active mode. `BOT OFF` always overrides it.

## Switching back to Meta direct

Set `WA_PROVIDER=meta` with `WA_TOKEN` (system-user token), `WA_PHONE_NUMBER_ID`, `WA_APP_SECRET`, `WA_VERIFY_TOKEN`, `WA_WABA_ID`. Set the Meta webhook to `https://wa.<domain>/webhook` with the verify token, and subscribe the fields `messages`, `smb_message_echoes`, `history` and `smb_app_state_sync`. Then restart and run `pnpm wa:check`.
