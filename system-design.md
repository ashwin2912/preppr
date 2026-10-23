# System design: WhatsApp tiffin ordering bot

How the MVP works today: who talks to whom, where data lives, and what runs when. The last sections cover running it on an always-on laptop and what to improve next.

---

## 1. The big picture

Two WhatsApp numbers, two jobs:

- **Owner's existing number** (WhatsApp Business app on the owner's phone): sends the daily menu to broadcast lists and handles manual chats. The bot never touches it.
- **Bot number** (new SIM, WhatsApp Cloud API): every customer order happens here, in 1:1 chats.

```mermaid
flowchart LR
    subgraph Phones["Phones"]
        OWNERAPP["Owner phone<br/>WhatsApp Business app<br/>(existing number)"]
        CUST["Customers<br/>(~500, 3 areas)"]
    end

    subgraph Meta["Meta"]
        BL["Broadcast lists<br/>(2 x 256 contacts)"]
        CLOUD["WhatsApp Cloud API<br/>(bot number)"]
    end

    subgraph Host["Server: laptop or Cloud Run"]
        APP["Bot app<br/>Node + Hono"]
        JOB["Cutoff trigger<br/>cron or Cloud Scheduler"]
    end

    DB[("Postgres")]
    LLM["Claude API<br/>claude-haiku-5-5"]

    OWNERAPP -- "1 daily menu + wa.me link" --> BL
    BL -- "2 broadcast" --> CUST
    CUST -- "3 tap link, chat 1:1" --> CLOUD
    OWNERAPP -- "MENU / SUMMARY / RESUME<br/>(owner DMs the bot too)" --> CLOUD
    CLOUD -- "4 webhook POST /webhook" --> APP
    APP -- "5 replies via Graph API" --> CLOUD
    APP <--> DB
    APP -- "parse menu / interpret order" --> LLM
    JOB -- "POST /jobs/cutoff every 5 min" --> APP
```

**Cost rule behind the design:** a reply within 24 h of the customer's last message is free, and US numbers can't receive marketing templates. So the bot only ever *replies*. The daily "menu is out" push goes through the owner's broadcast lists instead.

---

## 2. A day, end to end

```mermaid
sequenceDiagram
    autonumber
    actor O as Owner
    participant B as Bot
    participant DB as Postgres
    participant C as Claude
    actor U as Customer
    participant S as Scheduler

    Note over O,B: Morning: set the menu
    O->>B: MENU Mon: Dal makhani 6, Roti 1 each... Cutoff 10:30
    B->>C: parseMenu(text)
    C-->>B: items, prices, aliases, cutoff
    B->>DB: menus row (status=draft)
    B-->>O: Preview + [Publish] [Edit]
    O->>B: tap Publish
    B->>DB: status=active
    B-->>O: Ready-to-forward broadcast text with wa.me link
    O->>U: Forward to broadcast lists (manual, from business app)

    Note over U,B: Ordering window
    U->>B: "Order" (from wa.me link)
    alt unknown customer
        B-->>U: name? then area buttons, then address note
    end
    B-->>U: Today's menu
    U->>B: "do dal aur 4 roti, no onion"
    B->>C: interpret(message, menu, current order, previous order)
    C-->>B: intent=order, lines, unmatched, confidence
    B->>B: price lines + total in code
    B->>DB: orders row (status=draft)
    B-->>U: Itemized summary + total + payment info + [Confirm] [Change]
    U->>B: tap Confirm
    B->>DB: status=confirmed
    B-->>U: You're in! Delivery to Newport today

    Note over S,O: Cutoff
    S->>B: POST /jobs/cutoff
    B->>DB: close menus past cutoff, claim summary
    B-->>O: Kitchen totals + delivery list by area + drafts + flags
```

---

## 3. What happens to one inbound message

The webhook answers Meta immediately, then does the real work in the background. Everything for one message runs inside a single database transaction.

