# Amazon Relay Load Ledger

Chrome extension plus Firebase backend for tracking Amazon Relay loads.

This version scraps the Google Sheets / Apps Script backend. The extension still scans the Amazon Relay Trips page, but Firebase/Firestore is now the central ledger. Gmail booking emails are intended to become the source of truth because they can preserve loads that later disappear from Relay Trips.

## What It Does

- Runs only on Amazon Relay pages.
- Scans Relay Trips for trip IDs, driver, status, route, dates, payout, equipment, and load count.
- Sends Trips scans to a Firebase Functions backend.
- Stores ledger records in Firestore instead of local browser storage or Google Sheets.
- Supports Gmail OAuth so the backend can read Amazon Relay booking emails with Gmail readonly access.
- Matches Trips scans against Gmail-created loads by trip ID, load ID, then route and payout fallback.

## Project Files

- `src/`: Chrome extension.
- `functions/`: Firebase Functions API.
- `functions/public/dashboard/`: local dashboard website.
- `firestore.rules`: locked-down Firestore rules. Reads/writes go through the backend, not directly from the browser.
- `docs/firebase-ledger.md`: backend collection and route notes.

## Firebase Backend Setup

1. Install Firebase CLI if needed:

   ```bash
   npm install -g firebase-tools
   ```

2. Log in:

   ```bash
   firebase login
   ```

3. Install backend dependencies:

   ```bash
   cd /Users/sukhmansingh/Desktop/Coding/2026/extensions/load-ledger/functions
   npm install
   ```

4. Create a local env file:

   ```bash
   cp .env.example .env
   ```

5. Edit `functions/.env` and put your real Google OAuth values there. Do not put the OAuth client secret in extension code. If the secret was pasted into chat or screenshots, regenerate it in Google Cloud first.

6. Use this redirect URI for local testing:

   ```text
   http://localhost:5001/relayloadtracker/us-central1/api/auth/google/callback
   ```

7. Start local Firebase emulators with persistent local data:

   ```bash
   cd /Users/sukhmansingh/Desktop/Coding/2026/extensions/load-ledger
   npm run serve
   ```

   This saves emulator data into `.firebase/emulator-data` when you stop with `Control + C`, so Gmail stays connected next time.

8. If you intentionally want a blank database, use:

   ```bash
   cd /Users/sukhmansingh/Desktop/Coding/2026/extensions/load-ledger
   npm run serve:fresh
   ```

9. Open Gmail connect URL:

   ```text
   http://localhost:5001/relayloadtracker/us-central1/api/auth/google/start
   ```

10. Run Gmail sync after connecting:

   ```bash
   curl -X POST http://localhost:5001/relayloadtracker/us-central1/api/gmail/sync
   ```

## Extension Setup

1. Open `chrome://extensions`.
2. Enable `Developer mode`.
3. Click `Load unpacked`.
4. Select this folder:

   ```text
   /Users/sukhmansingh/Desktop/Coding/2026/extensions/load-ledger
   ```

5. Open the extension options.
6. Set Firebase backend URL:

   ```text
   http://localhost:5001/relayloadtracker/us-central1/api
   ```

7. Save settings.
8. Open Amazon Relay Trips and use the popup `Sync Now` button or wait for auto-sync.

## Dashboard

After the emulator is running, open:

```text
http://127.0.0.1:5001/relayloadtracker/us-central1/api/dashboard/
```

Use the same backend URL as the extension. This single-user deployment does not require an API key:

```text
Backend URL:
http://127.0.0.1:5001/relayloadtracker/us-central1/api
```

The dashboard shows the working ledger with:

- payout totals
- unpaid totals
- needs-review count
- Gmail missing from Trips count
- driver totals
- recent syncs
- search and filters
- source filter for Trips, Gmail, and Gmail-only records
- paid checkbox
- invoice status
- notes

## Gmail Sync

Gmail sync is managed from the dashboard.

1. Open the dashboard:

   ```text
   http://127.0.0.1:5001/relayloadtracker/us-central1/api/dashboard/
   ```

2. Click `Connect Gmail`.
3. Approve Gmail readonly access.
4. Return to the dashboard.
5. Click `Sync Gmail`.

Gmail-created loads are saved with source `gmail`. If a Gmail load has not been seen on the Relay Trips page, the dashboard marks it as `Gmail only` and counts it under `Gmail missing from Trips`.

Recommended workflow:

```text
Sync Gmail first
Open Amazon Relay Trips and click Sync Now
Review Gmail only / Needs review rows in the dashboard
```

## Deploy

Deploy after local testing:

```bash
cd /Users/sukhmansingh/Desktop/Coding/2026/extensions/load-ledger/functions
cd ..
firebase deploy --only functions
```

After deploy, update the extension Firebase backend URL to the deployed function URL ending in `/api`.

## Current Limits

- Gmail parsing is a first pass. It should be tuned using real Amazon Relay booking email samples.
- The Relay Trips scanner remains read-only. It does not click booking buttons or modify Relay.
- Firestore is intentionally blocked from direct browser access. The extension talks only to Firebase Functions.
