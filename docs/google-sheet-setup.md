# Google Sheet export

The bot copies orders, customers and payments into a Google Sheet about every 30 seconds after something changes. The Sheet is a **read-only view**: edits made in it are overwritten on the next sync. Change data through WhatsApp commands (`PAID`, `VERIFY`, `BLOCK`, …).

## Tabs

| Tab | What's in it |
|---|---|
| `Orders YYYY-MM-DD` | One per menu day, newest first. Header with confirmed count and total, kitchen totals per item, then every order sorted confirmed → unconfirmed → cancelled, then by area and name. Rewritten while that day's orders change; it stays as-is afterwards. |
| `Customers` | Phone, name, area, address, status, notes, balance owed, payments waiting to be verified, last order date, joined date. |
| `Payments` | Every payment, newest first. Customer-reported ones show **To verify** until the owner taps Verify or Reject. |

Money columns are plain numbers in dollars, so `SUM()` and filters work. Everything is written as raw text and numbers, so a customer name that looks like a formula stays text.

## Setup (about 10 minutes)

1. **Create the Sheet** in the owner's Google account. Copy its id from the URL: `docs.google.com/spreadsheets/d/<SHEET_ID>/edit`.
2. **Google Cloud project:** at [console.cloud.google.com](https://console.cloud.google.com), create a project (or reuse one) and enable the **Google Sheets API** (APIs & Services → Library).
3. **Service account:** IAM & Admin → Service Accounts → Create. It needs no roles. Open it → Keys → Add key → JSON. A key file downloads.
4. **Share the Sheet** with the service account's email (`…@….iam.gserviceaccount.com`) as **Editor**.
5. **Configure the bot:**
   - Laptop: save the key as `secrets/sheets-key.json` (git-ignored), then set `GOOGLE_SERVICE_ACCOUNT_JSON=./secrets/sheets-key.json` and `SHEET_ID=<id>` in `.env`.
   - Cloud Run: store the key JSON in Secret Manager and add `--set-secrets GOOGLE_SERVICE_ACCOUNT_JSON=sheets-key:latest --set-env-vars SHEET_ID=<id>`.
6. Restart. The log shows `sheet synced` with the tabs written. If both variables are unset, the bot logs `Google Sheet sync off` and runs normally.

## When it fails

A failed sync is retried on the next run (30 s later). After 3 failures in a row the bot logs an `ERROR` with `alert=sheet_sync_failing`, which Sentry turns into an alert. Common causes: the Sheet isn't shared with the service account (403), the Sheets API isn't enabled (403), or `SHEET_ID` is wrong (404).

Treat the key file like a password. If it leaks, delete the key in Google Cloud and create a new one.