```mermaid
sequenceDiagram
    autonumber
    participant M as Meta
    participant W as POST /webhook
    participant P as processPayload (async)
    participant DB as Postgres
    participant R as route()
    participant G as Guarded send

    M->>W: POST body + X-Hub-Signature-256
    W->>W: HMAC check with WA_APP_SECRET
    alt bad signature
        W-->>M: 401
    else ok
        W-->>M: 200 immediately
        W->>P: start in background
    end
    P->>DB: BEGIN
    P->>DB: pg_advisory_xact_lock(phone)
    Note right of DB: one message per customer at a time
    P->>DB: INSERT messages ON CONFLICT DO NOTHING
    alt already there (Meta redelivery)
        P->>DB: COMMIT, stop
    else new
        P->>M: mark read + typing indicator
        P->>R: route(message)
        R->>G: send(reply)
        G->>DB: last inbound from this phone < 24h?
        alt window open
            G->>M: Graph API /messages
            G->>DB: log outbound message
        else closed
            G->>G: log window_closed, do not send
        end
        P->>DB: COMMIT
    end
```

---

## 4. Routing decisions

```mermaid
flowchart TD
    IN["Inbound message"] --> OWN{"From an OWNER_NUMBERS number?"}
    OWN -- yes --> OCMD["Owner flow<br/>MENU / SUMMARY / ORDERS / CLOSE / OPEN / RESUME / HELP<br/>Publish / Edit buttons"]
    OWN -- no --> TAKE{"human_takeover_until in the future?"}
    TAKE -- yes --> SILENT["Stay silent, tag message takeover_silent"]
    TAKE -- no --> ONB{"No customer row, or missing name/area,<br/>or mid-onboarding?"}
    ONB -- yes --> ONBF["Onboarding flow"]
    ONBF --> DONE{"Finished on this message?"}
    DONE -- no --> WAIT["Wait for next answer"]
    DONE -- yes --> MENU["Send menu, or 'closed' reply"]
    ONB -- no --> CUSTF["Customer flow"]

    CUSTF --> MEDIA{"Voice note / image / video?"}
    MEDIA -- yes --> ASKTYPE["'Please type your order' + forward note to owner"]
    MEDIA -- no --> BTN{"Confirm / Change button?"}
    BTN -- yes --> BTNF["Check order version + menu still open, then confirm or ask what to change"]
    BTN -- no --> LLM["Claude: interpret()"]
    LLM --> HAND{"intent = handoff?"}
    HAND -- yes --> HO["Handoff: notify owner, pause bot 4h"]
    HAND -- no --> OPEN{"Menu active and before cutoff?"}
    OPEN -- no --> CLOSED["'Orders closed at 10:30' reply<br/>late order attempts forwarded to owner"]
    OPEN -- yes --> INTENT{"intent"}
    INTENT -- "order / edit" --> ORD["Order handling (section 5)"]
    INTENT -- cancel --> CAN["Mark cancelled, confirm"]
    INTENT -- question --> Q{"topic"}
    Q -- "cutoff" --> QA["Answer from menu data"]
    Q -- "menu / price" --> QM["Send menu"]
    Q -- other --> HO
    INTENT -- "menu / other" --> MENU2["Send menu, or nudge to confirm"]
```

---

## 5. Order handling: when the bot trusts the parse

The model only returns **item ids and quantities**. Prices and totals always come from the menu in code (`src/domain/order.ts`).

```mermaid
flowchart TD
    A["Claude result: lines, unmatched, confidence"] --> B["priceLines(): look up each item_id in menu,<br/>check qty is 1..50, merge duplicates"]
    B --> C{"lines not empty AND nothing unmatched<br/>AND no bad lines AND confidence >= 0.8?"}
    C -- yes --> D["Upsert draft order, total from code"]
    D --> E["Send summary + Confirm / Change buttons<br/>state = awaiting_confirm"]
    C -- no --> F{"Already asked one clarifying question?"}
    F -- no --> G["Ask one short question<br/>state = awaiting_clarification"]
    F -- yes --> H["Save what we have as flagged draft<br/>Handoff to owner"]
```

