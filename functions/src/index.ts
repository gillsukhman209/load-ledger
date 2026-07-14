import * as admin from "firebase-admin";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { onRequest } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import cors from "cors";
import express from "express";
import * as fs from "fs";
import { google } from "googleapis";
import path from "path";

admin.initializeApp();

const db = getFirestore();
const app = express();
const gmailAccountBackupPath = path.join(__dirname, "../.gmail-accounts.local.json");

app.use(cors({ origin: true }));
app.use(express.json({ limit: "2mb" }));
app.use("/dashboard", express.static(path.join(__dirname, "../public/dashboard"), {
  etag: false,
  lastModified: false,
  setHeaders(response) {
    response.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  }
}));

type RelayTrip = {
  tripId?: string;
  parentTourId?: string;
  driver?: string;
  status?: string;
  pickup?: string;
  dropoff?: string;
  startTime?: string;
  endTime?: string;
  miles?: number | string;
  payout?: number | string;
  equipment?: string;
  loadCount?: number | string;
};

type GmailLoad = {
  source: "gmail";
  emailId: string;
  gmailAccount?: string;
  emailSubject?: string;
  emailFrom?: string;
  emailDate?: string;
  amazonTripId?: string;
  amazonLoadId?: string;
  shortCode?: string;
  origin?: string;
  destination?: string;
  payout?: number | null;
  gmailPayout?: number | null;
  totalMiles?: number | null;
  pickupDate?: string;
  bookedAt?: string;
  driverName?: string;
  status: string;
  invoiceStatus?: string;
  paid?: boolean;
  notes?: string;
  missingFromTrips: boolean;
  rawEmailText?: string;
  createdAt: FirebaseFirestore.FieldValue;
  updatedAt: FirebaseFirestore.FieldValue;
};

type RelaySettlement = {
  settlementId?: string;
  carrierId?: string;
  paymentAccountType?: string;
  invoiceStatus?: string;
  paymentStatus?: string;
  displayStatus?: string;
  amount?: number | null;
  amountExcludingTax?: number | null;
  contextId?: string;
  contextYear?: number | string;
  contextWeek?: number | string;
  weekStartDate?: string;
  weekEndDate?: string;
  billingCycle?: string;
  workType?: string;
  settlementNumber?: string;
  invoiceBillingType?: string;
  friendlyDisputeId?: string;
  vrIds?: string[];
  tourIds?: string[];
  invoiceDate?: string;
  expectedPaymentDate?: string;
  paymentInitiationDate?: string;
  creditNote?: boolean;
  sourceUrl?: string;
};

type GmailMessageDetails = {
  id: string;
  subject: string;
  from: string;
  date: string;
  text: string;
};

type GmailSyncOptions = {
  maxResults?: number;
  lookbackDays?: number;
  trigger?: "manual" | "scheduled";
};

type GmailSyncResult = {
  ok: true;
  processed: number;
  upserted: number;
  skipped: number;
  noAccounts?: boolean;
  message?: string;
  errors: string[];
  accounts: Array<{ email: string; processed: number; upserted: number }>;
};

function now() {
  return FieldValue.serverTimestamp();
}

function getEnv(name: string) {
  return process.env[name] || "";
}

function envNumber(name: string, fallback: number, min: number, max: number) {
  return clampNumber(getEnv(name), min, max, fallback);
}

function clampNumber(value: unknown, min: number, max: number, fallback: number) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(Math.round(number), min), max);
}

function boundedDecimal(value: unknown, min: number, max: number, fallback: number) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.round(Math.min(Math.max(number, min), max) * 100) / 100;
}

function oauthClient() {
  return new google.auth.OAuth2(
    getEnv("GOOGLE_CLIENT_ID"),
    getEnv("GOOGLE_CLIENT_SECRET"),
    getEnv("GOOGLE_REDIRECT_URI")
  );
}

function readLocalGmailAccountBackups(): Record<string, { email: string; refreshToken: string; tokenScope?: string }> {
  try {
    return JSON.parse(fs.readFileSync(gmailAccountBackupPath, "utf8"));
  } catch {
    return {};
  }
}

function saveLocalGmailAccountBackup(account: { email: string; refreshToken: string; tokenScope?: string }) {
  if (!account.refreshToken) return;
  const accounts = readLocalGmailAccountBackups();
  accounts[account.email] = account;
  fs.writeFileSync(gmailAccountBackupPath, JSON.stringify(accounts, null, 2));
}

async function restoreLocalGmailAccountsIfEmpty() {
  const existing = await db.collection("gmailAccounts").limit(1).get();
  if (!existing.empty) return;

  const accounts = readLocalGmailAccountBackups();
  for (const account of Object.values(accounts)) {
    if (!account.email || !account.refreshToken) continue;
    await db.collection("gmailAccounts").doc(account.email).set(
      {
        email: account.email,
        refreshToken: account.refreshToken,
        tokenScope: account.tokenScope || "",
        restoredFromLocalBackupAt: now(),
        updatedAt: now()
      },
      { merge: true }
    );
  }
}

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "Relay Load Ledger",
    backend: "firebase-functions",
    firestoreProject: process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || "local"
  });
});

app.get("/auth/google/start", (_req, res) => {
  const client = oauthClient();
  const url = client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent select_account",
    include_granted_scopes: false,
    scope: [
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/userinfo.email"
    ]
  });
  res.redirect(url);
});

