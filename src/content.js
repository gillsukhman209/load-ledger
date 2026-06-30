const DEFAULT_SETTINGS = {
  backendBaseUrl: "",
  apiKey: "",
  autoSync: true,
  syncIntervalMinutes: 15,
  dateRangeDays: 60
};

const STATE = {
  tripsById: new Map(),
  settlementsById: new Map(),
  lastSyncAt: null,
  lastSyncResult: null,
  intervalId: null,
  urlWatchIntervalId: null,
  tripRescanTimerId: null,
  mutationObserver: null,
  injectionComplete: false,
  pageScopeKey: "",
  lastLocationHref: window.location.href,
  lastDomSignature: ""
};

const LOG_PREFIX = "[Relay Trips Ledger]";

init();

async function init() {
  log("content script started", { url: window.location.href, isTripsPage: isTripsPage() });
  refreshPageScope();
  injectPageHook();
  window.addEventListener("message", onPageMessage);
  chrome.runtime.onMessage.addListener(onRuntimeMessage);

  const settings = await getSettings();
  log("settings loaded", sanitizeSettings(settings));
  scheduleAutoSync(settings);
  startTripAutoScanner();

  setTimeout(() => {
    if (isTripsPage()) scanDomForTrips();
  }, 2500);
  setTimeout(() => {
    if (isTripsPage()) syncTrips("page-open");
  }, 5000);
}

function startTripAutoScanner() {
  if (STATE.urlWatchIntervalId) window.clearInterval(STATE.urlWatchIntervalId);
  STATE.urlWatchIntervalId = window.setInterval(() => {
    if (STATE.lastLocationHref === window.location.href) return;
    const previousUrl = STATE.lastLocationHref;
    STATE.lastLocationHref = window.location.href;
    log("Relay URL changed", { previousUrl, nextUrl: STATE.lastLocationHref, isTripsPage: isTripsPage() });
    if (isTripsPage()) scheduleTripRescanSync("trip-page-url-change", 1800);
  }, 750);

  if (STATE.mutationObserver) STATE.mutationObserver.disconnect();
  STATE.mutationObserver = new MutationObserver(() => {
    if (!isTripsPage()) return;
    scheduleTripRescanSync("trip-page-dom-change", 1800);
  });

  if (document.body) {
    STATE.mutationObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
  } else {
    window.setTimeout(startTripAutoScanner, 500);
  }
}

function scheduleTripRescanSync(reason, delayMs = 1500) {
  if (STATE.tripRescanTimerId) window.clearTimeout(STATE.tripRescanTimerId);
  STATE.tripRescanTimerId = window.setTimeout(async () => {
    if (!isTripsPage()) return;
    refreshPageScope();
    const signature = visibleTripsSignature();
    if (!signature || signature === STATE.lastDomSignature) return;
    STATE.lastDomSignature = signature;
    log("visible Trips page changed; scanning and syncing", { reason, signature });
    scanDomForTrips();
    try {
      await syncTrips(reason);
    } catch (error) {
      warn("auto Trips sync failed", error);
    }
  }, delayMs);
}

function visibleTripsSignature() {
  if (!document.body) return "";
  const text = document.body.innerText || "";
  const ids = [...new Set(text.match(/\b(?:T-[A-Z0-9]+|[0-9A-Z]{9})\b/g) || [])].sort();
  if (ids.length === 0) return "";
  const dateRange = text.match(/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}\s*-\s*(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)?\s*\d{1,2}\b/i)?.[0] || "";
  return `${currentPageScopeKey()}|${dateRange}|${ids.join(",")}`;
}

function injectPageHook() {
  if (STATE.injectionComplete) return;
  STATE.injectionComplete = true;
  const script = document.createElement("script");
  script.src = chrome.runtime.getURL("src/page-hook.js");
  script.onload = () => {
    log("page hook injected");
    script.remove();
  };
  script.onerror = () => warn("page hook failed to inject");
  (document.documentElement || document.head).appendChild(script);
}