---

## 6. State machines

### Conversation state (per phone, `conversation_state`)

```mermaid
stateDiagram-v2
    [*] --> idle
    idle --> onboarding_name: new customer, no name
    idle --> onboarding_area: name known, no area
    onboarding_name --> onboarding_area: name saved
    onboarding_name --> idle: name saved, area already known
    onboarding_area --> onboarding_address: area saved (brand-new customer)
    onboarding_area --> idle: area saved (imported customer)
    onboarding_address --> idle: note saved or skip
    idle --> awaiting_confirm: confident order parsed
    idle --> awaiting_clarification: unclear order
    awaiting_clarification --> awaiting_confirm: answer is clear
    awaiting_clarification --> idle: still unclear, handoff
    awaiting_confirm --> idle: Confirm tapped
    awaiting_confirm --> idle: Change tapped
    awaiting_confirm --> awaiting_confirm: edit message
```

### Menu status

```mermaid
stateDiagram-v2
    [*] --> draft: MENU command
    draft --> draft: new MENU same date (no orders yet)
    draft --> active: Publish
    active --> closed: cutoff job or CLOSE
    closed --> active: OPEN with optional time
```

### Order status

```mermaid
stateDiagram-v2
    [*] --> draft: parsed order
    draft --> confirmed: Confirm button (version must match)
    confirmed --> draft: edit before cutoff
    draft --> cancelled: cancel
    confirmed --> cancelled: cancel
    cancelled --> draft: new order same day
```

---

## 7. Cutoff job

Runs every 5 minutes through the morning. Running it twice is harmless.

```mermaid
flowchart TD
    T["POST /jobs/cutoff with X-Job-Secret"] --> A["UPDATE menus SET closed<br/>WHERE active AND cutoff_at <= now"]
    A --> B["Find closed menus from today/yesterday<br/>with summary_sent_at IS NULL"]
    B --> C["Claim: set summary_sent_at = now<br/>(only if still NULL)"]
    C --> D["Build summary: kitchen totals, delivery list by area,<br/>unconfirmed drafts, flagged + handoffs"]
    D --> E{"Delivered to at least one owner?<br/>(owner 24h window open)"}
    E -- yes --> F["Done"]
    E -- no --> G["Reset summary_sent_at = NULL<br/>retry on next run, or owner sends SUMMARY"]
```

---

## 8. Data model

```mermaid
erDiagram
    customers ||--o{ orders : places
    menus ||--o{ orders : "for date"
    customers ||--o| conversation_state : has
    customers ||--o{ messages : "sends / receives"

    customers {
        text phone PK "E.164"
        text name
        text area "one of AREAS"
        text address_note
        timestamptz last_inbound_at
        timestamptz human_takeover_until
    }
    menus {
        serial id PK
        text date UK "YYYY-MM-DD, New York"
        jsonb items_json "id, name, price_cents, aliases"
        timestamptz cutoff_at
        text status "draft | active | closed"
        timestamptz summary_sent_at
    }
    orders {
        serial id PK
        int menu_id FK
        text customer_phone FK
        jsonb lines_json "item_id, name, qty, unit_cents, note"
        int total_cents "computed in code"
        text status "draft | confirmed | cancelled"
        real confidence
        bool flagged
        timestamptz updated_at "also the button version"
    }
    messages {
        text wa_message_id PK "dedupe key"
        text phone
        text direction "in | out"
        text type
        text body
        jsonb raw_json
        text intent "label the bot chose"
    }
    conversation_state {
        text phone PK
        text state
        jsonb context_json
    }
```

`orders` has a unique key on `(menu_id, customer_phone)`: one order per customer per day, and edits update that row. `messages` doubles as the 24-hour window clock and as a raw log for building eval sets later.

---

## 9. Code map