app.get("/auth/google/callback", async (req, res) => {
  const code = String(req.query.code || "");
  if (!code) {
    res.status(400).send("Missing Google OAuth code.");
    return;
  }

  const client = oauthClient();
  const { tokens } = await client.getToken(code);
  client.setCredentials(tokens);

  const oauth2 = google.oauth2({ version: "v2", auth: client });
  const profile = await oauth2.userinfo.get();
  const email = profile.data.email;
  if (!email) {
    res.status(400).send("Google account did not return an email address.");
    return;
  }

  const existing = await db.collection("gmailAccounts").doc(email).get();
  const existingRefreshToken = existing.data()?.refreshToken || "";
  const existingScope = existing.data()?.tokenScope || "";
  const refreshToken = tokens.refresh_token || existingRefreshToken;
  const tokenScope = tokens.scope || existingScope || "";
  if (!hasGmailReadScope(tokenScope)) {
    await db.collection("gmailAccounts").doc(email).set(
      {
        email,
        connectionError: "Gmail read permission was not granted.",
        tokenScope,
        updatedAt: now()
      },
      { merge: true }
    );
    res.status(400).send(`
      <!doctype html>
      <html>
        <head><title>Gmail Permission Missing</title></head>
        <body style="font-family: system-ui; padding: 32px; max-width: 720px;">
          <h1>Gmail permission missing</h1>
          <p>Google did not grant Gmail read access, so Relay Load Ledger cannot sync emails yet.</p>
          <p>Go back to the dashboard, click <strong>Connect Gmail</strong>, choose the Gmail account, and approve Gmail read access.</p>
        </body>
      </html>
    `);
    return;
  }

  if (!refreshToken) {
    await db.collection("gmailAccounts").doc(email).set(
      {
        email,
        connectionError: "Google did not return a refresh token.",
        tokenScope,
        updatedAt: now()
      },
      { merge: true }
    );
    res.status(400).send(`
      <!doctype html>
      <html>
        <head><title>Gmail Reconnect Needed</title></head>
        <body style="font-family: system-ui; padding: 32px; max-width: 720px;">
          <h1>Gmail reconnect needed</h1>
          <p>Google did not return a new long-term Gmail token. Return to the dashboard and click <strong>Connect Gmail</strong> again.</p>
        </body>
      </html>
    `);
    return;
  }

  await db.collection("gmailAccounts").doc(email).set(
    {
      email,
      refreshToken,
      tokenScope,
      connectionError: "",
      connectedAt: now(),
      updatedAt: now()
    },
    { merge: true }
  );
  saveLocalGmailAccountBackup({ email, refreshToken, tokenScope: tokens.scope || "" });

  res.send(`
    <!doctype html>
    <html>
      <head><title>Gmail Connected</title></head>
      <body style="font-family: system-ui; padding: 32px;">
        <h1>Gmail connected</h1>
        <p>${email} is connected to Relay Load Ledger.</p>
        <p>You can close this tab and return to the dashboard.</p>
      </body>
    </html>
  `);
});

function hasGmailReadScope(scope: unknown) {
  const scopes = String(scope || "").split(/\s+/);
  return scopes.includes("https://www.googleapis.com/auth/gmail.readonly") || scopes.includes("https://mail.google.com/");
}

app.get("/gmail/accounts", async (_req, res) => {
  await restoreLocalGmailAccountsIfEmpty();
  const accounts = await db.collection("gmailAccounts").get();
  res.json({
    ok: true,
    accounts: accounts.docs.map((doc) => {
      const data = doc.data();
      return {
        email: data.email || doc.id,
        connectedAt: data.connectedAt || "",
        updatedAt: data.updatedAt || "",
        lastGmailSyncAt: data.lastGmailSyncAt || "",
        lastGmailSyncProcessed: data.lastGmailSyncProcessed || 0,
        lastGmailSyncUpserted: data.lastGmailSyncUpserted || 0,
        lastGmailSyncError: data.lastGmailSyncError || data.connectionError || "",
        hasRefreshToken: Boolean(data.refreshToken)
      };
    })
  });
});

app.post("/gmail/sync", async (req, res) => {
  const result = await runGmailSync({
    maxResults: Number(req.body?.maxResults || req.query.maxResults || 1000),
    lookbackDays: Number(req.body?.lookbackDays || req.query.lookbackDays || 365),
    trigger: "manual"
  });
  res.json(result);
});

async function runGmailSync(options: GmailSyncOptions = {}): Promise<GmailSyncResult> {
  await restoreLocalGmailAccountsIfEmpty();
  const accounts = await db.collection("gmailAccounts").get();
  if (accounts.empty) {
    const result: GmailSyncResult = {
      ok: true,
      processed: 0,
      upserted: 0,
      skipped: 0,
      noAccounts: true,
      message: "No Gmail account is connected.",
      errors: [],
      accounts: []
    };
    await recordGmailSyncRun(options, result);
    return result;
  }

  const maxResults = clampNumber(options.maxResults, 1, 5000, 1000);
  const lookbackDays = clampNumber(options.lookbackDays, 1, 3650, 365);
  let processed = 0;
  let upserted = 0;
  let skipped = 0;
  const errors: string[] = [];
  const accountSummaries: Array<{ email: string; processed: number; upserted: number }> = [];

  for (const accountDoc of accounts.docs) {
    const account = accountDoc.data();
    if (!account.refreshToken) continue;
    let accountProcessed = 0;
    let accountUpserted = 0;
    let accountError = "";

    const client = oauthClient();
    client.setCredentials({ refresh_token: account.refreshToken });
    const gmail = google.gmail({ version: "v1", auth: client });
    let pageToken: string | undefined;

    try {
      while (accountProcessed < maxResults) {
        const remaining = maxResults - accountProcessed;
        const list = await gmail.users.messages.list({
          userId: "me",
          maxResults: Math.min(remaining, 500),
          pageToken,
          q: `("Amazon Relay" OR from:(relay-noreply@amazon.com) OR from:(no-reply@relay.amazon.com) OR from:(amazonrelay@amazon.com) OR "load has been booked" OR "Load ID" OR "Trip ID") newer_than:${lookbackDays}d`
        });

        for (const messageRef of list.data.messages || []) {
          if (!messageRef.id) continue;
          processed += 1;
          accountProcessed += 1;
          try {
            const message = await gmail.users.messages.get({
              userId: "me",
              id: messageRef.id,
              format: "full"
            });

            const details = extractMessageDetails(message.data);
            if (!isLikelyRelayBookingEmail(details)) {
              skipped += 1;
              continue;
            }
            const parsed = parseRelayBookingEmail(details, account.email || accountDoc.id);
            if (!parsed) {
              skipped += 1;
              continue;
            }
            const didUpsert = await upsertGmailLoad(parsed);
            if (didUpsert) {
              upserted += 1;
              accountUpserted += 1;
            } else {
              skipped += 1;
            }
          } catch (error) {
            skipped += 1;
            errors.push(`${messageRef.id}: ${gmailErrorMessage(error)}`);
          }
        }

        pageToken = list.data.nextPageToken || undefined;
        if (!pageToken || (list.data.messages || []).length === 0) break;
      }
    } catch (error) {
      accountError = gmailErrorMessage(error);
      errors.push(`${account.email || accountDoc.id}: ${accountError}`);
    }

    await accountDoc.ref.set(
      {
        lastGmailSyncAt: now(),
        lastGmailSyncProcessed: accountProcessed,
        lastGmailSyncUpserted: accountUpserted,
        lastGmailSyncError: accountError,
        lastGmailSyncLookbackDays: lookbackDays,
        lastGmailSyncMaxResults: maxResults,
        updatedAt: now()
      },
      { merge: true }
    );
    accountSummaries.push({
      email: account.email || accountDoc.id,
      processed: accountProcessed,
      upserted: accountUpserted
    });
  }

  const result: GmailSyncResult = { ok: true, processed, upserted, skipped, errors: errors.slice(0, 10), accounts: accountSummaries };
  await recordGmailSyncRun(options, result);
  return result;
}

