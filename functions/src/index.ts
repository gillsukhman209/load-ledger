import * as admin from "firebase-admin";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { onRequest } from "firebase-functions/v2/https";
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
app.use("/dashboard", express.static(path.join(__dirname, "../public/dashboard")));

type RelayTrip = {
  tripId?: string;
  driver?: string;
  status?: string;
  pickup?: string;
  dropoff?: string;
  startTime?: string;
  endTime?: string;
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

type GmailMessageDetails = {
  id: string;
  subject: string;
  from: string;
  date: string;
  text: string;
};

function now() {
  return FieldValue.serverTimestamp();
}

function getEnv(name: string) {
  return process.env[name] || "";
}

function requireApiKey(req: express.Request, res: express.Response, next: express.NextFunction) {
  const expected = getEnv("LEDGER_API_KEY");
  if (!expected) {
    next();
    return;
  }

  const provided = String(req.header("x-ledger-api-key") || "");
  if (provided !== expected) {
    res.status(401).json({ ok: false, error: "Unauthorized" });
    return;
  }

  next();
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
    prompt: "consent",
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
  const refreshToken = tokens.refresh_token || existingRefreshToken;
  await db.collection("gmailAccounts").doc(email).set(
    {
      email,
      refreshToken,
      tokenScope: tokens.scope || "",
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

app.get("/gmail/accounts", requireApiKey, async (_req, res) => {
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
        hasRefreshToken: Boolean(data.refreshToken)
      };
    })
  });
});

app.post("/gmail/sync", requireApiKey, async (req, res) => {
  await restoreLocalGmailAccountsIfEmpty();
  const accounts = await db.collection("gmailAccounts").get();
  if (accounts.empty) {
    res.json({
      ok: true,
      processed: 0,
      upserted: 0,
      skipped: 0,
      noAccounts: true,
      message: "No Gmail account is connected in this Firebase emulator database."
    });
    return;
  }

  const maxResults = Math.min(Number(req.body?.maxResults || req.query.maxResults || 1000), 5000);
  const lookbackDays = Math.min(Number(req.body?.lookbackDays || req.query.lookbackDays || 365), 3650);
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

    const client = oauthClient();
    client.setCredentials({ refresh_token: account.refreshToken });
    const gmail = google.gmail({ version: "v1", auth: client });
    let pageToken: string | undefined;

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
          await upsertGmailLoad(parsed);
          upserted += 1;
          accountUpserted += 1;
        } catch (error) {
          skipped += 1;
          errors.push(`${messageRef.id}: ${String((error as Error).message || error)}`);
        }
      }

      pageToken = list.data.nextPageToken || undefined;
      if (!pageToken || (list.data.messages || []).length === 0) break;
    }

    await accountDoc.ref.set(
      {
        lastGmailSyncAt: now(),
        lastGmailSyncProcessed: accountProcessed,
        lastGmailSyncUpserted: accountUpserted,
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

  res.json({ ok: true, processed, upserted, skipped, errors: errors.slice(0, 10), accounts: accountSummaries });
});

app.post("/gmail/clear-imports", requireApiKey, async (_req, res) => {
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

app.get("/loads", requireApiKey, async (req, res) => {
  const limit = Math.min(Number(req.query.limit || 100), 500);
  const snapshot = await db
    .collection("loads")
    .orderBy("updatedAt", "desc")
    .limit(limit)
    .get();

  res.json({
    ok: true,
    loads: snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }))
  });
});

app.patch("/loads/:id", requireApiKey, async (req, res) => {
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
    "settlementWeek"
  ];
  const update: Record<string, unknown> = {};

  for (const field of allowedFields) {
    if (Object.prototype.hasOwnProperty.call(req.body || {}, field)) {
      update[field] = req.body[field];
    }
  }

  if (Object.keys(update).length === 0) {
    res.status(400).json({ ok: false, error: "No supported fields to update" });
    return;
  }

  update.updatedAt = now();
  await db.collection("loads").doc(id).set(update, { merge: true });
  res.json({ ok: true, id, updated: Object.keys(update) });
});

