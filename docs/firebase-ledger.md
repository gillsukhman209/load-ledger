# Firebase Relay Load Ledger

This replaces the old Google Sheets/App Script prototype.

## Collections

- `gmailAccounts`: connected Gmail OAuth accounts and refresh tokens.
- `loads`: permanent load ledger. Gmail-created loads are never deleted.
- `tripScans`: audit trail for each Relay Trips page scan.
- `drivers`: reserved for driver metadata.
- `syncLogs`: reserved for scheduled sync logs.

## Local Setup

1. Install dependencies:

   ```bash
   cd functions
   npm install
   ```

2. Create `functions/.env` from `functions/.env.example`.

3. Do not paste OAuth client secrets into extension code. Regenerate the Google client secret if it was exposed.

4. Start emulators:

   ```bash
   npm run serve
   ```

5. Extension settings for local emulator:

   ```text
   Firebase backend URL:
   http://localhost:5001/relayloadtracker/us-central1/api
   ```

## Routes

- `GET /health`
- `GET /auth/google/start`
- `GET /auth/google/callback`
- `POST /gmail/sync`
- `GET /loads`
- `POST /trips/sync`

## Trips Sync

The existing extension still scans Amazon Relay Trips, but it now posts to:

```text
POST /trips/sync
```

The backend upserts trip-only loads or enriches Gmail-created loads by Trip ID, Load ID, then payout and route fallback.

## Gmail Sync

Gmail is intended to become the permanent source of truth because booked-load emails remain available even if a load disappears from Relay Trips.

The parser is intentionally conservative and should be tuned against real Amazon Relay email samples before relying on it for payroll.
