const DEFAULT_BACKEND_URL = defaultBackendUrl();
const state = {
  backendUrl: localStorage.getItem("relayLedgerBackendUrl") || DEFAULT_BACKEND_URL,
  apiKey: localStorage.getItem("relayLedgerApiKey") || "",
  gmailLookbackDays: Number(localStorage.getItem("relayLedgerGmailLookbackDays") || 365),
  gmailMaxResults: Number(localStorage.getItem("relayLedgerGmailMaxResults") || 2000),
  loads: [],
  scans: [],
  accounts: [],
  filters: {
    search: "",
    driver: "",
    status: "",
    paid: "",
    invoice: "",
    source: ""
  },
  sort: {
    field: localStorage.getItem("relayLedgerSortField") || "start",
    direction: localStorage.getItem("relayLedgerSortDirection") || "desc"
  }
};

const elements = {
  connectionStatus: document.querySelector("#connectionStatus"),
  connectGmailButton: document.querySelector("#connectGmailButton"),
  syncGmailButton: document.querySelector("#syncGmailButton"),
  clearGmailButton: document.querySelector("#clearGmailButton"),
  refreshButton: document.querySelector("#refreshButton"),
  settingsButton: document.querySelector("#settingsButton"),
  settingsPanel: document.querySelector("#settingsPanel"),
  backendUrlInput: document.querySelector("#backendUrlInput"),
  apiKeyInput: document.querySelector("#apiKeyInput"),
  gmailLookbackDaysInput: document.querySelector("#gmailLookbackDaysInput"),
  gmailMaxResultsInput: document.querySelector("#gmailMaxResultsInput"),
  saveSettingsButton: document.querySelector("#saveSettingsButton"),
  totalLoads: document.querySelector("#totalLoads"),
  totalPayout: document.querySelector("#totalPayout"),
  unpaidPayout: document.querySelector("#unpaidPayout"),
  needsReview: document.querySelector("#needsReview"),
  gmailMissing: document.querySelector("#gmailMissing"),
  searchInput: document.querySelector("#searchInput"),
  driverFilter: document.querySelector("#driverFilter"),
  statusFilter: document.querySelector("#statusFilter"),
  paidFilter: document.querySelector("#paidFilter"),
  invoiceFilter: document.querySelector("#invoiceFilter"),
  sourceFilter: document.querySelector("#sourceFilter"),
  sortField: document.querySelector("#sortField"),
  sortDirection: document.querySelector("#sortDirection"),
  sortHeaders: [...document.querySelectorAll("[data-sort]")],
  gmailAccounts: document.querySelector("#gmailAccounts"),
  driverTotals: document.querySelector("#driverTotals"),
  recentScans: document.querySelector("#recentScans"),
  loadsBody: document.querySelector("#loadsBody"),
  emptyState: document.querySelector("#emptyState"),
  rowTemplate: document.querySelector("#loadRowTemplate")
};

elements.backendUrlInput.value = state.backendUrl;
elements.apiKeyInput.value = state.apiKey;
elements.gmailLookbackDaysInput.value = state.gmailLookbackDays;
elements.gmailMaxResultsInput.value = state.gmailMaxResults;
elements.sortField.value = state.sort.field;
elements.sortDirection.value = state.sort.direction;

elements.refreshButton.addEventListener("click", loadDashboard);
elements.connectGmailButton.addEventListener("click", () => {
  window.open(`${cleanBaseUrl()}/auth/google/start`, "_blank", "noopener,noreferrer");
});
elements.syncGmailButton.addEventListener("click", syncGmail);
elements.clearGmailButton.addEventListener("click", clearGmailImports);
elements.settingsButton.addEventListener("click", () => {
  elements.settingsPanel.hidden = !elements.settingsPanel.hidden;
});
elements.saveSettingsButton.addEventListener("click", () => {
  state.backendUrl = elements.backendUrlInput.value.trim() || DEFAULT_BACKEND_URL;
  state.apiKey = elements.apiKeyInput.value.trim();
  state.gmailLookbackDays = clampNumber(elements.gmailLookbackDaysInput.value, 1, 3650, 365);
  state.gmailMaxResults = clampNumber(elements.gmailMaxResultsInput.value, 50, 5000, 2000);
  localStorage.setItem("relayLedgerBackendUrl", state.backendUrl);
  localStorage.setItem("relayLedgerApiKey", state.apiKey);
  localStorage.setItem("relayLedgerGmailLookbackDays", String(state.gmailLookbackDays));
  localStorage.setItem("relayLedgerGmailMaxResults", String(state.gmailMaxResults));
  elements.settingsPanel.hidden = true;
  loadDashboard();
});