async function recordGmailSyncRun(options: GmailSyncOptions, result: GmailSyncResult) {
  await db.collection("gmailSyncRuns").add({
    trigger: options.trigger || "manual",
    lookbackDays: clampNumber(options.lookbackDays, 1, 3650, 365),
    maxResults: clampNumber(options.maxResults, 1, 5000, 1000),
    processed: result.processed,
    upserted: result.upserted,
    skipped: result.skipped,
    noAccounts: Boolean(result.noAccounts),
    errors: result.errors.slice(0, 10),
    accounts: result.accounts,
    createdAt: now()
  });
}

function gmailErrorMessage(error: unknown) {
  const anyError = error as {
    message?: unknown;
    response?: {
      data?: {
        error?: unknown;
        error_description?: unknown;
        errorDetails?: unknown;
      };
    };
    code?: number;
  };
  const responseError = anyError.response?.data?.error;
  const nestedErrorMessage =
    responseError && typeof responseError === "object" && "message" in responseError
      ? String((responseError as { message?: unknown }).message || "")
      : "";
  const nestedErrorStatus =
    responseError && typeof responseError === "object" && "status" in responseError
      ? String((responseError as { status?: unknown }).status || "")
      : "";
  const message = String(
    anyError.response?.data?.error_description ||
      nestedErrorMessage ||
      nestedErrorStatus ||
      (typeof responseError === "string" ? responseError : "") ||
      anyError.message ||
      String(error)
  );
  if (/insufficient/i.test(message)) {
    return "Gmail permission is missing. Click Connect Gmail again and approve Gmail read access.";
  }
  if (/invalid_grant/i.test(message)) {
    return "Gmail connection expired. Click Connect Gmail again.";
  }
  return message;
}

app.post("/gmail/clear-imports", async (_req, res) => {
  const snapshot = await db.collection("loads").where("source", "==", "gmail").get();
  let deleted = 0;

  for (let index = 0; index < snapshot.docs.length; index += 450) {
    const batch = db.batch();
    const docs = snapshot.docs.slice(index, index + 450);
    docs.forEach((doc) => {
      batch.delete(doc.ref);
      deleted += 1;
    });
    await batch.commit();
  }

  res.json({ ok: true, deleted });
});

app.get("/loads", async (req, res) => {
  const limit = Math.min(Number(req.query.limit || 100), 5000);
  const snapshot = await db
    .collection("loads")
    .orderBy("updatedAt", "desc")
    .limit(limit)
    .get();

  res.json({
    ok: true,
    loads: snapshot.docs
      .map((doc) => ({ id: doc.id, ...doc.data() }))
      .filter((load: FirebaseFirestore.DocumentData & { id: string }) => !load.deletedAt)
  });
});

app.get("/settings", async (_req, res) => {
  const snapshot = await db.collection("configuration").doc("dashboard").get();
  const data = snapshot.data() || {};
  res.json({
    ok: true,
    settings: {
      fuelCalculatorEnabled: Boolean(data.fuelCalculatorEnabled),
      fuelMpg: boundedDecimal(data.fuelMpg, 1, 30, 8),
      fuelPricePerGallon: boundedDecimal(data.fuelPricePerGallon, 0, 25, 6.5)
    }
  });
});

app.patch("/settings", async (req, res) => {
  const settings = {
    fuelCalculatorEnabled: Boolean(req.body?.fuelCalculatorEnabled),
    fuelMpg: boundedDecimal(req.body?.fuelMpg, 1, 30, 8),
    fuelPricePerGallon: boundedDecimal(req.body?.fuelPricePerGallon, 0, 25, 6.5)
  };
  await db.collection("configuration").doc("dashboard").set({ ...settings, updatedAt: now() }, { merge: true });
  res.json({ ok: true, settings });
});

app.patch("/loads/:id", async (req, res) => {
  const id = String(req.params.id || "").trim();
  if (!id) {
    res.status(400).json({ ok: false, error: "Missing load ID" });
    return;
  }

  const allowedFields = [
    "driverName",
    "status",
    "paid",
    "paidAt",
    "invoiceStatus",
    "invoiceNumber",
    "notes",
    "manualReview",
    "settlementWeek",
    "origin",
    "destination",
    "pickupDate",
    "tripStartDate"
  ];
  const update: Record<string, unknown> = {};

  for (const field of allowedFields) {
    if (Object.prototype.hasOwnProperty.call(req.body || {}, field)) {
      update[field] = req.body[field];
    }
  }

  if (Object.prototype.hasOwnProperty.call(update, "driverName")) {
    update.driverName = normalizeDriverName(update.driverName || "");
    update.manualDriverOverride = true;
  }

  if (Object.keys(update).length === 0) {
    res.status(400).json({ ok: false, error: "No supported fields to update" });
    return;
  }

  update.updatedAt = now();
  await db.collection("loads").doc(id).set(update, { merge: true });
  res.json({ ok: true, id, updated: Object.keys(update) });
});

