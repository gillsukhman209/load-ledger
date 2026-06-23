const tripCount = document.querySelector("#tripCount");
const lastSyncAt = document.querySelector("#lastSyncAt");
const message = document.querySelector("#message");
const syncNow = document.querySelector("#syncNow");
const openOptions = document.querySelector("#openOptions");

refreshStatus();

syncNow.addEventListener("click", async () => {
  message.textContent = "Syncing...";
  const tab = await getActiveTab();
  if (!tab?.id) {
    message.textContent = "Open Amazon Relay Trips first.";
    return;
  }

  chrome.tabs.sendMessage(tab.id, { type: "RELAY_LEDGER_SYNC_NOW" }, (response) => {
    if (chrome.runtime.lastError || !response?.ok) {
      message.textContent = response?.error || "Open Amazon Relay Trips first.";
      return;
    }
    message.textContent = `Synced ${response.result.sent || 0} trips.`;
    refreshStatus();
  });
});

openOptions.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

async function refreshStatus() {
  const tab = await getActiveTab();
  if (!tab?.id) return;

  chrome.tabs.sendMessage(tab.id, { type: "RELAY_LEDGER_GET_STATUS" }, async (response) => {
    if (chrome.runtime.lastError || !response?.ok) {
      const stored = await chrome.storage.local.get(["lastSyncAt", "lastSyncResult"]);
      lastSyncAt.textContent = formatDate(stored.lastSyncAt);
      message.textContent = "Open Amazon Relay Trips to scan.";
      return;
    }

    tripCount.textContent = String(response.tripCount || 0);
    lastSyncAt.textContent = formatDate(response.lastSyncAt);
    if (!response.isTripsPage) message.textContent = "Open the Relay Trips page to scan.";
  });
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function formatDate(value) {
  if (!value) return "Never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Never";
  return date.toLocaleString();
}
