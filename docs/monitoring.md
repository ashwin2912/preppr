# Monitoring and runbook

## What alerts you

| Signal | Where it goes | Fires when |
|---|---|---|
| Server down or stuck | UptimeRobot → SMS/email | `GET /readyz` returns non-200 or times out |
| Any `ERROR` log | Sentry → email/push | Crashes, dead-lettered messages, failed sends, Sheet sync failing |
| `alert=no_menu` | Sentry | No published menu by `MENU_EXPECTED_BY` (default 9:00) on a `KITCHEN_DAYS` day |
| `alert=summary_late` | Sentry | A closed menu's summary still isn't delivered 30 min after cutoff (usually the owner's 24h window is closed: the owner sends `SUMMARY`) |
| `alert=queue_backlog` | Sentry (and `/readyz` 503) | Messages waiting more than 2 min: the worker is stuck or down |
| `alert=inbound_dead` | Sentry | A customer message failed 3 times; the customer got an apology |
| `alert=send_dead` | Sentry | A reply couldn't be delivered (permanent Graph error, or 6 failed attempts) |
| `alert=delivery_failed` | Sentry | WhatsApp accepted a reply but couldn't deliver it (customer blocked the number, not on WhatsApp, …). The Graph error code and text are attached. |
| `alert=owner_delivery_failed` | Sentry | Same, for a message to an owner number |
| `alert=summary_undelivered` | Sentry | The cutoff summary was sent 15 min ago but never reached the owner's phone (phone off, no data). Call the owner. |
| `alert=sheet_sync_failing` | Sentry | 3 Google Sheet syncs in a row failed |
| Unverified payments | WhatsApp to the owner, once a day | A reported payment has waited more than 24 h |

Each `alert=` fires once (per menu, per day, or per hour for the backlog), so a problem doesn't spam.

## Setup

**Sentry** (free tier is plenty):
1. Create a Node.js project at sentry.io and copy the DSN.
2. Set `SENTRY_DSN` (Cloud Run: as a secret) and optionally `SENTRY_ENVIRONMENT` (`pilot`, `production`).
3. Alerts → Create alert → Issues: "A new issue is created" → email/push to the developer. Add a second rule filtered on the tag `alert` that is set, so the named alerts always notify.
4. Test: start the server with a deliberately wrong `WA_TOKEN` (and `WA_DRY_RUN=0`), send the bot a message, and wait for the `send_dead` event. It should appear within a minute.

Message bodies (`body`, `raw`, `text` fields) are not sent to Sentry. Phone numbers are, so you can find the customer.

**UptimeRobot** (free, 5-minute checks):
1. New monitor → HTTP(s) → `https://<host>/readyz`.
2. Alert contacts: developer SMS plus the owner's email.
3. Optional: a second monitor on `/healthz` to tell "process down" apart from "process up but stuck".

`/readyz` returns `{"ok":true,"db":"ok","backlog":{"inbox":0,"outbox":0}}`, or 503 when the database is unreachable or messages are piling up.

## Checking conversations

The owner (or anyone on `OWNER_NUMBERS`) sends `CHATS` to the bot and gets a private link valid for 12 hours. It needs `PUBLIC_URL` and `ADMIN_SECRET` set. `CHATS <number>` opens one customer.

- `/admin`: everyone who messaged that day (‹ › for other days), with their order status and flags. **Needs a look** filters to: asked for the owner, reply not delivered, bot error, rate-limited, blocked, bot paused. "Read by AI" marks messages the code parser didn't handle; worth skimming in the pilot.
- `/admin/c/<number>`: the transcript, with delivery status on every reply (⏳ sending, ✓ sent, ✓✓ delivered, read, ⚠ not delivered with WhatsApp's reason), plus the customer's details, recent orders, balance and payments.

The link becomes a cookie scoped to `/admin`, so it isn't left in the address bar. Changing `ADMIN_SECRET` signs everyone out. Removing a number from `OWNER_NUMBERS` stops their links working.

## Runbook

**Bot not replying**
1. Check `/readyz`. A 503 with `db: error` means the database: check Neon status and `DATABASE_URL`.
2. If backlog > 0, the worker is stuck: restart the service (`gcloud run services update preppr --region us-east4 --update-env-vars RESTART=$(date +%s)`, or `pm2 restart preppr` on the laptop). Nothing is lost: queued messages are handled after the restart.
3. Down for more than 10 minutes during the ordering window: the owner sends the pre-written "bot is down, reply here with your order" broadcast.

**Replay a failed message** (after fixing the cause):
```sql
-- customer messages that gave up
SELECT id, phone, last_error, created_at FROM inbox WHERE status = 'failed' ORDER BY id DESC LIMIT 20;
UPDATE inbox SET status = 'pending', attempts = 0, next_attempt_at = now() WHERE id = <id>;

-- replies that couldn't be sent (only within 24 h of the customer's last message)
SELECT id, "to", last_error FROM outbox WHERE status = 'failed' ORDER BY id DESC LIMIT 20;
UPDATE outbox SET status = 'pending', attempts = 0, next_attempt_at = now() WHERE id = <id>;
```

**Summary didn't arrive**: the owner sends `SUMMARY` (that also reopens their 24h window).

**Did a customer get their message?** Delivery statuses are in `wa_statuses`:
```sql
SELECT o.created_at, o.payload_json->>'body' AS body, s.status, s.error_text
FROM outbox o LEFT JOIN wa_statuses s ON s.wa_message_id = o.wa_message_id
WHERE o."to" = '+12015551234' ORDER BY o.id DESC LIMIT 10;
```

**Customer stuck with the bot paused**: `RESUME <number>`.

**Sheet not updating**: check Sentry for `sheet_sync_failing`; causes and fixes are in [google-sheet-setup.md](./google-sheet-setup.md#when-it-fails).