```mermaid
flowchart LR
    subgraph HTTP
        app["src/app.ts<br/>/webhook /jobs/cutoff /healthz"]
    end
    subgraph Flows
        router["flows/router.ts"]
        owner["flows/owner.ts"]
        onboarding["flows/onboarding.ts"]
        customer["flows/customer.ts"]
        handoff["flows/handoff.ts"]
    end
    subgraph Domain
        menu["domain/menu.ts"]
        order["domain/order.ts"]
        summary["domain/summary.ts"]
        imp["domain/importCustomers.ts"]
    end
    subgraph Adapters
        wa["wa/client.ts + wa/send.ts<br/>(24h guard)"]
        llm["llm/anthropic.ts"]
        db["db/schema.ts + db/client.ts"]
    end
    cutoff["jobs/cutoff.ts"]

    app --> router
    app --> cutoff
    router --> owner & onboarding & customer
    customer --> handoff
    owner --> menu & summary
    customer --> menu & order
    cutoff --> summary
    owner & customer & onboarding & handoff --> wa
    owner & customer --> llm
    router & owner & customer & cutoff --> db
    imp --> db
```

---

## 10. Running on an always-on laptop

Yes, it works. The app is one Node process plus Postgres. Nothing in the code depends on Google Cloud. Cloud Run and Cloud Scheduler are swapped for three local pieces:

| Cloud Run setup | Laptop setup |
|---|---|
| Public HTTPS URL from Cloud Run | **Tunnel** with a fixed URL: Cloudflare named tunnel (needs a domain on Cloudflare) or an ngrok free static domain |
| Cloud Scheduler | **cron** (or launchd) running `curl` every 5 min |
| Neon / Cloud SQL | **Postgres**: local (`brew install postgresql@16`) or keep Neon's free tier |
| Cloud Run restarts crashed containers | **pm2** or a launchd agent restarts the process |

```mermaid
flowchart LR
    CUST["Customers"] --> META["Meta Cloud API"]
    META -- "HTTPS webhook" --> EDGE["Tunnel edge<br/>bot.yourdomain.com"]

    subgraph Laptop["Laptop (always on, plugged in)"]
        CF["cloudflared / ngrok"]
        PM["pm2 or launchd"]
        APP["node dist/index.js<br/>:8080"]
        CRON["cron: curl /jobs/cutoff<br/>*/5 9-14 * * *"]
        PG[("Postgres<br/>local or Neon")]
    end

    EDGE --> CF --> APP
    PM -. "keeps alive" .-> APP
    CRON --> APP
    APP --> PG
    APP -- "outbound HTTPS" --> META
    APP -- "outbound HTTPS" --> CLAUDE["Claude API"]
```

### Setup

```sh
# 1. Build and run under a supervisor
pnpm install && pnpm build
npm i -g pm2
pm2 start "node --env-file=.env dist/index.js" --name preppr
pm2 save && pm2 startup          # restart after reboot

# 2. Fixed public URL (pick one)
cloudflared tunnel create tiffin            # then route bot.yourdomain.com -> http://localhost:8080
cloudflared tunnel run tiffin
#   or: ngrok http --url=<your-free-static-domain>.ngrok-free.app 8080
# Put https://<that-host>/webhook in the Meta webhook config.

# 3. Cutoff job (crontab -e). cron uses the laptop's time zone: keep it on New York time.
*/5 9-14 * * * curl -s -X POST -H "X-Job-Secret: <JOB_SECRET>" http://localhost:8080/jobs/cutoff >/dev/null

# 4. Keep the Mac awake
sudo pmset -a sleep 0 disksleep 0     # or: caffeinate -s (while on power)
```

Required in `.env`: set `DATABASE_URL`. Without it the app uses an in-memory database and **loses all orders on restart**.

Avoid cloudflared "quick tunnels" (`--url` with no named tunnel). Their URL changes on every restart, and the Meta webhook would then need re-pointing each time.

### Laptop risks and cheap fixes