app.delete("/loads", async (req, res) => {
  const ids: string[] = Array.isArray(req.body?.ids)
    ? Array.from(new Set<string>(req.body.ids.map((id: unknown) => String(id || "").trim()).filter(Boolean)))
    : [];

  if (ids.length === 0) {
    res.status(400).json({ ok: false, error: "Missing load IDs" });
    return;
  }

  if (ids.length > 5000) {
    res.status(400).json({ ok: false, error: "Too many load IDs. Delete 5000 or fewer at a time." });
    return;
  }

  let deleted = 0;
  for (const id of ids) {
    const ref = db.collection("loads").doc(id);
    const snapshot = await ref.get();
    const data = snapshot.data() || {};
    await tombstoneLoad(id, data);
    await ref.delete();
    deleted += 1;
  }

  res.json({ ok: true, requested: ids.length, deleted });
});

app.get("/tripScans", async (req, res) => {
  const limit = Math.min(Number(req.query.limit || 25), 100);
  const snapshot = await db
    .collection("tripScans")
    .orderBy("createdAt", "desc")
    .limit(limit)
    .get();

  res.json({
    ok: true,
    scans: snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }))
  });
});

app.get("/settlements", async (req, res) => {
  const limit = Math.min(Number(req.query.limit || 300), 1000);
  const snapshot = await db
    .collection("settlements")
    .orderBy("updatedAt", "desc")
    .limit(limit)
    .get();

  res.json({
    ok: true,
    settlements: snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }))
  });
});

app.post("/payments/sync", async (req, res) => {
  const settlements = Array.isArray(req.body.settlements) ? (req.body.settlements as RelaySettlement[]) : [];
  const scanRef = await db.collection("paymentScans").add({
    source: req.body.source || "extension",
    reason: req.body.reason || "",
    pageUrl: req.body.pageUrl || "",
    syncedAt: req.body.syncedAt || new Date().toISOString(),
    settlementCount: settlements.length,
    settlementIds: settlements.map((settlement) => settlement.settlementId).filter(Boolean),
    createdAt: now()
  });

  let upserted = 0;
  let matchedLoads = 0;
  let unmatchedIds = 0;

  for (const settlement of settlements) {
    if (!settlement.settlementId) continue;
    const normalized = normalizeSettlement(settlement);
    const relatedIds = [...new Set([...(normalized.vrIds || []), ...(normalized.tourIds || [])])];
    const matchedLoadIds: string[] = [];
    const unmatchedSettlementIds: string[] = [];
    const settlementRef = db.collection("settlements").doc(`settlement_${normalized.settlementId}`);
    const existingSettlement = await settlementRef.get();

    await settlementRef.set(
      {
        ...normalized,
        relatedIds,
        updatedAt: now(),
        ...(existingSettlement.exists ? {} : { createdAt: now() })
      },
      { merge: true }
    );
    upserted += 1;

    for (const relatedId of relatedIds) {
      if (await isDeletedLoad(relatedId)) {
        continue;
      }

      const match = await findExistingLoadByIds(relatedId, relatedId);
      if (!match) {
        unmatchedSettlementIds.push(relatedId);
        unmatchedIds += 1;
        continue;
      }

      const disputeId = normalized.friendlyDisputeId || match.data.disputeId || match.data.settlementFriendlyDisputeId || "";
      const settlementIsPaid = normalized.paymentStatus === "INITIATED" || normalized.displayStatus === "Paid";

      await match.ref.set(
        {
          source: mergeSource(match.data.source, "settlements"),
          settlementId: normalized.settlementId,
          settlementContextId: normalized.contextId || "",
          settlementAmount: normalized.amount ?? null,
          settlementPaymentStatus: normalized.paymentStatus || "",
          settlementDisplayStatus: normalized.displayStatus || "",
          settlementFriendlyDisputeId: normalized.friendlyDisputeId || match.data.settlementFriendlyDisputeId || "",
          disputeId,
          disputeStatus: normalized.friendlyDisputeId
            ? settlementIsPaid ? "Paid after dispute" : "Disputed"
            : match.data.disputeStatus || "",
          paidAfterDispute: Boolean(match.data.paidAfterDispute || (normalized.friendlyDisputeId && settlementIsPaid)),
          settlementInvoiceDate: normalized.invoiceDate || "",
          settlementExpectedPaymentDate: normalized.expectedPaymentDate || "",
          settlementPaymentInitiationDate: normalized.paymentInitiationDate || "",
          invoiceStatus: invoiceStatusForSettlement(normalized, match.data.invoiceStatus),
          missingFromTrips: sourceHas(match.data.source, "trips") || Boolean(match.data.lastSeenInTripsAt) ? false : match.data.missingFromTrips,
          updatedAt: now()
        },
        { merge: true }
      );
      matchedLoadIds.push(match.ref.id);
      matchedLoads += 1;
    }

    await settlementRef.set(
      {
        matchedLoadIds,
        unmatchedSettlementIds,
        updatedAt: now()
      },
      { merge: true }
    );
  }

  res.json({
    ok: true,
    scanId: scanRef.id,
    received: settlements.length,
    upserted,
    matchedLoads,
    unmatchedIds
  });
});