elements.searchInput.addEventListener("input", (event) => {
  state.filters.search = event.target.value.trim().toLowerCase();
  render();
});
elements.driverFilter.addEventListener("change", (event) => {
  state.filters.driver = event.target.value;
  render();
});
elements.statusFilter.addEventListener("change", (event) => {
  state.filters.status = event.target.value;
  render();
});
elements.paidFilter.addEventListener("change", (event) => {
  state.filters.paid = event.target.value;
  render();
});
elements.invoiceFilter.addEventListener("change", (event) => {
  state.filters.invoice = event.target.value;
  render();
});
elements.sourceFilter.addEventListener("change", (event) => {
  state.filters.source = event.target.value;
  render();
});
elements.sortField.addEventListener("change", (event) => {
  state.sort.field = event.target.value;
  persistSort();
  render();
});
elements.sortDirection.addEventListener("change", (event) => {
  state.sort.direction = event.target.value;
  persistSort();
  render();
});
elements.sortHeaders.forEach((button) => {
  button.addEventListener("click", () => {
    const field = button.dataset.sort;
    if (state.sort.field === field) {
      state.sort.direction = state.sort.direction === "asc" ? "desc" : "asc";
    } else {
      state.sort.field = field;
      state.sort.direction = defaultDirectionFor(field);
    }
    elements.sortField.value = state.sort.field;
    elements.sortDirection.value = state.sort.direction;
    persistSort();
    render();
  });
});

loadDashboard();

async function loadDashboard() {
  setStatus("Loading ledger...");
  try {
    const [loads, scans, accounts] = await Promise.all([
      apiGet("/loads?limit=500"),
      apiGet("/tripScans?limit=10"),
      apiGet("/gmail/accounts")
    ]);
    state.loads = Array.isArray(loads.loads) ? loads.loads : [];
    state.scans = Array.isArray(scans.scans) ? scans.scans : [];
    state.accounts = Array.isArray(accounts.accounts) ? accounts.accounts : [];
    populateFilterOptions();
    render();
    setStatus(`Loaded ${state.loads.length} loads.`);
  } catch (error) {
    setStatus(`Could not load dashboard: ${error.message}`);
  }
}

async function clearGmailImports() {
  const confirmed = window.confirm("Clear all Gmail-imported loads? Trips-scanned loads will stay.");
  if (!confirmed) return;

  setStatus("Clearing Gmail imports...");
  elements.clearGmailButton.disabled = true;
  try {
    const result = await apiPost("/gmail/clear-imports", {});
    setStatus(`Cleared ${result.deleted || 0} Gmail-imported loads.`);
    await loadDashboard();
  } catch (error) {
    setStatus(`Clear failed: ${error.message}`);
  } finally {
    elements.clearGmailButton.disabled = false;
  }
}

async function syncGmail() {
  if (state.accounts.length === 0) {
    setStatus("No Gmail account connected. Click Connect Gmail first, then Sync Gmail.");
    return;
  }

  setStatus(`Syncing Gmail: scanning up to ${state.gmailMaxResults} emails from the last ${state.gmailLookbackDays} days...`);
  elements.syncGmailButton.disabled = true;
  try {
    const result = await apiPost("/gmail/sync", {
      maxResults: state.gmailMaxResults,
      lookbackDays: state.gmailLookbackDays
    });
    if (result.noAccounts) {
      setStatus("No Gmail account connected. Click Connect Gmail first, then Sync Gmail.");
      await loadDashboard();
      return;
    }
    setStatus(`Gmail sync complete: ${result.upserted || 0} loads updated, ${result.skipped || 0} skipped from ${result.processed || 0} emails.`);
    await loadDashboard();
  } catch (error) {
    setStatus(`Gmail sync failed: ${error.message}`);
  } finally {
    elements.syncGmailButton.disabled = false;
  }
}