app.get("/tripScans", requireApiKey, async (req, res) => {
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

app.post("/trips/sync", requireApiKey, async (req, res) => {
  const trips = Array.isArray(req.body.trips) ? (req.body.trips as RelayTrip[]) : [];
  const scanRef = await db.collection("tripScans").add({
    source: req.body.source || "extension",
    reason: req.body.reason || "",
    pageUrl: req.body.pageUrl || "",
    syncedAt: req.body.syncedAt || new Date().toISOString(),
    tripCount: trips.length,
    createdAt: now()
  });

  let matched = 0;
  let tripOnly = 0;

  for (const trip of trips) {
    if (!trip.tripId) continue;
    const match = await findMatchingLoad(trip);
    if (match) {
      await match.ref.set(
        {
          source: mergeSource(match.data.source, "trips"),
          amazonTripId: trip.tripId,
          driverName: trip.driver || match.data.driverName || "",
          status: trip.status || match.data.status || "seen_in_trips",
          currentTripStatus: trip.status || "",
          origin: trip.pickup || match.data.origin || "",
          destination: trip.dropoff || match.data.destination || "",
          payout: parseMoney(trip.payout) ?? match.data.payout ?? null,
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
          driverName: trip.driver || "",
          status: trip.status || "seen_in_trips",
          origin: trip.pickup || "",
          destination: trip.dropoff || "",
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

  await markMissingFromTrips(trips.map((trip) => trip.tripId).filter(Boolean) as string[]);

  res.json({
    ok: true,
    scanId: scanRef.id,
    received: trips.length,
    matched,
    tripOnly
  });
});

async function findMatchingLoad(trip: RelayTrip) {
  const tripId = trip.tripId || "";
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
  const normalizedTripId = String(tripId || "").trim();
  if (normalizedTripId) {
    const byTrip = await db.collection("loads").where("amazonTripId", "==", normalizedTripId).limit(1).get();
    if (!byTrip.empty) {
      const doc = byTrip.docs[0];
      return { ref: doc.ref, data: doc.data() };
    }
  }

  const normalizedLoadId = String(loadId || "").trim();
  if (normalizedLoadId) {
    const byLoad = await db.collection("loads").where("amazonLoadId", "==", normalizedLoadId).limit(1).get();
    if (!byLoad.empty) {
      const doc = byLoad.docs[0];
      return { ref: doc.ref, data: doc.data() };
    }
  }

  return null;
}

function sourceHas(source: unknown, value: "gmail" | "trips") {
  return String(source || "").split("+").includes(value);
}

function mergeSource(source: unknown, value: "gmail" | "trips") {
  const parts = new Set(String(source || "").split("+").filter(Boolean));
  parts.add(value);
  if (parts.has("gmail") && parts.has("trips")) return "gmail+trips";
  if (parts.has("trips")) return "trips";
  return "gmail";
}

async function markMissingFromTrips(seenTripIds: string[]) {
  if (seenTripIds.length === 0) return;
  const gmailLoads = await db.collection("loads").where("source", "==", "gmail").get();
  const seen = new Set(seenTripIds);
  const batch = db.batch();

  gmailLoads.docs.forEach((doc) => {
    const data = doc.data();
    const tripId = data.amazonTripId || data.amazonLoadId || "";
    if (tripId && !seen.has(tripId)) {
      batch.set(
        doc.ref,
        {
          missingFromTrips: true,
          status: "Needs review",
          updatedAt: now()
        },
        { merge: true }
      );
    }
  });

  await batch.commit();
}

async function upsertGmailLoad(load: GmailLoad) {
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
    payout: existingData.payout ?? load.payout ?? null,
    pickupDate: load.pickupDate || existingData.pickupDate || "",
    bookedAt: load.bookedAt || existingData.bookedAt || "",
    driverName: existingData.driverName || load.driverName || "",
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
    payout: payout ?? null,
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

function normalizeEmailText(value: string) {
  return String(value)
    .replace(/&gt;/gi, ">")
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