app.post("/trips/sync", async (req, res) => {
  const trips = Array.isArray(req.body.trips) ? (req.body.trips as RelayTrip[]) : [];
  const scanRef = await db.collection("tripScans").add({
    source: req.body.source || "extension",
    reason: req.body.reason || "",
    pageUrl: req.body.pageUrl || "",
    syncedAt: req.body.syncedAt || new Date().toISOString(),
    tripCount: trips.length,
    tripIds: trips.map((trip) => trip.tripId).filter(Boolean),
    createdAt: now()
  });

  let matched = 0;
  let tripOnly = 0;
  let suppressed = 0;

  for (const trip of trips) {
    if (!trip.tripId) continue;
    if (await isDeletedLoad(trip.tripId, trip.parentTourId || "")) {
      suppressed += 1;
      continue;
    }

    const match = await findMatchingLoad(trip);
    if (match) {
      await match.ref.set(
        {
          source: mergeSource(match.data.source, "trips"),
          amazonTripId: trip.tripId,
          parentTourId: trip.parentTourId || match.data.parentTourId || "",
          driverName: match.data.manualDriverOverride
            ? normalizeDriverName(match.data.driverName || "")
            : normalizeDriverName(trip.driver || match.data.driverName || ""),
          status: mergedTripStatus(match.data.status, trip.status),
          currentTripStatus: mergedTripStatus(match.data.currentTripStatus, trip.status),
          origin: trip.pickup || match.data.origin || "",
          destination: trip.dropoff || match.data.destination || "",
          totalMiles: parsePositiveNumber(trip.miles) ?? match.data.totalMiles ?? null,
          payout: parseMoney(trip.payout) ?? match.data.payout ?? null,
          gmailPayout: match.data.gmailPayout ?? match.data.originalBookedPayout ?? null,
          tripStartDate: trip.startTime || "",
          tripEndDate: trip.endTime || "",
          equipment: trip.equipment || "",
          loadCount: trip.loadCount || "",
          paid: Boolean(match.data.paid),
          invoiceStatus: match.data.invoiceStatus || "Unmatched",
          notes: match.data.notes || "",
          missingFromTrips: false,
          lastSeenInTripsAt: now(),
          updatedAt: now()
        },
        { merge: true }
      );
      matched += 1;
    } else {
      await db.collection("loads").doc(`trip_${trip.tripId}`).set(
        {
          source: "trips",
          amazonTripId: trip.tripId,
          parentTourId: trip.parentTourId || "",
          driverName: normalizeDriverName(trip.driver || ""),
          status: trip.status || "seen_in_trips",
          origin: trip.pickup || "",
          destination: trip.dropoff || "",
          totalMiles: parsePositiveNumber(trip.miles),
          payout: parseMoney(trip.payout),
          tripStartDate: trip.startTime || "",
          tripEndDate: trip.endTime || "",
          equipment: trip.equipment || "",
          loadCount: trip.loadCount || "",
          paid: false,
          invoiceStatus: "Unmatched",
          notes: "",
          missingFromTrips: false,
          firstSeenInTripsAt: now(),
          lastSeenInTripsAt: now(),
          createdAt: now(),
          updatedAt: now()
        },
        { merge: true }
      );
      tripOnly += 1;
    }
  }

  res.json({
    ok: true,
    scanId: scanRef.id,
    received: trips.length,
    matched,
    tripOnly,
    suppressed
  });
});

async function findMatchingLoad(trip: RelayTrip) {
  const tripId = trip.tripId || "";
  if (await isDeletedLoad(tripId, trip.parentTourId || "")) return null;

  const existing = await findExistingLoadByIds(tripId, tripId);
  if (existing) return existing;

  const payout = parseMoney(trip.payout);
  if (payout == null || !trip.pickup || !trip.dropoff) return null;

  const candidates = await db
    .collection("loads")
    .where("payout", "==", payout)
    .where("missingFromTrips", "==", true)
    .limit(10)
    .get();

  const origin = normalizePlace(trip.pickup);
  const destination = normalizePlace(trip.dropoff);
  const doc = candidates.docs.find((candidate) => {
    const data = candidate.data();
    return normalizePlace(data.origin || "") === origin && normalizePlace(data.destination || "") === destination;
  });

  return doc ? { ref: doc.ref, data: doc.data() } : null;
}

async function findExistingLoadByIds(tripId: string, loadId: string) {
  if (await isDeletedLoad(tripId, loadId)) return null;

  for (const normalizedTripId of tripIdVariants(tripId)) {
    const byTrip = await db.collection("loads").where("amazonTripId", "==", normalizedTripId).limit(1).get();
    if (!byTrip.empty) {
      const doc = byTrip.docs[0];
      return { ref: doc.ref, data: doc.data() };
    }
  }

  for (const normalizedLoadId of tripIdVariants(loadId)) {
    const byLoad = await db.collection("loads").where("amazonLoadId", "==", normalizedLoadId).limit(1).get();
    if (!byLoad.empty) {
      const doc = byLoad.docs[0];
      return { ref: doc.ref, data: doc.data() };
    }
  }

  return null;
}

function tripIdVariants(value: string) {
  const id = String(value || "").trim().toUpperCase();
  if (!id) return [];
  const withoutPrefix = id.replace(/^T-/, "");
  return [...new Set([id, withoutPrefix, `T-${withoutPrefix}`])];
}

function deletedLoadKeys(...values: unknown[]) {
  const keys = new Set<string>();
  for (const value of values) {
    const raw = String(value || "").trim();
    if (!raw) continue;
    const upper = raw.toUpperCase();
    const withoutDocPrefix = upper.replace(/^TRIP_/, "");
    const withoutTripPrefix = withoutDocPrefix.replace(/^T-/, "");
    [
      raw,
      upper,
      withoutDocPrefix,
      withoutTripPrefix,
      `T-${withoutTripPrefix}`,
      `TRIP_${withoutTripPrefix}`,
      `TRIP_T-${withoutTripPrefix}`
    ].forEach((key) => {
      const clean = String(key || "").trim();
      if (clean) keys.add(clean);
    });
  }
  return [...keys];
}

function deletedLoadDocId(key: string) {
  return encodeURIComponent(key).replace(/\./g, "%2E");
}

async function isDeletedLoad(...values: unknown[]) {
  const keys = deletedLoadKeys(...values);
  if (keys.length === 0) return false;
  const checks = await Promise.all(
    keys.map((key) => db.collection("deletedLoads").doc(deletedLoadDocId(key)).get())
  );
  return checks.some((snapshot) => snapshot.exists);
}

async function tombstoneLoad(id: string, data: FirebaseFirestore.DocumentData) {
  const keys = deletedLoadKeys(
    id,
    data.amazonTripId,
    data.amazonLoadId,
    data.parentTourId,
    data.emailId
  );
  if (keys.length === 0) return;

  for (let index = 0; index < keys.length; index += 450) {
    const batch = db.batch();
    keys.slice(index, index + 450).forEach((key) => {
      batch.set(
        db.collection("deletedLoads").doc(deletedLoadDocId(key)),
        {
          key,
          originalLoadDocId: id,
          amazonTripId: data.amazonTripId || "",
          amazonLoadId: data.amazonLoadId || "",
          parentTourId: data.parentTourId || "",
          shortCode: data.shortCode || "",
          deletedAt: now(),
          updatedAt: now()
        },
        { merge: true }
      );
    });
    await batch.commit();
  }
}

function sourceHas(source: unknown, value: string) {
  return String(source || "").split("+").includes(value);
}