async function apiGet(path) {
  const response = await fetch(`${cleanBaseUrl()}${path}`, {
    headers: apiHeaders()
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.ok === false) {
    throw new Error(body.error || `HTTP ${response.status}`);
  }
  return body;
}

async function apiPatch(path, payload) {
  const response = await fetch(`${cleanBaseUrl()}${path}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      ...apiHeaders()
    },
    body: JSON.stringify(payload)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.ok === false) {
    throw new Error(body.error || `HTTP ${response.status}`);
  }
  return body;
}

async function apiPost(path, payload) {
  const response = await fetch(`${cleanBaseUrl()}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...apiHeaders()
    },
    body: JSON.stringify(payload)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.ok === false) {
    throw new Error(body.error || `HTTP ${response.status}`);
  }
  return body;
}

function apiHeaders() {
  return state.apiKey ? { "x-ledger-api-key": state.apiKey } : {};
}

function cleanBaseUrl() {
  return state.backendUrl.replace(/\/+$/, "");
}

function defaultBackendUrl() {
  if (window.location.hostname === "127.0.0.1" || window.location.hostname === "localhost") {
    return "http://127.0.0.1:5001/relayloadtracker/us-central1/api";
  }

  return window.location.href.replace(/\/dashboard\/?.*$/, "");
}

function populateFilterOptions() {
  replaceOptions(elements.driverFilter, "All drivers", uniqueValues(state.loads.map((load) => load.driverName || "Unassigned")));
  replaceOptions(elements.statusFilter, "All statuses", uniqueValues(state.loads.map((load) => load.status || "Unknown")));
  elements.driverFilter.value = state.filters.driver;
  elements.statusFilter.value = state.filters.status;
}

function replaceOptions(select, label, values) {
  const previous = select.value;
  select.replaceChildren(new Option(label, ""));
  values.forEach((value) => select.append(new Option(value, value)));
  select.value = values.includes(previous) ? previous : "";
}

function render() {
  const filtered = sortedLoads(filteredLoads());
  renderSortHeaders();
  renderSummary(filtered);
  renderGmailAccounts();
  renderDriverTotals(filtered);
  renderScans();
  renderTable(filtered);
}

function sortedLoads(loads) {
  const direction = state.sort.direction === "asc" ? 1 : -1;
  return [...loads].sort((a, b) => {
    const aValue = sortValue(a, state.sort.field);
    const bValue = sortValue(b, state.sort.field);

    if (typeof aValue === "number" && typeof bValue === "number") {
      return (aValue - bValue) * direction;
    }

    return String(aValue).localeCompare(String(bValue), undefined, { numeric: true, sensitivity: "base" }) * direction;
  });
}

function sortValue(load, field) {
  switch (field) {
    case "trip":
      return load.amazonTripId || load.amazonLoadId || load.id || "";
    case "driver":
      return load.driverName || "Unassigned";
    case "pickup":
      return cleanPlace(load.origin);
    case "dropoff":
      return cleanPlace(load.destination);
    case "start":
      return sortableDate(load.tripStartDate || load.pickupDate || load.bookedAt || load.emailDate);
    case "end":
      return sortableDate(load.tripEndDate || "");
    case "payout":
      return moneyValue(load.payout);
    case "status":
      return load.missingFromTrips ? "Needs review" : load.status || "";
    case "source":
      return load.source || "trips";
    case "invoice":
      return load.invoiceStatus || "Unmatched";
    case "paid":
      return load.paid ? 1 : 0;
    default:
      return "";
  }
}

function renderSortHeaders() {
  elements.sortHeaders.forEach((button) => {
    const active = button.dataset.sort === state.sort.field;
    button.classList.toggle("active", active);
    button.dataset.indicator = active ? (state.sort.direction === "asc" ? "↑" : "↓") : "";
  });
}

function persistSort() {
  localStorage.setItem("relayLedgerSortField", state.sort.field);
  localStorage.setItem("relayLedgerSortDirection", state.sort.direction);
}

function defaultDirectionFor(field) {
  return ["start", "end", "payout", "paid"].includes(field) ? "desc" : "asc";
}

