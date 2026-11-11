# 360dialog (WA_PROVIDER=d360)

The pilot connects the owner's existing WhatsApp Business app number to the Cloud API through **360dialog coexistence**: the owner keeps using the app, and the bot shares the number. 360dialog passes Cloud API JSON through, but the host, auth, webhook security and some event envelopes differ from Meta direct. The Meta path (`WA_PROVIDER=meta`) stays working for when we become a Tech Provider.

Checked against docs.360dialog.com on 2026-11-05 (append `.md` to any page for markdown). **Differences from the original brief are in bold.**

## Endpoints

| What | 360dialog | Source |
|---|---|---|
| Base URL | `https://waba-v2.360dialog.io` | messaging-api/api-reference/messages |
| Auth | header `D360-API-KEY: <key>`, one key per number | same |
| Send | `POST /messages`, Cloud API body (no phone-number id in the path) | same |
| Read receipt | `POST /messages` `{messaging_product, status:"read", message_id}` (typing indicator not verified, so not sent) | same |
| Set webhook | `POST /v1/configs/webhook` `{"url", "headers": {...}}` → 201 | messaging-api/api-reference/webhooks |
| Read webhook | `GET /v1/configs/webhook` → `{url, headers}` | same |
| WABA-wide webhook | `POST/GET /waba_webhook` `{url, headers, override_all}`. The phone-number webhook wins over it. We use the phone-number one | same |
| Key / number health | `GET /health_status` → `health_status.can_send_message` = AVAILABLE, LIMITED or BLOCKED. 401 means bad key | messaging/health-status |
| Templates | **`POST /message_templates` and `GET /message_templates`. `/v1/configs/templates` is deprecated** | messaging-api/api-reference/templates |
| Media | `GET /{media-id}` → `url` on `lookaside.fbsbx.com`. Swap the host for `waba-v2.360dialog.io` and GET it with the key, **within 5 min** (backlog: not built) | messaging/media/upload-retrieve-or-delete-media |

## Webhooks

- **Not signed.** No HMAC. We set a custom header with the URL (`X-Preppr-Secret: $WA_WEBHOOK_SECRET`), and the app compares it in constant time (`src/wa/provider/index.ts`). A bad or missing secret gets 401 and `alert=webhook_auth_rejected`.
- URL rules: HTTPS with a valid certificate, **no `_` and no `:port`**. Ours is `https://wa.<domain>/webhooks/whatsapp`. `pnpm wa:webhook:set` checks it.
- **Response time: 200 within 5 s** (the docs target a median ≤ 250 ms with < 1% over 1 s), not "80 ms". We store the raw body (one insert) and ack. The worker does the rest.
- Retries: one page says up to 7 days, another says typically 24 h. Our dedupe (`raw_webhooks.dedupe_key`) makes redelivery harmless either way.
- **Propagation:** "15–20 s" is documented for `/waba_webhook`. Nothing is stated for `/v1/configs/webhook`. `wa:webhook:set` polls GET for up to 60 s either way.
- **Key rotation:** "Generating a new API key will revoke all existing API keys," and the key is shown only once. **The docs don't say the webhook URL is removed.** We re-check and re-set it anyway (runbook).

## Envelopes (normalized by shape in `src/wa/normalize.ts`)

- Messages, statuses and `smb_message_echoes` come in Meta's envelope: `entry[].changes[].{field, value}`. Echoes are under `value.message_echoes[]`.
- `history` and `smb_app_state_sync` come in 360dialog's own envelope: `{"id": EVENT_ID, "event": "history" | "smb_app_state_sync", "data": {"id": WABA_ID, "messaging_product", "metadata", ...}}`.
  - **History chunks:** `data.history[]`, each with its own `metadata {phase, chunk_order, progress}` and `threads[]`.
  - **Contacts:** `data.state_sync[]` (not `history`), with items `{type:"contact", contact:{full_name, first_name, phone_number}, action, metadata:{timestamp}}`.
  - Declined: `data.history[].errors[].code == 2593109` ("History sync is turned off by the business from the WhatsApp Business App"). This becomes event `history_declined`, which logs `alert=history_declined` and sends a WhatsApp to ops.
- Detection is by shape, never by provider flag. Unknown shapes are stored with shape `unknown` and alerted on, never dropped.

## Coexistence specifics

- **History goes to the partner's webhook. Direct clients download it from the 360dialog Hub.** It is sent once, minutes after onboarding, and only if "Enable history and contact sync" was ticked during Embedded Signup (QR step). There is no API call to request it, so `pnpm wa:sync` without arguments does nothing under d360. To import:
  1. `pnpm wa:sync --from-db` re-applies any history/contact events that did reach our webhook (`raw_webhooks`).
  2. `pnpm wa:sync <file.json>` imports a Hub download: a webhook body, an array of bodies, or a bare `history[]` / `state_sync[]` list. **Check the real file format on onboarding day.**
  3. Last resort: the owner exports chats, then `pnpm import:chat-export`.
- The Business app must be opened at least once every 13 days, or the number disconnects. The watchdog alerts (`app_idle`) and reminds the owner after 10 days without an echo.

## Sandbox

- Get a key: WhatsApp `START` to `+551146733492` (wa.me/551146733492?text=START). The key arrives in the chat.
- **Base `https://waba-sandbox.360dialog.io`. Send is `/v1/messages`**, not `/messages`. The provider switches on the host.
- Limits:
  - One fixed recipient (your own phone).
  - **25 messages total**, and rejected requests count. After that you get 429.
  - Only the predefined templates (`disclaimer`, `first_welcome_messsage`, `interactive_template_sandbox`).
  - **No media upload or download.**
  - Webhook must be HTTPS.
- So the sandbox can test: inbound text → parsed order → confirmation, webhook auth, and `wa:check`. It **cannot** test echoes (needs a real coexistence number), template sync, or voice notes. Those are checked on onboarding day.

## Error mapping (`src/wa/errors.ts`)

| Response | Retry? | Kind |
|---|---|---|
| 5xx, 429, `{error:{code}}` 130429 / 131056 / 131000 / 2 | yes (outbox backoff) | transient |
| 131047 (24 h window), 131026 (undeliverable), 131030 (not allowed), other 4xx | no | rejected (`alert=send_dead`) |
| 401 `{"error":"Invalid API key"}`, 403 `{"code":"insufficient_balance"}`, Graph 190 / 10 / 200 | no | config (`alert=send_config`) |

131056 isn't in 360dialog's error list. It comes from Meta, and the pass-through keeps Meta's codes.

## Meta-only calls skipped under d360

`/register`, `subscribed_apps`, `whatsapp_business_profile` and `smb_app_data` (the history request) are handled by 360dialog. `skipUnderD360()` logs `skipped under WA_PROVIDER=d360: …`.