function mergedTripStatus(existing: unknown, incoming: unknown) {
  const existingStatus = String(existing || "").trim();
  const incomingStatus = String(incoming || "").trim();
  if (isCancelledStatus(existingStatus) && /^history$/i.test(incomingStatus)) return existingStatus;
  return incomingStatus || existingStatus || "seen_in_trips";
}

function isCancelledStatus(value: unknown) {
  return /cancell?ed/i.test(String(value || ""));
}

function mergeSource(source: unknown, value: string) {
  const parts = new Set(String(source || "").split("+").filter(Boolean));
  parts.add(value);
  const ordered = ["trips", "gmail", "settlements"].filter((part) => parts.has(part));
  for (const part of parts) {
    if (!ordered.includes(part)) ordered.push(part);
  }
  return ordered.join("+") || value;
}

async function upsertGmailLoad(load: GmailLoad) {
  if (await isDeletedLoad(load.amazonTripId || "", load.amazonLoadId || "", load.emailId || "")) {
    return false;
  }

  const existing = await findExistingLoadByIds(load.amazonTripId || "", load.amazonLoadId || "");
  const existingData = existing?.data || {};
  const hasTripsData = sourceHas(existingData.source, "trips") || Boolean(existingData.lastSeenInTripsAt);
  const docId = load.amazonTripId || load.amazonLoadId || load.emailId;
  const ref = existing?.ref || db.collection("loads").doc(docId);
  const update: Record<string, unknown> = {
    source: mergeSource(existingData.source, "gmail"),
    emailId: load.emailId,
    gmailAccount: load.gmailAccount || existingData.gmailAccount || "",
    emailSubject: load.emailSubject || "",
    emailFrom: load.emailFrom || "",
    emailDate: load.emailDate || "",
    amazonTripId: load.amazonTripId || existingData.amazonTripId || "",
    amazonLoadId: load.amazonLoadId || existingData.amazonLoadId || "",
    shortCode: load.shortCode || existingData.shortCode || "",
    origin: hasTripsData ? existingData.origin || load.origin || "" : load.origin || existingData.origin || "",
    destination: hasTripsData ? existingData.destination || load.destination || "" : load.destination || existingData.destination || "",
    totalMiles: existingData.totalMiles ?? load.totalMiles ?? null,
    payout: existingData.payout ?? load.payout ?? null,
    gmailPayout: existingData.gmailPayout ?? existingData.originalBookedPayout ?? load.payout ?? null,
    originalBookedPayout: existingData.originalBookedPayout ?? existingData.gmailPayout ?? load.payout ?? null,
    pickupDate: load.pickupDate || existingData.pickupDate || "",
    bookedAt: load.bookedAt || existingData.bookedAt || "",
    driverName: normalizeDriverName(existingData.driverName || load.driverName || ""),
    status: hasTripsData ? existingData.status || "seen_in_trips" : existingData.status || load.status,
    invoiceStatus: existingData.invoiceStatus || load.invoiceStatus || "Unmatched",
    paid: Boolean(existingData.paid || load.paid),
    notes: existingData.notes || load.notes || "",
    missingFromTrips: hasTripsData ? false : true,
    rawEmailText: load.rawEmailText || "",
    updatedAt: now()
  };

  if (!existing) update.createdAt = now();
  await ref.set(update, { merge: true });
  return true;
}

function parseRelayBookingEmail(message: GmailMessageDetails, gmailAccount: string): GmailLoad | null {
  const rawEmailText = normalizeEmailText(`${message.subject}\n${message.text}`);
  const tripId = findTripId(rawEmailText);
  const loadId = findLoadId(rawEmailText, tripId);
  const payout = parseMoney(
    firstMatch(rawEmailText, [
      /(?:payout|price|rate|total|estimated\s+earnings)\D{0,30}(\$[\d,]+(?:\.\d{2})?)/i,
      /(\$[\d,]+(?:\.\d{2})?)/
    ])
  );
  const route = findRoute(rawEmailText);
  const shortCode = rawEmailText.match(/#([a-z0-9]{3,10})/i)?.[1] || "";
  const pickupDate = findPickupDate(rawEmailText);
  const totalMiles = findTotalMiles(rawEmailText);

  if (!isUsableBookingLoad({ tripId, loadId, route, payout, rawEmailText })) {
    return null;
  }

  return {
    source: "gmail",
    emailId: message.id,
    gmailAccount,
    emailSubject: message.subject,
    emailFrom: message.from,
    emailDate: message.date,
    amazonTripId: tripId || "",
    amazonLoadId: loadId || "",
    shortCode: shortCode || "",
    origin: route.origin,
    destination: route.destination,
    totalMiles,
    payout: payout ?? null,
    gmailPayout: payout ?? null,
    pickupDate,
    bookedAt: message.date || "",
    driverName: "",
    status: "booked",
    missingFromTrips: true,
    invoiceStatus: "Unmatched",
    paid: false,
    notes: "",
    rawEmailText: rawEmailText.slice(0, 12000),
    createdAt: now(),
    updatedAt: now()
  };
}

function extractMessageDetails(message: any): GmailMessageDetails {
  const headers = message.payload?.headers || [];
  const header = (name: string) =>
    headers.find((entry: any) => String(entry.name || "").toLowerCase() === name.toLowerCase())?.value || "";
  return {
    id: message.id || "",
    subject: header("Subject"),
    from: header("From"),
    date: header("Date"),
    text: extractMessageText(message)
  };
}

function extractMessageText(message: any): string {
  const parts: string[] = [];
  walkMessageParts(message.payload, parts);
  return parts.join("\n").replace(/\s+\n/g, "\n").trim();
}

function walkMessageParts(part: any, output: string[]) {
  if (!part) return;
  const data = part.body?.data;
  if (data && (part.mimeType === "text/plain" || part.mimeType === "text/html")) {
    output.push(Buffer.from(data, "base64url").toString("utf8").replace(/<[^>]+>/g, " "));
  }
  for (const child of part.parts || []) walkMessageParts(child, output);
}

function parseMoney(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(String(value).replace(/[$,]/g, ""));
  return Number.isFinite(number) ? number : null;
}

function parsePositiveNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(String(value).replace(/,/g, ""));
  return Number.isFinite(number) && number > 0 ? number : null;
}