function filteredLoads() {
  return state.loads.filter((load) => {
    const searchable = [
      load.amazonTripId,
      load.amazonLoadId,
      load.driverName,
      load.origin,
      load.destination,
      load.status,
      load.invoiceStatus,
      load.notes
    ].join(" ").toLowerCase();

    if (state.filters.search && !searchable.includes(state.filters.search)) return false;
    if (state.filters.driver && (load.driverName || "Unassigned") !== state.filters.driver) return false;
    if (state.filters.status && (load.status || "Unknown") !== state.filters.status) return false;
    if (state.filters.paid === "paid" && !load.paid) return false;
    if (state.filters.paid === "unpaid" && load.paid) return false;
    if (state.filters.invoice && (load.invoiceStatus || "Unmatched") !== state.filters.invoice) return false;
    if (state.filters.source === "trips" && load.source !== "trips") return false;
    if (state.filters.source === "gmail" && load.source !== "gmail") return false;
    if (state.filters.source === "missing" && !(load.source === "gmail" && load.missingFromTrips)) return false;
    return true;
  });
}

function renderSummary(loads) {
  const totalPayout = sum(loads.map((load) => moneyValue(load.payout)));
  const unpaidPayout = sum(loads.filter((load) => !load.paid).map((load) => moneyValue(load.payout)));
  const reviewCount = loads.filter((load) => load.missingFromTrips || load.status === "Needs review" || load.invoiceStatus === "Disputed").length;
  const gmailMissing = loads.filter((load) => load.source === "gmail" && load.missingFromTrips).length;
  elements.totalLoads.textContent = String(loads.length);
  elements.totalPayout.textContent = currency(totalPayout);
  elements.unpaidPayout.textContent = currency(unpaidPayout);
  elements.needsReview.textContent = String(reviewCount);
  elements.gmailMissing.textContent = String(gmailMissing);
}

function renderGmailAccounts() {
  elements.gmailAccounts.replaceChildren();
  if (state.accounts.length === 0) {
    const item = document.createElement("div");
    item.className = "account-item";
    item.innerHTML = "<strong>No Gmail connected</strong><span>Use Connect Gmail above.</span>";
    elements.gmailAccounts.append(item);
    return;
  }

  state.accounts.forEach((account) => {
    const item = document.createElement("div");
    item.className = "account-item";
    item.innerHTML = `
      <div><strong></strong><span>${account.hasRefreshToken ? "Connected" : "Needs reconnect"}</span></div>
      <div><span>Last sync</span><strong>${formatTimestamp(account.lastGmailSyncAt) || "Never"}</strong></div>
      <div><span>Last result</span><strong>${account.lastGmailSyncUpserted || 0}/${account.lastGmailSyncProcessed || 0}</strong></div>
    `;
    item.querySelector("strong").textContent = account.email || "Gmail account";
    elements.gmailAccounts.append(item);
  });
}

function renderDriverTotals(loads) {
  const drivers = new Map();
  loads.forEach((load) => {
    const driver = load.driverName || "Unassigned";
    const existing = drivers.get(driver) || { count: 0, payout: 0, unpaid: 0 };
    existing.count += 1;
    existing.payout += moneyValue(load.payout);
    if (!load.paid) existing.unpaid += moneyValue(load.payout);
    drivers.set(driver, existing);
  });

  elements.driverTotals.replaceChildren();
  [...drivers.entries()]
    .sort((a, b) => b[1].payout - a[1].payout)
    .forEach(([driver, totals]) => {
      const item = document.createElement("div");
      item.className = "driver-item";
      item.innerHTML = `
        <div><strong></strong><span>${totals.count} loads</span></div>
        <div><span>Total</span><strong>${currency(totals.payout)}</strong></div>
        <div><span>Unpaid</span><strong>${currency(totals.unpaid)}</strong></div>
      `;
      item.querySelector("strong").textContent = driver;
      elements.driverTotals.append(item);
    });
}

function renderScans() {
  elements.recentScans.replaceChildren();
  state.scans.forEach((scan) => {
    const item = document.createElement("div");
    item.className = "scan-item";
    item.innerHTML = `
      <div><strong>${scan.tripCount || 0} trips</strong><span>${formatTimestamp(scan.createdAt)}</span></div>
      <span>${scan.reason || scan.source || "sync"}</span>
    `;
    elements.recentScans.append(item);
  });
}