function onPageMessage(event) {
  if (event.source !== window) return;
  if (event.data?.type !== "RELAY_TRIPS_LEDGER_RESPONSE") return;
  refreshPageScope();
  const settlements = extractSettlements(event.data.payload, event.data.url);
  if (settlements.length > 0) {
    log("parsed settlements from Relay Payments JSON", {
      count: settlements.length,
      settlementIds: settlements.map((settlement) => settlement.settlementId),
      url: event.data.url
    });
    upsertSettlements(settlements);
    syncSettlements("network").catch((error) => warn("network-triggered payment sync failed", error));
    return;
  }

  const trips = extractTrips(event.data.payload, event.data.url);
  if (trips.length === 0) {
    log("captured Relay JSON response, but no trip or payment entities were found", { url: event.data.url });
    return;
  }
  log("parsed trips from Relay JSON", {
    count: trips.length,
    tripIds: trips.map((trip) => trip.tripId),
    url: event.data.url
  });
  upsertTrips(trips);
  syncTrips("network").catch((error) => warn("network-triggered sync failed", error));
}

function refreshPageScope() {
  const nextKey = currentPageScopeKey();
  if (!STATE.pageScopeKey) {
    STATE.pageScopeKey = nextKey;
    return;
  }
  if (STATE.pageScopeKey !== nextKey) {
    log("Relay page scope changed; clearing cached trips", {
      previousScope: STATE.pageScopeKey,
      nextScope: nextKey,
      previousCachedTrips: STATE.tripsById.size
    });
    STATE.tripsById.clear();
    STATE.pageScopeKey = nextKey;
  }
}

function currentPageScopeKey() {
  try {
    const url = new URL(window.location.href);
    const keys = ["hstrtdt", "henddt", "asstrtdt", "asenddt", "aslctntyp", "hsrtb", "hsrtdrctn"];
    const parts = keys.map((key) => `${key}=${url.searchParams.get(key) || ""}`);
    return `${url.pathname}?${parts.join("&")}`;
  } catch (_error) {
    return window.location.href;
  }
}

function onRuntimeMessage(message, _sender, sendResponse) {
  if (message?.type === "RELAY_LEDGER_SYNC_NOW") {
    log("manual sync requested from popup");
    syncTrips("manual")
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: String(error.message || error) }));
    return true;
  }

  if (message?.type === "RELAY_LEDGER_GET_STATUS") {
    sendResponse({
      ok: true,
      tripCount: STATE.tripsById.size,
      lastSyncAt: STATE.lastSyncAt,
      lastSyncResult: STATE.lastSyncResult,
      isTripsPage: isTripsPage()
    });
  }

  if (message?.type === "RELAY_LEDGER_SETTINGS_UPDATED") {
    getSettings().then((settings) => {
      log("settings updated", sanitizeSettings(settings));
      scheduleAutoSync(settings);
    });
  }

  return false;
}

function isTripsPage() {
  return /\/(?:trips|tours)\b/i.test(window.location.pathname) || /(?:trips|tours)/i.test(window.location.href);
}

async function getSettings() {
  const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  return { ...DEFAULT_SETTINGS, ...stored };
}

function scheduleAutoSync(settings) {
  if (STATE.intervalId) window.clearInterval(STATE.intervalId);
  STATE.intervalId = null;

  if (!settings.autoSync) {
    log("auto-sync disabled");
    return;
  }
  const minutes = Number(settings.syncIntervalMinutes) || DEFAULT_SETTINGS.syncIntervalMinutes;
  const intervalMs = Math.max(1, minutes) * 60 * 1000;
  log("auto-sync scheduled", { everyMinutes: Math.max(1, minutes) });
  STATE.intervalId = window.setInterval(() => {
    if (!isTripsPage()) return;
    log("auto-sync interval fired");
    scanDomForTrips();
    syncTrips("interval").catch((error) => warn("interval sync failed", error));
  }, intervalMs);
}

function extractTrips(payload, responseUrl = "") {
  const entities = collectTripEntities(payload);
  return entities.map((entity) => normalizeTripEntity(entity, responseUrl)).filter(Boolean);
}

