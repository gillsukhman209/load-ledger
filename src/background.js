const LOG_PREFIX = "[Relay Trips Ledger worker]";
const DEFAULT_BACKEND_BASE_URL = "https://us-central1-relayloadtracker.cloudfunctions.net/api";

chrome.runtime.onInstalled.addListener(async () => {
  const defaults = {
    backendBaseUrl: DEFAULT_BACKEND_BASE_URL,
    apiKey: "",
    autoSync: true,
    syncIntervalMinutes: 15,
    dateRangeDays: 60
  };
  const existing = await chrome.storage.sync.get(Object.keys(defaults));
  const missing = Object.fromEntries(
    Object.entries(defaults).filter(([key]) => existing[key] === undefined)
  );
  if (Object.keys(missing).length > 0) {
    await chrome.storage.sync.set(missing);
    console.info(`${LOG_PREFIX} default settings initialized`, Object.keys(missing));
  }
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "sync") return;
  if (!Object.keys(changes).some((key) => ["autoSync", "syncIntervalMinutes"].includes(key))) return;

  chrome.tabs.query({ url: ["https://relay.amazon.com/*", "https://*.relay.amazon.com/*"] }, (tabs) => {
    for (const tab of tabs) {
      if (tab.id) chrome.tabs.sendMessage(tab.id, { type: "RELAY_LEDGER_SETTINGS_UPDATED" }).catch(() => {});
    }
  });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "RELAY_LEDGER_POST_SYNC" && message?.type !== "RELAY_LEDGER_POST_PAYMENTS_SYNC") return false;

  const path = message.type === "RELAY_LEDGER_POST_PAYMENTS_SYNC" ? "/payments/sync" : "/trips/sync";
  postSync(message.backendBaseUrl, message.apiKey, message.payload, path)
    .then((result) => sendResponse(result))
    .catch((error) => sendResponse({ ok: false, error: String(error.message || error) }));

  return true;
});

async function postSync(backendBaseUrl, apiKey, payload, path) {
  if (!backendBaseUrl) return { ok: false, error: "Missing Firebase backend URL" };
  const syncUrl = `${backendBaseUrl.replace(/\/+$/, "")}${path}`;

  console.info(`${LOG_PREFIX} posting sync payload`, {
    tripCount: Array.isArray(payload?.trips) ? payload.trips.length : 0,
    settlementCount: Array.isArray(payload?.settlements) ? payload.settlements.length : 0,
    reason: payload?.reason,
    syncUrl
  });

  const response = await fetch(syncUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(apiKey ? { "x-ledger-api-key": apiKey } : {})
    },
    body: JSON.stringify(payload)
  });

  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch (_error) {
    body = { raw: text };
  }

  if (!response.ok || body.ok === false) {
    console.warn(`${LOG_PREFIX} sync failed`, { httpStatus: response.status, body });
    return { ok: false, error: body.error || `Sync failed with HTTP ${response.status}` };
  }

  console.info(`${LOG_PREFIX} sync succeeded`, body);
  return body;
}
