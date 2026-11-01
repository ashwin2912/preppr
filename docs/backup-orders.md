# Today's orders from the iPhone backup (Mac)

`preppr-orders` reads the day's customer orders from WhatsApp Business on the kitchen owner's iPhone, using the iPhone backup that Finder makes on their Mac, and writes a spreadsheet (CSV) to `~/Desktop/Orders`. It works without the bot. Nothing is sent to customers and the backup is never changed.

Part 1 is for the kitchen owner. Part 2 is for us (setup, hosting, troubleshooting).

---

## Part 1: For the kitchen owner

### One-time setup (about 10 minutes)

1. **Back up the iPhone to the Mac**
   - Connect the iPhone to the Mac with the cable. Unlock the phone and tap **Trust** if asked.
   - Open **Finder** and click the iPhone in the left sidebar.
   - Under *Backups*, choose **Back up all of the data on your iPhone to this Mac**.
   - Tick **Encrypt local backup** and choose a password. **Write it down**: Apple can't recover it.
   - Click **Back Up Now** and wait until it finishes.
   - Optional: tick **Show this iPhone when on Wi-Fi**, so later backups work without the cable.

2. **Let Terminal read the backup**
   - Open **System Settings → Privacy & Security → Full Disk Access**.
   - Turn on **Terminal**. If it isn't in the list, click **+**, open **Applications → Utilities**, choose **Terminal**.
   - Quit Terminal if it was open (Terminal menu → Quit Terminal).

3. **Install Preppr**
   - Open **Terminal** (Applications → Utilities → Terminal).
   - Paste the line Ashwin sent you and press Return. It looks like:
     `curl -fsSL https://…/install.sh | bash`
   - When asked, type the backup password from step 1 (twice). Nothing shows while you type; that's normal.
   - A file called **Get today's orders** appears on your Desktop.

### Every day

1. After the order cutoff, back up the iPhone: Finder → iPhone → **Back Up Now** (or wait for the Wi-Fi backup).
2. Double-click **Get today's orders** on the Desktop.
3. The day's spreadsheet opens. Rows marked **check** need a look (an unclear message, a customer whose number WhatsApp hides, someone who wrote in two chats).

The files are in the **Orders** folder on your Desktop:
- `Orders 2026-10-30.csv`: that day, one row per customer, one column per dish.
- `All orders.csv`: every day so far. Running it again on the same day replaces that day's rows; nothing is doubled.

If the backup password changes, open Terminal and run `~/Preppr/preppr-orders --save-password`.

---

## Part 2: For us

### Build and host

```sh
pnpm install             # includes Bun as a dev dependency (only for building)
pnpm build:mac           # dist/preppr-orders-arm64, dist/preppr-orders-x64 (ad-hoc signed)
```

Upload `dist/preppr-orders-arm64`, `dist/preppr-orders-x64` and `deploy/mac/install.sh` to one public folder (for example a public Cloudflare R2 bucket or a public releases repo). Set `PREPPR_BASE_URL` at the top of `install.sh` to that folder before uploading, then send the owner:

```sh
curl -fsSL <PREPPR_BASE_URL>/install.sh | bash
```

The installer needs no admin password and no Homebrew. It puts the program in `~/Preppr/preppr-orders`, writes `~/.preppr/config.env` (only if missing, mode 600), saves the backup password in the login Keychain (service `preppr-backup`, prompted by Apple's `security` tool, never in arguments or files), and creates `~/Desktop/Get today's orders.command`. To update, run the same line again (settings are kept).

### Model key

Fill `~/.preppr/config.env` on the owner's Mac:

```
LLM_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...   # a dedicated key with a monthly spend limit
```

Only the menu and messages the code rules parser can't read go to the model. Message text is never logged.

### First visit: `--check`

Before the first real run, open Terminal on the owner's Mac and run:

```sh
~/Preppr/preppr-orders --check
```

It needs no model key and prints only counts: backup date, encrypted yes/no, which WhatsApp domains hold a `ChatStorage.sqlite`, whether the database layout is what we expect, and, for the last 7 days, chats, 1:1 vs group messages, and group members with a phone vs hidden (`@lid`). No message text, names or numbers.

Other flags: `--date YYYY-MM-DD`, `--backup <device folder>`, `--out <folder>`, `--no-open`. In development: `pnpm orders:from-backup --backup <dir> --no-open` (reads `.env`; `PREPPR_BACKUP_PASSWORD` overrides the Keychain, for development only).

### How it works

1. Newest folder in `~/Library/Application Support/MobileSync/Backup/` (by `Status.plist` date).
2. Encrypted backups: keybag from `Manifest.plist`, password → PBKDF2-SHA256 then PBKDF2-SHA1 → class keys (RFC 3394 unwrap) → `Manifest.db` (AES-256-CBC) → each file's own key from its `Files.file` archive. Code: `src/backup/crypto.ts`.
3. `ChatStorage.sqlite` (plus `-wal`/`-shm`) from the `WhatsAppSMB` domain, copied into a private temp folder that is deleted afterwards.
4. Messages of the day (Mac's local date): 1:1 chats and each group member as a customer, keyed by phone. The day's menu is the owner's priced message seen in the most chats. Orders are read like the bot does (rules parser, then the model); prices come from the menu, never the model.

### Troubleshooting

| What the owner sees | What to do |
|---|---|
| "This Mac didn't let Preppr read the iPhone backup" | Full Disk Access for Terminal is off, or Terminal wasn't restarted after turning it on. |
| "No iPhone backup on this Mac yet" | Backup is not in Finder's default place (or never made). Back up in Finder; for an external disk pass `--backup`. |
| "That backup password didn't work" | Run `~/Preppr/preppr-orders --save-password` with the right password. |
| "…backup password isn't saved yet" | Same as above. |
| "That backup is older than …" | Back up again after the cutoff; Wi-Fi backups can lag. |
| "Couldn't find WhatsApp Business in this backup" | Only the regular WhatsApp app was found; check which app the kitchen uses. Run `--check` to see the domains. |
| "WhatsApp's chat database has changed" | A WhatsApp update renamed tables/columns. Run `--check`, update `REQUIRED` and the query in `src/backup/whatsapp.ts`. |
| "No menu message from you on …" | The menu wasn't sent from the phone that day, or has fewer than two priced lines. |
| Many rows "phone hidden by WhatsApp" | Group members with hidden numbers (`@lid`); they are listed by name. |
| "Apple could not verify…" / killed on launch | Re-run the install line; it ad-hoc signs the program. |

Phone numbers in the CSV start with `'` (for example `'+15551110001`) so spreadsheets don't treat them as formulas.

### What is only confirmed on a real backup

Built and tested against a synthetic backup (`test/backupFixture.ts`) made with the inverse operations. Still to confirm on the owner's Mac with `--check`: the exact WhatsApp Business domain name, the `ChatStorage.sqlite` table and column names, how many group members are `@lid`, whether `ZMESSAGETYPE = 0` covers all text messages (replies, forwarded text), whether a `-wal` file is present, how long the real password derivation takes (the real `DPIC` is about 10 million rounds: a few seconds), and the Keychain and Gatekeeper prompts.