function renderTable(loads) {
  elements.loadsBody.replaceChildren();
  elements.emptyState.hidden = loads.length !== 0;

  loads.forEach((load) => {
    const row = elements.rowTemplate.content.firstElementChild.cloneNode(true);
    row.dataset.id = load.id;
    setCell(row, "trip", load.amazonTripId || load.amazonLoadId || load.id);
    setCell(row, "driver", load.driverName || "Unassigned");
    setCell(row, "origin", cleanPlace(load.origin));
    setCell(row, "destination", cleanPlace(load.destination));
    setCell(row, "start", load.tripStartDate || load.pickupDate || "");
    setCell(row, "end", load.tripEndDate || "");
    setCell(row, "payout", currency(moneyValue(load.payout)));
    row.querySelector('[data-field="status"]').append(statusBadge(load));
    row.querySelector('[data-field="source"]').append(sourceBadge(load));

    const invoice = row.querySelector('[data-action="invoice"]');
    invoice.value = load.invoiceStatus || "Unmatched";
    invoice.addEventListener("change", () => updateLoad(load.id, { invoiceStatus: invoice.value }));

    const paid = row.querySelector('[data-action="paid"]');
    paid.checked = Boolean(load.paid);
    paid.addEventListener("change", () => updateLoad(load.id, { paid: paid.checked, paidAt: paid.checked ? new Date().toISOString() : "" }));

    const notes = row.querySelector('[data-action="notes"]');
    notes.value = load.notes || "";
    notes.addEventListener("change", () => updateLoad(load.id, { notes: notes.value.trim() }));

    elements.loadsBody.append(row);
  });
}

function setCell(row, field, value) {
  row.querySelector(`[data-field="${field}"]`).textContent = value || "";
}

function statusBadge(load) {
  const badge = document.createElement("span");
  const label = load.missingFromTrips ? "Needs review" : load.status || "Unknown";
  badge.className = "badge";
  if (load.paid || label === "History") badge.classList.add("ok");
  if (label === "Needs review" || load.invoiceStatus === "Disputed") badge.classList.add("warn");
  if (label === "Cancelled") badge.classList.add("bad");
  badge.textContent = label;
  return badge;
}

function sourceBadge(load) {
  const badge = document.createElement("span");
  const source = load.source || "trips";
  badge.className = `badge ${source === "gmail" ? "gmail" : "trips"}`;
  badge.textContent = source === "gmail" ? (load.missingFromTrips ? "Gmail only" : "Gmail") : "Trips";
  return badge;
}

async function updateLoad(id, patch) {
  try {
    await apiPatch(`/loads/${encodeURIComponent(id)}`, patch);
    const index = state.loads.findIndex((load) => load.id === id);
    if (index >= 0) state.loads[index] = { ...state.loads[index], ...patch };
    render();
    setStatus("Saved change.");
  } catch (error) {
    setStatus(`Save failed: ${error.message}`);
  }
}

function cleanPlace(value) {
  return String(value || "").replace(/\b[A-Z0-9]{3,5}\s+/g, "").replace(/\s+/g, " ").trim();
}

function moneyValue(value) {
  const number = Number(String(value ?? "").replace(/[$,]/g, ""));
  return Number.isFinite(number) ? number : 0;
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(Math.round(number), min), max);
}

function sortableDate(value) {
  const text = String(value || "").trim();
  if (!text) return 0;

  const parsed = new Date(text);
  if (!Number.isNaN(parsed.getTime())) return parsed.getTime();

  const monthMatch = text.match(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{1,2})\b/i);
  if (monthMatch) {
    const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
    const month = months.indexOf(monthMatch[1].slice(0, 3).toLowerCase());
    const day = Number(monthMatch[2]);
    const year = new Date().getFullYear();
    return new Date(year, month, day).getTime();
  }

  return 0;
}

function currency(value) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value || 0);
}

function uniqueValues(values) {
  return [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function formatTimestamp(value) {
  const date = timestampToDate(value);
  if (!date) return "";
  return date.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function timestampToDate(value) {
  if (!value) return null;
  if (typeof value === "string") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (typeof value._seconds === "number") return new Date(value._seconds * 1000);
  if (typeof value.seconds === "number") return new Date(value.seconds * 1000);
  return null;
}

function setStatus(message) {
  elements.connectionStatus.textContent = message;
}