| Risk | Effect | Fix |
|---|---|---|
| Laptop sleeps, OS update reboots, Wi-Fi drops | Webhooks fail during the ordering window | Disable sleep and auto-update restarts; pm2 startup; wired network if possible |
| Power cut | Battery covers the laptop, but not the router | Small UPS for the router |
| Nobody notices it's down | Orders silently lost | Free uptime monitor (e.g. UptimeRobot) pinging `https://<tunnel>/healthz`, alerting the owner by SMS |
| Disk dies / laptop stolen | Customer list + order history gone | Use Neon for Postgres (free tier) or a nightly `pg_dump` to cloud storage |
| Secrets on disk | `.env` holds WA token and API key | FileVault on, laptop user account not shared |

Meta retries webhooks that fail, so short outages usually recover. Messages that arrive while the laptop is down get processed when it comes back, but the customer sees no reply until then. The cutoff job catches up on the next cron run after the laptop wakes.

**When to move to the cloud:** once the business depends on it every day, a laptop outage during the 8–10:30 AM window costs real orders. Cloud Run with `min-instances 1` costs roughly $10–20/month. Moving needs no code change, only the deploy steps in the README.

---

## 11. Known weaknesses and how to improve

Ordered by how much they matter at ~500 customers.

### Reliability

1. **Work after the 200 isn't durable.** If the process crashes after replying 200 to Meta but before committing, that message is lost (Meta won't retry a 200).
   *Fix:* durable inbox. Insert the raw message before returning 200, process from the table with a worker, mark done. `pg-boss` (a Postgres-backed queue) adds retries and keeps it all in Postgres.

2. **The transaction is held open during the Claude call and the WhatsApp sends.** Each message keeps a DB connection busy for 1–3 s. The pool has 10 connections, so a morning burst queues up.
   *Fix:* hold the per-phone lock, but split the work. Read state, call Claude outside the transaction, then write and send in short steps.

3. **Failed outbound sends are logged but not retried.** A Graph API hiccup means the customer never sees their summary.
   *Fix:* outbound queue with retries (same `pg-boss`), idempotent by `(inbound message id, step)`.

```mermaid
flowchart LR
    M["Meta"] -- POST --> W["/webhook"]
    W -- "INSERT inbox row" --> PG[("Postgres")]
    W -- "200" --> M
    PG --> WK["Worker: per-phone lock,<br/>short transactions"]
    WK --> C["Claude"]
    WK -- "enqueue sends" --> OUT[("outbox")]
    OUT --> S["Sender with retries"] --> M
```

### Owner workload

4. **Daily manual broadcast.** Phase 2 utility template ("ordering is open until 10:30, reply MENU") could replace it, if Meta classifies it as utility.
5. **Summary depends on the owner's 24 h window.** It works because the owner sends MENU each morning. A utility template to the owner number would remove that dependency.
6. **A published menu with orders can't be edited.** Add "sold out" (`SOLDOUT paneer`) and price edits that keep item ids stable instead of replacing the menu.

### Customer experience

7. **Every free-text message calls Claude**, even "Order" or "hi". A keyword fast path skips the model for these, saving ~1 s and cost.
8. **Clarify budget is one question.** Watch real data before raising it. Handoffs cost owner time; wrong orders cost food.
9. **Voice notes:** forward the actual audio to the owner, or transcribe (Phase 2).

### Knowing it works

10. **Parser eval is placeholder data.** Replace `test/fixtures/orders.json` with ~100 real anonymized messages and run `pnpm test:parser` before any prompt change. The `messages.intent` column already labels live traffic, so mismatches can be reviewed and added to the set.
11. **No dashboard.** A daily CSV or Google Sheet export of `orders` gives the owner a view without new UI.
12. **Payments:** text instructions only. Next step is a `paid` flag set by an owner command (`PAID +1201…`) and a weekly unpaid list.

### Rough running cost

| Item | Estimate |
|---|---|
| WhatsApp replies | $0 (all inside the 24 h window) |
| Claude (Haiku 5.5): ~2,000 messages/day × ~1.5k tokens in, ~300 out | ≈ $0.60/day |
| Laptop hosting | $0 + electricity; Cloud Run later ≈ $10–20/month |
| Postgres | $0 local or Neon free tier |