function normalizeDriverName(value: unknown) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  const normalized = text.replace(/[^a-z]/gi, "").toLowerCase();
  if (normalized === "rsingh" || normalized === "ranjitsingh" || normalized === "rajitsingh") {
    return "RANJIT SINGH";
  }
  return text.toUpperCase();
}

function normalizeEmailText(value: string) {
  return String(value)
    .replace(/&nbsp;/gi, " ")
    .replace(/&#x27;/gi, "'")
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&gt;/gi, ">")
    .replace(/&lt;/gi, "<")
    .replace(/&amp;/gi, "&")
    .replace(/\u00a0/g, " ")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function isLikelyRelayBookingEmail(message: GmailMessageDetails) {
  const text = `${message.from}\n${message.subject}\n${message.text}`.toLowerCase();
  const relaySignal = text.includes("amazon relay") || text.includes("@relay.amazon") || text.includes("relay-noreply");
  const bookingSignal =
    text.includes("successfully booked") ||
    text.includes("load has been booked") ||
    text.includes("booked load") ||
    text.includes("booking confirmed") ||
    text.includes("load id") ||
    text.includes("trip id") ||
    /load board\s*-\s*trip\s+[a-z0-9-]{8,14}\s+booked/i.test(text) ||
    /\bT-[A-Z0-9]{6,12}\b/i.test(text);
  return relaySignal && bookingSignal;
}

function firstMatch(text: string, patterns: RegExp[]) {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return match[1].trim();
  }
  return "";
}

function findPickupDate(text: string) {
  const relayStart = text.match(
    /\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2}:\d{2}\b/i
  );
  if (relayStart) return `${titleMonth(relayStart[2])} ${Number(relayStart[1])}`;

  const normalStart = firstMatch(text, [
    /(?:pickup|start)\D{0,50}\b((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),?\s+[A-Za-z]{3,9}\s+\d{1,2})\b/i,
    /\b((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2})(?!:)\b/i
  ]);

  const weekdayMonthDay = normalStart.match(/(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),?\s+([A-Za-z]{3,9})\s+(\d{1,2})/i);
  if (weekdayMonthDay) return `${titleMonth(weekdayMonthDay[1])} ${Number(weekdayMonthDay[2])}`;

  const monthDay = normalStart.match(/([A-Za-z]{3,9})\s+(\d{1,2})/i);
  if (monthDay) return `${titleMonth(monthDay[1])} ${Number(monthDay[2])}`;

  return "";
}

function findTotalMiles(text: string) {
  const match = text.match(/\b([\d,]+(?:\.\d+)?)\s*(?:mi|miles)\b/i);
  return parsePositiveNumber(match?.[1]);
}

function titleMonth(value: string) {
  return value.slice(0, 3).toLowerCase().replace(/^[a-z]/, (letter) => letter.toUpperCase());
}

function findTripId(text: string) {
  const tTrip = text.match(/\bT-[A-Z0-9]{6,12}\b/i)?.[0];
  if (tTrip) return tTrip.toUpperCase();

  const subjectTrip = text.match(/load board\s*-\s*trip\s+([A-Z0-9]{8,12})\s+booked/i)?.[1];
  if (subjectTrip) return subjectTrip.toUpperCase();

  const startsLineTrip = text.match(/\b([A-Z0-9]{8,12})\s+Starts\s+in\b/i)?.[1];
  if (startsLineTrip) return startsLineTrip.toUpperCase();

  return "";
}

function findLoadId(text: string, tripId: string) {
  const ignored = new Set([
    "ACCOUNT",
    "AMAZON",
    "BOOKING",
    "CONTRACT",
    "DETAILS",
    "INVOICE",
    "PAYMENT",
    "RELAY",
    "TRIP",
    "UPDATED"
  ]);
  const candidates = text.match(/\b(?!T-)[A-Z0-9]{8,12}\b/g) || [];
  return candidates.find((candidate) => {
    if (ignored.has(candidate)) return false;
    if (candidate !== candidate.toUpperCase()) return false;
    if (candidate === tripId) return false;
    if (candidate === tripId.replace(/^T-/, "")) return false;
    if (/^\d{5}$/.test(candidate)) return false;
    return /[0-9]/.test(candidate) && /[A-Z]/.test(candidate);
  }) || "";
}

function findRoute(text: string) {
  const oneLine = text
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
  const relayRoute = oneLine.match(
    /\b([A-Z0-9]{3,5})\s+([A-Z][A-Za-z .'-]{1,60}?),\s*(CA|California)\s*(?:>|→|->)\s*([A-Z0-9]{3,5})\s+([A-Z][A-Za-z .'-]{1,60}?),\s*(CA|California)\b/i
  );
  if (relayRoute) {
    return {
      origin: cleanRoutePlace(`${relayRoute[1]} ${titleCasePlace(relayRoute[2])}, ${normalizeState(relayRoute[3])}`),
      destination: cleanRoutePlace(`${relayRoute[4]} ${titleCasePlace(relayRoute[5])}, ${normalizeState(relayRoute[6])}`)
    };
  }

  const labeled = oneLine.match(
    /(?:pickup|origin|from)\D{0,30}([A-Z0-9]{3,5}\s+)?([A-Z][A-Za-z .'-]+,\s*[A-Z]{2})(?:.|\n){0,180}(?:dropoff|destination|to)\D{0,30}([A-Z0-9]{3,5}\s+)?([A-Z][A-Za-z .'-]+,\s*[A-Z]{2})/i
  );
  if (labeled) {
    return {
      origin: cleanRoutePlace(`${labeled[1] || ""}${labeled[2] || ""}`),
      destination: cleanRoutePlace(`${labeled[3] || ""}${labeled[4] || ""}`)
    };
  }

  const arrow = oneLine.match(/([A-Z0-9]{3,5}\s+)?([A-Z][A-Za-z .'-]+,\s*[A-Z]{2})\s*(?:to|->|→|>)\s*([A-Z0-9]{3,5}\s+)?([A-Z][A-Za-z .'-]+,\s*[A-Z]{2})/i);
  if (arrow) {
    return {
      origin: cleanRoutePlace(`${arrow[1] || ""}${arrow[2] || ""}`),
      destination: cleanRoutePlace(`${arrow[3] || ""}${arrow[4] || ""}`)
    };
  }

  return { origin: "", destination: "" };
}