function extractSettlements(payload, responseUrl = "") {
  if (!payload || typeof payload !== "object") return [];
  const settlements = collectSettlementEntities(payload);
  return settlements.map((settlement) => normalizeSettlement(settlement, responseUrl)).filter(Boolean);
}

function collectSettlementEntities(value, found = []) {
  if (!value || typeof value !== "object") return found;

  if (Array.isArray(value)) {
    value.forEach((item) => collectSettlementEntities(item, found));
    return found;
  }

  if (Array.isArray(value.settlementList)) {
    value.settlementList.forEach((item) => collectSettlementEntities(item, found));
  }

  if (value.id && value.settlementsMetadata && (value.totalAmount || value.paymentStatus || value.invoiceStatus)) {
    found.push(value);
  }

  return found;
}

function normalizeSettlement(settlement, responseUrl) {
  const settlementId = String(settlement.id || "").trim();
  if (!settlementId) return null;

  const metadata = settlement.settlementsMetadata || {};
  const context = parseAmazonWeekContext(metadata.contextId);
  const paymentStatus = String(settlement.paymentStatus || "").trim().toUpperCase();
  const amount = numberOrNull(settlement.totalAmount?.value);

  return {
    settlementId,
    carrierId: settlement.carrierId || "",
    paymentAccountType: settlement.paymentAccountType || "",
    invoiceStatus: settlement.invoiceStatus || "",
    paymentStatus,
    displayStatus: paymentStatus === "INITIATED" ? "Paid" : paymentStatus === "PENDING" ? "Pending" : titleCase(paymentStatus.toLowerCase()),
    amount: amount == null ? null : roundCurrency(amount),
    amountExcludingTax: numberOrNull(settlement.totalAmountExcludingTax?.value),
    contextId: metadata.contextId || "",
    contextYear: context.year || "",
    contextWeek: context.week || "",
    weekStartDate: context.weekStartDate || "",
    weekEndDate: context.weekEndDate || "",
    billingCycle: metadata.billingCycle || "",
    workType: metadata.workType || "",
    settlementNumber: metadata.settlementNumber || "",
    invoiceBillingType: metadata.invoiceBillingType || "",
    friendlyDisputeId: cleanSettlementMetadataValue(metadata.friendlyDisputeId),
    vrIds: splitIds(metadata.vrIds),
    tourIds: splitIds(metadata.tourIds),
    invoiceDate: settlement.invoiceDate || "",
    expectedPaymentDate: settlement.expectedPaymentDate || "",
    paymentInitiationDate: settlement.paymentInitiationDate || "",
    creditNote: Boolean(settlement.creditNote),
    sourceUrl: responseUrl,
    lastSyncedAt: new Date().toISOString()
  };
}

function parseAmazonWeekContext(contextId) {
  const match = String(contextId || "").match(/^(\d{4})#(\d{1,2})$/);
  if (!match) return {};
  const year = Number(match[1]);
  const week = Number(match[2]);
  if (!Number.isFinite(year) || !Number.isFinite(week)) return {};

  const janFirst = new Date(year, 0, 1, 12);
  const firstWeekStart = new Date(year, 0, 1 - janFirst.getDay(), 12);
  const weekStart = new Date(firstWeekStart.getFullYear(), firstWeekStart.getMonth(), firstWeekStart.getDate() + (week - 1) * 7, 12);
  const weekEnd = new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate() + 6, 12);
  return {
    year,
    week,
    weekStartDate: isoDateKey(weekStart),
    weekEndDate: isoDateKey(weekEnd)
  };
}

