---
name: whatsapp-orders
description: Read today's customer orders from the WhatsApp Business chats in this Mac's iPhone backup and save them as a spreadsheet (CSV) keyed by phone number. Use when the user says "get today's orders", "orders spreadsheet", or similar.
---

# Today's WhatsApp orders → spreadsheet

You help a home kitchen owner (not technical). Their customers order in WhatsApp Business (1:1 chats and groups). Their iPhone is backed up to this Mac with Finder. Make a CSV of today's orders, one row per customer phone number. Speak simply; never show code unless asked.

## Rules
- Privacy: only read the WhatsApp Business database. Never open photos or other app data. Never print message text except the order lines you need. Never upload anything anywhere.
- Work on copies in a private temp folder (`mktemp -d`, chmod 700). Delete it when done, also if something fails.
- The backup password lives in the Keychain under service `preppr-backup`. Never ask the user to type it in chat. If it's missing, tell them to run in Terminal:
  `security add-generic-password -s preppr-backup -a backup -w`
  (it asks for the password hidden), then try again.
- Never do money math in your head: compute totals with a script from the menu prices.
- If anything is unclear about an order, keep it and mark it "check". Never guess quantities.

## Steps
1. **Setup (first run only).** Need python3 (`python3 --version`; if macOS offers to install developer tools, say yes and wait). Then:
   `python3 -m venv ~/.whatsapp-orders/venv && ~/.whatsapp-orders/venv/bin/pip install iphone_backup_decrypt`
2. **Find the backup.** Newest folder in `~/Library/Application Support/MobileSync/Backup/`. If you get "Operation not permitted", tell the user: System Settings → Privacy & Security → Full Disk Access → turn on Terminal (or Codex) → restart it. Tell them the backup's date; if it's older than today, ask them to make a new one first (Finder → iPhone → Back Up Now) and wait.
3. **Extract the chat database** with a Python script using `iphone_backup_decrypt.EncryptedBackup(backup_directory=..., passphrase=<from security find-generic-password -s preppr-backup -w, read inside the script, never printed>)`. Search the manifest for relativePath `ChatStorage.sqlite` with domain containing `WhatsAppSMB` (WhatsApp Business; expected domain `AppDomainGroup-group.net.whatsapp.WhatsAppSMB.shared`). If only the regular WhatsApp one exists, ask which app they use before continuing. Also extract `ChatStorage.sqlite-wal` if present. If the backup isn't encrypted, find the file via Manifest.db (`Files` table; file is at `<fileID[0:2]>/<fileID>`).
4. **Read today's messages** with sqlite3 (today = the Mac's local date):
   - Time: `ZMESSAGEDATE + 978307200` = Unix seconds.
   - `ZWAMESSAGE` (ZCHATSESSION, ZISFROMME, ZTEXT, ZMESSAGEDATE, ZGROUPMEMBER, ZMESSAGETYPE=0 for text) joined to `ZWACHATSESSION` (ZCONTACTJID, ZPARTNERNAME, ZSESSIONTYPE: 0 = 1:1, 1 = group) and, for groups, `ZWAGROUPMEMBER` (ZMEMBERJID, ZCONTACTNAME).
   - Skip `status@broadcast`. Check the column names exist first (`.schema`); if they differ, look at the schema and adapt.
   - Phone = digits before `@` in a `@s.whatsapp.net` JID, written as +<digits>. A `@lid` JID hides the phone: use the name and mark "check: phone hidden".
5. **Find today's menu:** the owner's own message (ZISFROMME = 1) today that lists dishes with prices, usually the same text in many chats. Show the dishes and prices you found and ask the owner to confirm before going on. If there's none, ask them to paste today's menu.
6. **Read the orders.** For each customer (in groups, each member separately), go through their messages today in order: the latest message that states an order is their order; changes update it; "cancel" cancels it. Ignore chit-chat. Mark "check" for: unclear dishes or quantities, "same as her" style references, payments mentioned, questions for the owner.
7. **Write the CSV** with a Python script (csv module, quote every cell; put `'` before any cell starting with = + - @):
   - File: `~/Desktop/Orders/Orders YYYY-MM-DD.csv`
   - Columns: phone, name, chat, one column per dish (quantity), items, total, status (ok / check / cancelled), check reason, messages
   - One row per phone. If a phone ordered in two chats, merge and mark check.
   - Totals = quantity × menu price, computed in the script.
   - Also update `~/Desktop/Orders/All orders.csv`: replace rows with the same date + phone, append the rest.
8. **Finish:** delete the temp folder, `open` the daily CSV, and tell the owner in one or two lines: "Today: N orders, $X total. M need a quick look (marked check)."
