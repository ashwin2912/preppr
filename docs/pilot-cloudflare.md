# Pilot deploy: one machine + Cloudflare

The cheapest setup for the first kitchen. One machine runs the app in Docker; a Cloudflare named tunnel gives it a fixed HTTPS URL; a Cloudflare Worker calls the cutoff job; Neon holds the data. The same files run on a laptop (now) and a small VPS (later). Moving between them needs no change to Meta, Cloudflare or the database.

```
Customers -> Meta Cloud API -> https://bot.<domain>/webhook -> Cloudflare tunnel -> app (Docker) -> Neon
                                Cloudflare Worker (cron) ----> /jobs/cutoff
```

| Piece | What | Cost |
|---|---|---|
| App | `deploy/pilot/docker-compose.yml`: the repo `Dockerfile` + `cloudflared` | laptop $0, VPS ~$5/month |
| URL | Cloudflare named tunnel on a domain we own | $0 |
| Database | Neon free tier | $0 |
| Cutoff | `deploy/pilot/cutoff-cron` Worker, every 5 min 9:00–15:00 NY time | $0 |
| Parser | Anthropic (Haiku) | a few $/month |
| Uptime | UptimeRobot on `/readyz` | $0 |

**Why not run the app on Cloudflare itself?** The app is a long-running process: the worker keeps sending replies after the webhook returns 200, and the watchdog and Sheet sync run on timers. Workers stop when the request ends, so they would need a rewrite. Cloudflare Containers can run the Dockerfile, but they sleep when idle and need a Worker + Durable Object wrapper, so they cost more work than a small box for a pilot.

## What the kitchen does

Nothing in Cloudflare. In Meta, the owner owns the business portfolio and the WhatsApp Business Account, gets the business verified and invites us as admin; we do the app, the system-user token and the webhook. The first kitchen runs the bot on the owner's existing number (coexistence, `docs/coexistence-setup.md`), so the owner also needs a personal WhatsApp for owner commands. The owner sends us:
- owner phone number(s), delivery areas, payment instructions, kitchen days, cutoff time;
- their phone contacts as a `.vcf` export (for `pnpm import:customers`), or they share contacts with the bot later (`docs/owner-setup.md`).

Week 1 can run on Meta's free **test number** (up to 5 recipient phones: the owner and 3–4 friendly customers). Then move to the owner's own number through coexistence onboarding (`docs/coexistence-setup.md`) and set `WA_COEXISTENCE=1`. On the test number, leave `WA_COEXISTENCE` unset: the test number has no Business app behind it. Start business verification on day 1; it takes days.

## One-time setup (shared)

1. **Neon**: create a project, copy the **pooled** connection string into `.env` as `DATABASE_URL`. Without it the app uses an in-memory database and loses everything on restart.
2. **Cloudflare tunnel**: Zero Trust → Networks → Tunnels → Create tunnel (Cloudflared). Copy the token into `.env` as `TUNNEL_TOKEN`. Add a public hostname `bot.<domain>` → service `http://app:8080`.
3. **`.env`**: start from `.env.example`. Set `WA_DRY_RUN=0`, `PUBLIC_URL=https://bot.<domain>`, `TZ=America/New_York`, the kitchen's `OWNER_NUMBERS`, `AREAS`, `KITCHEN_NAME`, `PAYMENT_INSTRUCTIONS`, `KITCHEN_DAYS`, the Meta values, `ANTHROPIC_API_KEY`, and long random `JOB_SECRET` and `ADMIN_SECRET` (`openssl rand -hex 32`).
4. **Start the app** (host sections below), then check `https://bot.<domain>/healthz` returns `ok`.
5. **Meta webhook**: callback `https://bot.<domain>/webhook`, verify token = `WA_VERIFY_TOKEN`, subscribe to `messages`.
6. **Cutoff Worker**:
   ```sh
   cd deploy/pilot/cutoff-cron
   # set PUBLIC_URL in wrangler.toml first
   npx wrangler login
   npx wrangler secret put JOB_SECRET   # same value as in .env
   npx wrangler deploy
   ```
   Check runs under Workers → preppr-cutoff → Logs. A 403 means the secrets differ.
7. **UptimeRobot**: monitor `https://bot.<domain>/readyz`, alerting us and the owner (`docs/monitoring.md`).
8. **Customers**: `pnpm import:customers contacts.vcf --dry-run`, then without `--dry-run` (needs `DATABASE_URL` in the shell).
9. **Smoke test** with the owner and 2–3 phones before announcing: owner sends `MENU`; a customer orders, edits, confirms; a new number goes through sign-up; owner sends `SUMMARY` and `ORDERS`; one payment report + `PAID`/`VERIFY`; `docker compose ... restart app` mid-conversation and check no reply is lost or doubled; next morning, check the cutoff summary arrives.

## Host: laptop (now)

1. Install Docker Desktop; Settings → "Start Docker Desktop when you sign in".
2. From the repo root:
   ```sh
   docker compose --env-file .env -f deploy/pilot/docker-compose.yml up -d --build
   docker compose -f deploy/pilot/docker-compose.yml logs -f app
   ```
   Both containers restart on their own after a crash or reboot (`restart: unless-stopped`) once Docker is running.
3. Keep it awake and on power:
   ```sh
   sudo pmset -c sleep 0 disksleep 0   # never sleep on charger
   ```
   Keep the lid open (or use clamshell with an external display), turn off automatic macOS update restarts, keep FileVault on, and use wired network if possible.
4. Risks are in `system-design.md` section 10. Neon keeps the data safe if the laptop dies; messages sent while it's down are redelivered by Meta and handled when it's back.

## Host: VPS (later)

Any 1–2 GB Linux box (e.g. Hetzner CX22, ~$5/month) in a US region.

```sh
curl -fsSL https://get.docker.com | sh
git clone <repo> preppr && cd preppr
# copy .env (and secrets/ if using the Google Sheet) from the laptop, e.g. with scp
docker compose --env-file .env -f deploy/pilot/docker-compose.yml up -d --build
```

Then stop the laptop stack (`docker compose -f deploy/pilot/docker-compose.yml down`). The tunnel token, Neon, Worker and Meta webhook stay the same. Briefly running both is safe (queue claims use advisory locks), but stop the laptop promptly.

## Updating

Outside the ordering window (after 3 PM):

```sh
git pull
docker compose --env-file .env -f deploy/pilot/docker-compose.yml up -d --build
```

Migrations run at startup. Unfinished queue rows are picked up again after the 2-minute lease.

## Next step

When the kitchen depends on it every day, move to the Stage 1 stack in `docs/deployment-plan.md` (Cloud Run + Neon), or keep the VPS and add a nightly `pg_dump`.