function isoDateKey(date) {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function splitIds(value) {
  return [...new Set(String(value || "")
    .split(",")
    .map((item) => item.trim().toUpperCase())
    .filter(Boolean))];
}

function cleanSettlementMetadataValue(value) {
  const text = String(value || "").trim();
  if (!text || text.includes("TFP_NULL")) return "";
  return text;
}

function collectTripEntities(value, found = []) {
  if (!value || typeof value !== "object") return found;

  if (Array.isArray(value)) {
    value.forEach((item) => collectTripEntities(item, found));
    return found;
  }

  if (value.entityType === "TOUR" && typeof value.id === "string") {
    found.push(value);
  }

  if (value.entityType === "LOAD" && value.versionedLoadId?.id) {
    found.push(value);
  }

  if (Array.isArray(value.entities)) {
    value.entities.forEach((item) => collectTripEntities(item, found));
  }

  return found;
}

function normalizeTripEntity(entity, responseUrl) {
  if (entity.entityType === "TOUR") return normalizeTour(entity, responseUrl);
  if (entity.entityType === "LOAD") return normalizeLoad(entity, responseUrl);
  return null;
}

function normalizeTour(tour, responseUrl) {
  const tripId = tour.id || tour.tourId;
  if (!tripId) return null;

  const loads = Array.isArray(tour.loads) ? tour.loads : [];
  const stops = loads.flatMap((load) => Array.isArray(load.stops) ? load.stops : []);
  const pickupStops = stops.filter((stop) => String(stop.stopType || "").toUpperCase() === "PICKUP");
  const dropoffStops = stops.filter((stop) => String(stop.stopType || "").toUpperCase() === "DROPOFF");
  const firstPickup = sortBySequence(pickupStops)[0] || sortBySequence(stops)[0];
  const lastDropoff = sortBySequence(dropoffStops).at(-1) || sortBySequence(stops).at(-1);
  const firstLoad = loads[0] || {};
  const firstDriver = findFirstDriver(loads);
  const miles = numberOrNull(tour.totalDistance?.value) ?? sumNumbers(loads.map((load) => load.distance?.value));
  const payout = numberOrNull(tour.payout?.value) ?? sumNumbers(loads.map((load) => load.payout?.value));
  const dollarsPerMile = miles && payout ? roundCurrency(payout / miles) : null;

  return {
    tripId,
    driver: formatDriver(firstDriver),
    status: inferStatus(tour, responseUrl),
    pickup: formatLocation(firstPickup?.location, firstPickup?.locationCode),
    dropoff: formatLocation(lastDropoff?.location, lastDropoff?.locationCode),
    startTime: formatShortDate(tour.firstPickupTime || tour.startTime || plannedTime(firstPickup)),
    endTime: formatShortDate(tour.lastDeliveryTime || tour.endTime || plannedTime(lastDropoff)),
    miles: miles == null ? "" : roundNumber(miles, 2),
    payout: payout == null ? "" : roundCurrency(payout),
    dollarsPerMile: dollarsPerMile == null ? "" : dollarsPerMile,
    equipment: firstLoad.equipmentType || firstLoad.loadType || tour.equipmentType || "",
    loadCount: loads.length || tour.stopCount || "",
    sourceUrl: responseUrl,
    lastSyncedAt: new Date().toISOString()
  };
}

function normalizeLoad(load, responseUrl) {
  const tripId = load.versionedLoadId?.id || load.id || load.tourId;
  if (!tripId) return null;

  const stops = Array.isArray(load.stops) ? load.stops : [];
  const pickupStops = stops.filter((stop) => String(stop.stopType || "").toUpperCase() === "PICKUP");
  const dropoffStops = stops.filter((stop) => String(stop.stopType || "").toUpperCase() === "DROPOFF");
  const firstPickup = sortBySequence(pickupStops)[0] || sortBySequence(stops)[0];
  const lastDropoff = sortBySequence(dropoffStops).at(-1) || sortBySequence(stops).at(-1);
  const firstDriver = Array.isArray(load.driverList) ? load.driverList[0] : null;
  const miles = numberOrNull(load.distance?.value);
  const payout = numberOrNull(load.payout?.value);
  const dollarsPerMile = miles && payout ? roundCurrency(payout / miles) : null;

  return {
    tripId,
    parentTourId: load.tourId || load.parentTourId || "",
    driver: formatDriver(firstDriver),
    status: inferStatus(load, responseUrl),
    pickup: formatLocation(firstPickup?.location, firstPickup?.locationCode),
    dropoff: formatLocation(lastDropoff?.location, lastDropoff?.locationCode),
    startTime: formatShortDate(load.startTime || plannedTime(firstPickup)),
    endTime: formatShortDate(load.endTime || plannedTime(lastDropoff)),
    miles: miles == null ? "" : roundNumber(miles, 2),
    payout: payout == null ? "" : roundCurrency(payout),
    dollarsPerMile: dollarsPerMile == null ? "" : dollarsPerMile,
    equipment: load.equipmentType || load.loadType || "",
    loadCount: 1,
    sourceUrl: responseUrl,
    lastSyncedAt: new Date().toISOString()
  };
}

function sortBySequence(stops) {
  return [...stops].sort((a, b) => (a.stopSequenceNumber || 0) - (b.stopSequenceNumber || 0));
}

function findFirstDriver(loads) {
  for (const load of loads) {
    if (Array.isArray(load.driverList) && load.driverList.length > 0) return load.driverList[0];
  }
  return null;
}

function formatDriver(driver) {
  if (!driver) return "";
  return [driver.firstName, driver.lastName].filter(Boolean).join(" ").trim();
}

function formatLocation(location, fallbackCode = "") {
  if (!location) return fallbackCode || "";
  const cityState = [location.city, location.state].filter(Boolean).join(", ");
  return cityState || location.line1 || fallbackCode || "";
}

function plannedTime(stop) {
  const actions = Array.isArray(stop?.actions) ? stop.actions : [];
  return actions.find((action) => action.plannedTime)?.plannedTime || "";
}

function formatShortDate(value) {
  if (!value) return "";
  const relayDate = String(value).match(/\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),\s+([A-Za-z]{3})\s+(\d{1,2})\b/);
  if (relayDate) return `${relayDate[1]} ${Number(relayDate[2])}`;

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function inferStatus(tour, responseUrl) {
  const explicitStatus = explicitEntityStatus(tour);
  if (explicitStatus) return explicitStatus;

  const url = String(responseUrl || "").toLowerCase();
  if (url.includes("intransit") || url.includes("in-transit")) return "In Transit";
  if (url.includes("upcoming")) return "Upcoming";
  if (url.includes("history")) return "History";

  const state = String(tour.tourState || tour.executionStatus || "").toLowerCase();
  if (state.includes("complete")) return "History";
  if (state.includes("transit") || state.includes("started")) return "In Transit";
  if (state) return titleCase(state.replace(/_/g, " "));
  return currentTabLabel() || "";
}

function explicitEntityStatus(entity) {
  if (!entity || typeof entity !== "object") return "";
  if (entity.cancelled || entity.canceled || entity.isCancelled || entity.isCanceled) return "Cancelled";

  const candidates = [
    entity.status,
    entity.currentTripStatus,
    entity.tripStatus,
    entity.tourStatus,
    entity.tourState,
    entity.loadStatus,
    entity.executionStatus,
    entity.cancellationStatus,
    entity.cancelationStatus,
    entity.cancelledStatus,
    entity.canceledStatus,
    entity.state,
    entity.lifecycleStatus
  ];
  const text = candidates.map((value) => String(value || "")).join(" ").toLowerCase();
  if (/\bcancell?ed\b|\bcancelled\b|\bcanceled\b/.test(text)) return "Cancelled";
  if (/\bin[\s_-]*transit\b|\bstarted\b/.test(text)) return "In Transit";
  if (/\bupcoming\b|\bplanned\b|\bscheduled\b/.test(text)) return "Upcoming";
  if (/\bcomplete(d)?\b|\bdelivered\b|\bhistory\b/.test(text)) return "History";
  return "";
}

function currentTabLabel() {
  const selected = document.querySelector('[aria-selected="true"], [data-selected="true"], .active');
  const text = selected?.textContent?.trim() || "";
  if (/upcoming/i.test(text)) return "Upcoming";
  if (/in\s*transit/i.test(text)) return "In Transit";
  if (/history/i.test(text)) return "History";
  return "";
}

function titleCase(value) {
  return value.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function sumNumbers(values) {
  const numbers = values.map(numberOrNull).filter((value) => value != null);
  if (numbers.length === 0) return null;
  return numbers.reduce((sum, value) => sum + value, 0);
}

function roundNumber(value, decimals) {
  return Number(value.toFixed(decimals));
}

function roundCurrency(value) {
  return Number(value.toFixed(2));
}

function upsertTrips(trips) {
  refreshPageScope();
  const now = new Date().toISOString();
  let inserted = 0;
  let updated = 0;
  for (const trip of trips) {
    const existing = STATE.tripsById.get(trip.tripId);
    if (existing) updated += 1;
    else inserted += 1;
    STATE.tripsById.set(trip.tripId, {
      ...mergeTrip(existing, trip),
      sourcePageKey: STATE.pageScopeKey,
      firstSeenAt: existing?.firstSeenAt || now,
      lastSyncedAt: now
    });
  }
  if (trips.length > 0) {
    log("cached trips", { inserted, updated, totalCached: STATE.tripsById.size });
  }
}

function upsertSettlements(settlements) {
  const now = new Date().toISOString();
  let inserted = 0;
  let updated = 0;
  for (const settlement of settlements) {
    const existing = STATE.settlementsById.get(settlement.settlementId);
    if (existing) updated += 1;
    else inserted += 1;
    STATE.settlementsById.set(settlement.settlementId, {
      ...existing,
      ...settlement,
      firstSeenAt: existing?.firstSeenAt || now,
      lastSyncedAt: now
    });
  }
  log("cached settlements", { inserted, updated, totalCached: STATE.settlementsById.size });
}

function mergeTrip(existing = {}, incoming = {}) {
  const merged = { ...existing };
  for (const [key, value] of Object.entries(incoming)) {
    if (key === "tripId") {
      merged[key] = value;
      continue;
    }
    if (key === "status" && isCancelledStatus(existing.status) && isHistoryStatus(value)) {
      continue;
    }
    if (value !== "" && value !== null && value !== undefined) {
      merged[key] = value;
    } else if (!(key in merged)) {
      merged[key] = value;
    }
  }
  return merged;
}

function isCancelledStatus(value) {
  return /cancell?ed/i.test(String(value || ""));
}

function isHistoryStatus(value) {
  return /^history$/i.test(String(value || ""));
}

function scanDomForTrips() {
  refreshPageScope();
  if (!document.body) {
    log("DOM scan skipped because document.body is not ready");
    return;
  }
  const rowTrips = scanDomRowsForTrips();
  if (rowTrips.length > 0) {
    log("DOM row scan complete", { count: rowTrips.length, tripIds: rowTrips.map((trip) => trip.tripId) });
    upsertTrips(rowTrips);
    return;
  }

  const text = document.body.innerText || "";
  const matches = text.match(/\b(?:T-[A-Z0-9]+|[0-9A-Z]{9})\b/g) || [];
  const uniqueTripIds = [...new Set(matches)];
  log("DOM scan complete", { foundTripIds: uniqueTripIds.length, tripIds: uniqueTripIds });
  const trips = uniqueTripIds.map((tripId) => ({
    tripId,
    driver: "",
    status: currentTabLabel(),
    pickup: "",
    dropoff: "",
    startTime: "",
    endTime: "",
    miles: "",
    payout: "",
    dollarsPerMile: "",
    equipment: "",
    loadCount: "",
    sourceUrl: window.location.href,
    lastSyncedAt: new Date().toISOString()
  }));
  upsertTrips(trips);
}

function scanDomRowsForTrips() {
  const containers = [...document.querySelectorAll("div, li, tr, article")];
  const rowTexts = containers
    .map((element) => element.innerText?.trim() || "")
    .filter((text) => {
      const ids = text.match(/\b(?:T-[A-Z0-9]+|[0-9A-Z]{9})\b/g) || [];
      return ids.length === 1 && /\$\d/.test(text) && /\bmi\b/i.test(text);
    });

  const byId = new Map();
  for (const text of rowTexts) {
    const tripId = text.match(/\b(?:T-[A-Z0-9]+|[0-9A-Z]{9})\b/)?.[0];
    if (!tripId || byId.has(tripId)) continue;
    byId.set(tripId, parseDomTripRow(tripId, text));
  }
  return [...byId.values()];
}

function parseDomTripRow(tripId, text) {
  const lines = text.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const compact = lines.join(" ");
  const moneyMatches = [...compact.matchAll(/\$[\d,]+(?:\.\d+)?/g)].map((match) => match[0]);
  const perMile = compact.match(/\$[\d,]+(?:\.\d+)?\/mi/i)?.[0] || "";
  const payout = moneyMatches.find((value) => value !== perMile.replace(/\/mi/i, "")) || "";
  const miles = compact.match(/\b(\d+(?:\.\d+)?)\s*mi\b/i)?.[1] || "";
  const loadCount = compact.match(/\b(\d+\/\d+)\s+Loads?\b/i)?.[1] || "";
  const equipment = compact.match(/\b(53'\s+(?:Trailer|Container)\s+\w?)\b/i)?.[1] || "";
  const driver = lines.find((line) => /^[A-Z]\.\s+[A-Z]+$/.test(line)) || "";
  const dateLines = lines.filter((line) => /\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),\s+\w{3}\s+\d{1,2}/i.test(line));
  const locationLines = lines.filter((line) => {
    if (line === tripId || line === "Spot") return false;
    if (/^\d+$/.test(line)) return false;
    if (line === driver) return false;
    if (dateLines.includes(line)) return false;
    if (/\$|\/mi|\bmi\b|\bLoads?\b/i.test(line)) return false;
    return /\b[A-Z]{2}\b|\bCalifornia\b/i.test(line);
  });

  return {
    tripId,
    driver,
    status: inferDomStatus(text) || currentTabLabel(),
    pickup: locationLines[0] || "",
    dropoff: locationLines[1] || "",
    startTime: formatShortDate(dateLines[0] || ""),
    endTime: formatShortDate(dateLines[1] || ""),
    miles,
    payout: payout.replace("$", "").replace(/,/g, ""),
    dollarsPerMile: perMile.replace("$", "").replace("/mi", "").replace(/,/g, ""),
    equipment,
    loadCount,
    sourceUrl: window.location.href,
    lastSyncedAt: new Date().toISOString()
  };
}

function inferDomStatus(text) {
  const normalized = String(text || "").toLowerCase();
  if (/\bcancell?ed\b|\bcancelled\b|\bcanceled\b/.test(normalized)) return "Cancelled";
  if (/\bin\s*transit\b/.test(normalized)) return "In Transit";
  if (/\bupcoming\b/.test(normalized)) return "Upcoming";
  return "";
}

async function syncTrips(reason) {
  refreshPageScope();
  log("sync requested", { reason, cachedTrips: STATE.tripsById.size });
  const settings = await getSettings();
  if (!settings.backendBaseUrl) {
    STATE.lastSyncResult = { ok: false, reason: "Missing Firebase backend URL" };
    warn("sync skipped: missing Firebase backend URL", sanitizeSettings(settings));
    return STATE.lastSyncResult;
  }

  scanDomForTrips();
  const scopedTrips = [...STATE.tripsById.values()].filter((trip) => !trip.sourcePageKey || trip.sourcePageKey === STATE.pageScopeKey);
  const trips = hasExplicitRelayDateRange() ? scopedTrips : filterTripsByDate(scopedTrips, settings.dateRangeDays);
  if (trips.length === 0) {
    STATE.lastSyncResult = { ok: true, reason, sent: 0 };
    log("sync skipped: no trips to send", { reason });
    return STATE.lastSyncResult;
  }

  log("sending trips to Firebase backend", {
    reason,
    count: trips.length,
    tripIds: trips.map((trip) => trip.tripId),
    backendBaseUrl: settings.backendBaseUrl
  });

  const body = await chrome.runtime.sendMessage({
    type: "RELAY_LEDGER_POST_SYNC",
    backendBaseUrl: settings.backendBaseUrl,
    apiKey: settings.apiKey,
    payload: {
      source: "amazon-relay-trips-ledger-extension",
      reason,
      pageUrl: window.location.href,
      syncedAt: new Date().toISOString(),
      trips
    }
  });

  if (!body?.ok) {
    warn("Firebase backend returned an error", body);
    throw new Error(body?.error || "Sync failed");
  }

  STATE.lastSyncAt = new Date().toISOString();
  STATE.lastSyncResult = { ok: true, reason, sent: trips.length, response: body };
  await chrome.storage.local.set({ lastSyncAt: STATE.lastSyncAt, lastSyncResult: STATE.lastSyncResult });
  log("sync completed", STATE.lastSyncResult);
  return STATE.lastSyncResult;
}

async function syncSettlements(reason) {
  const settings = await getSettings();
  if (!settings.backendBaseUrl) {
    warn("payment sync skipped: missing Firebase backend URL", sanitizeSettings(settings));
    return { ok: false, reason: "Missing Firebase backend URL" };
  }

  const settlements = [...STATE.settlementsById.values()];
  if (settlements.length === 0) {
    log("payment sync skipped: no settlements to send", { reason });
    return { ok: true, reason, sent: 0 };
  }

  log("sending settlements to Firebase backend", {
    reason,
    count: settlements.length,
    settlementIds: settlements.map((settlement) => settlement.settlementId),
    backendBaseUrl: settings.backendBaseUrl
  });

  const body = await chrome.runtime.sendMessage({
    type: "RELAY_LEDGER_POST_PAYMENTS_SYNC",
    backendBaseUrl: settings.backendBaseUrl,
    apiKey: settings.apiKey,
    payload: {
      source: "amazon-relay-payments-ledger-extension",
      reason,
      pageUrl: window.location.href,
      syncedAt: new Date().toISOString(),
      settlements
    }
  });

  if (!body?.ok) {
    warn("Firebase backend returned a payment sync error", body);
    throw new Error(body?.error || "Payment sync failed");
  }

  log("payment sync completed", body);
  return body;
}

function hasExplicitRelayDateRange() {
  try {
    const params = new URL(window.location.href).searchParams;
    return Boolean((params.get("hstrtdt") && params.get("henddt")) || (params.get("asstrtdt") && params.get("asenddt")));
  } catch (_error) {
    return false;
  }
}

function filterTripsByDate(trips, dateRangeDays) {
  const days = Number(dateRangeDays);
  if (!Number.isFinite(days) || days <= 0) return trips;
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  return trips.filter((trip) => {
    const date = parseTripDate(trip.startTime || trip.endTime || trip.firstSeenAt || "");
    return !Number.isFinite(date) || date >= cutoff;
  });
}

function parseTripDate(value) {
  const text = String(value || "").trim();
  if (!text) return NaN;

  if (/^[A-Za-z]{3}\s+\d{1,2}$/.test(text)) {
    return Date.parse(`${text}, ${new Date().getFullYear()}`);
  }

  if (/^\w{3},\s+\w{3}\s+\d{1,2},\s+\d{1,2}:\d{2}\s+\w{2,4}$/i.test(text)) {
    const currentYear = new Date().getFullYear();
    return Date.parse(text.replace(/,(\s+\d{1,2}:\d{2}\s+\w{2,4})$/i, `, ${currentYear},$1`));
  }

  return Date.parse(text);
}

function sanitizeSettings(settings) {
  return {
    hasBackendBaseUrl: Boolean(settings.backendBaseUrl),
    hasApiKey: Boolean(settings.apiKey),
    autoSync: Boolean(settings.autoSync),
    syncIntervalMinutes: settings.syncIntervalMinutes,
    dateRangeDays: settings.dateRangeDays
  };
}

function log(message, data) {
  if (data === undefined) console.info(`${LOG_PREFIX} ${message}`);
  else console.info(`${LOG_PREFIX} ${message}`, data);
}

function warn(message, data) {
  if (data === undefined) console.warn(`${LOG_PREFIX} ${message}`);
  else console.warn(`${LOG_PREFIX} ${message}`, data);
}