function isUsableBookingLoad(input: {
  tripId: string;
  loadId: string;
  route: { origin: string; destination: string };
  payout: number | null;
  rawEmailText: string;
}) {
  const hasId = Boolean(input.tripId || input.loadId);
  const hasMoney = typeof input.payout === "number" && input.payout > 0;
  const hasRoute = isRealPlace(input.route.origin) && isRealPlace(input.route.destination);
  const text = input.rawEmailText.toLowerCase();
  const hasBookingWords =
    text.includes("booked") ||
    text.includes("accepted") ||
    text.includes("confirmed") ||
    text.includes("load id") ||
    text.includes("trip id");

  return hasBookingWords && hasId && (hasMoney || hasRoute);
}

function isRealPlace(value: string) {
  const text = String(value || "");
  if (!/\b[A-Z]{2}\b/.test(text)) return false;
  if (/amazon\.com|affiliates|privacy|terms|reserved|copyright/i.test(text)) return false;
  return text.length >= 5 && text.length <= 80;
}

function cleanRoutePlace(value: string) {
  return String(value).replace(/\s+/g, " ").trim();
}

function normalizeState(value: string) {
  return /^california$/i.test(value) ? "CA" : value.toUpperCase();
}

function normalizeSettlement(settlement: RelaySettlement) {
  const paymentStatus = String(settlement.paymentStatus || "").trim().toUpperCase();
  const displayStatus =
    String(settlement.displayStatus || "").trim() ||
    (paymentStatus === "INITIATED" ? "Paid" : paymentStatus === "PENDING" ? "Pending" : titleCasePlace(paymentStatus.toLowerCase()));
  const context = normalizeAmazonWeekContext(settlement.contextId || "", settlement.weekStartDate || "", settlement.weekEndDate || "");
  return {
    settlementId: String(settlement.settlementId || "").trim(),
    carrierId: settlement.carrierId || "",
    paymentAccountType: settlement.paymentAccountType || "",
    invoiceStatus: settlement.invoiceStatus || "",
    paymentStatus,
    displayStatus,
    amount: parseMoney(settlement.amount),
    amountExcludingTax: parseMoney(settlement.amountExcludingTax),
    contextId: settlement.contextId || context.contextId || "",
    contextYear: context.contextYear,
    contextWeek: context.contextWeek,
    weekStartDate: context.weekStartDate,
    weekEndDate: context.weekEndDate,
    billingCycle: settlement.billingCycle || "",
    workType: settlement.workType || "",
    settlementNumber: settlement.settlementNumber || "",
    invoiceBillingType: settlement.invoiceBillingType || "",
    friendlyDisputeId: String(settlement.friendlyDisputeId || "").includes("TFP_NULL") ? "" : settlement.friendlyDisputeId || "",
    vrIds: normalizeIdList(settlement.vrIds),
    tourIds: normalizeIdList(settlement.tourIds),
    invoiceDate: settlement.invoiceDate || "",
    expectedPaymentDate: settlement.expectedPaymentDate || "",
    paymentInitiationDate: settlement.paymentInitiationDate || "",
    creditNote: Boolean(settlement.creditNote),
    sourceUrl: settlement.sourceUrl || ""
  };
}

function invoiceStatusForSettlement(settlement: ReturnType<typeof normalizeSettlement>, existingStatus: unknown) {
  const existing = String(existingStatus || "");
  if (existing === "Disputed") return existing;
  if (settlement.paymentStatus === "INITIATED" || settlement.displayStatus === "Paid") return "Paid";
  if (settlement.paymentStatus === "PENDING" || settlement.displayStatus === "Pending") return "Pending";
  return existing || "Matched";
}

function normalizeIdList(value: unknown) {
  if (Array.isArray(value)) {
    return [...new Set(value.map((item) => normalizeRelayId(item)).filter(Boolean))];
  }

  return [...new Set(String(value || "")
    .split(",")
    .map((item) => normalizeRelayId(item))
    .filter(Boolean))];
}

function normalizeRelayId(value: unknown) {
  return String(value || "").trim().toUpperCase();
}

function normalizeAmazonWeekContext(contextId: string, providedStart: string, providedEnd: string) {
  const match = String(contextId || "").match(/^(\d{4})#(\d{1,2})$/);
  if (!match) {
    return {
      contextId: "",
      contextYear: "",
      contextWeek: "",
      weekStartDate: providedStart || "",
      weekEndDate: providedEnd || ""
    };
  }

  const contextYear = Number(match[1]);
  const contextWeek = Number(match[2]);
  const janFirst = new Date(contextYear, 0, 1, 12);
  const firstWeekStart = new Date(contextYear, 0, 1 - janFirst.getDay(), 12);
  const weekStart = new Date(firstWeekStart.getFullYear(), firstWeekStart.getMonth(), firstWeekStart.getDate() + (contextWeek - 1) * 7, 12);
  const weekEnd = new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate() + 6, 12);
  return {
    contextId,
    contextYear,
    contextWeek,
    weekStartDate: providedStart || isoDateKey(weekStart),
    weekEndDate: providedEnd || isoDateKey(weekEnd)
  };
}

function isoDateKey(date: Date) {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function titleCasePlace(value: string) {
  return String(value)
    .toLowerCase()
    .replace(/\b[a-z]/g, (letter) => letter.toUpperCase())
    .replace(/\bCa\b/g, "CA");
}

function normalizePlace(value: string) {
  return String(value).toLowerCase().replace(/[^a-z]/g, "");
}

export const api = onRequest({ timeoutSeconds: 300 }, app);

export const dailyGmailSync = onSchedule(
  {
    schedule: "0 6 * * *",
    timeZone: "America/Los_Angeles",
    timeoutSeconds: 540,
    memory: "512MiB"
  },
  async () => {
    const result = await runGmailSync({
      maxResults: envNumber("DAILY_GMAIL_MAX_RESULTS", 1000, 50, 5000),
      lookbackDays: envNumber("DAILY_GMAIL_LOOKBACK_DAYS", 30, 1, 3650),
      trigger: "scheduled"
    });
    console.log("Daily Gmail sync complete", result);
  }
);
