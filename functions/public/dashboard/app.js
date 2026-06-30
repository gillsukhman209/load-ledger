const DEFAULT_BACKEND_URL = defaultBackendUrl();
const state = {
  backendUrl: localStorage.getItem("relayLedgerBackendUrl") || DEFAULT_BACKEND_URL,
  apiKey: localStorage.getItem("relayLedgerApiKey") || "",
  gmailLookbackDays: Number(localStorage.getItem("relayLedgerGmailLookbackDays") || 365),
  gmailMaxResults: Number(localStorage.getItem("relayLedgerGmailMaxResults") || 2000),
  loads: [],
  settlements: [],
  scans: [],
  accounts: [],
  selectedLoadIds: new Set(),
  quickFilter: "all",
  filters: {
    id: "",
    search: "",
    driver: "",
    status: "",
    invoice: "",
    source: "",
    month: ""
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
  filtersButton: document.querySelector("#filtersButton"),
  filtersPanel: document.querySelector("#filtersPanel"),
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
  driverInsights: document.querySelector("#driverInsights"),
  quickIdSearchInput: document.querySelector("#quickIdSearchInput"),
  clearQuickIdSearchButton: document.querySelector("#clearQuickIdSearchButton"),
  searchInput: document.querySelector("#searchInput"),
  driverFilter: document.querySelector("#driverFilter"),
  statusFilter: document.querySelector("#statusFilter"),
  invoiceFilter: document.querySelector("#invoiceFilter"),
  sourceFilter: document.querySelector("#sourceFilter"),
  monthFilter: document.querySelector("#monthFilter"),
  sortField: document.querySelector("#sortField"),
  sortDirection: document.querySelector("#sortDirection"),
  bulkActions: document.querySelector("#bulkActions"),
  selectedCount: document.querySelector("#selectedCount"),
  clearSelectionButton: document.querySelector("#clearSelectionButton"),
  deleteSelectedButton: document.querySelector("#deleteSelectedButton"),
  quickFilterButtons: [...document.querySelectorAll("[data-quick-filter]")],
  sortHeaders: [...document.querySelectorAll("[data-sort]")],
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
elements.clearSelectionButton.addEventListener("click", () => {
  state.selectedLoadIds.clear();
  render();
});
elements.deleteSelectedButton.addEventListener("click", deleteSelectedLoads);
elements.quickIdSearchInput.addEventListener("input", (event) => {
  state.filters.id = normalizeSearchId(event.target.value);
  render();
});
elements.clearQuickIdSearchButton.addEventListener("click", () => {
  state.filters.id = "";
  elements.quickIdSearchInput.value = "";
  render();
});
elements.quickFilterButtons.forEach((button) => {
  button.addEventListener("click", () => {
    state.quickFilter = button.dataset.quickFilter || "all";
    render();
  });
});
elements.connectGmailButton.addEventListener("click", () => {
  window.open(`${cleanBaseUrl()}/auth/google/start`, "_blank", "noopener,noreferrer");
});
elements.syncGmailButton.addEventListener("click", syncGmail);
elements.clearGmailButton.addEventListener("click", clearGmailImports);
elements.settingsButton.addEventListener("click", () => {
  const isHidden = !elements.settingsPanel.hidden;
  elements.settingsPanel.hidden = isHidden;
  elements.settingsButton.setAttribute("aria-expanded", String(!isHidden));
});
elements.filtersButton.addEventListener("click", () => {
  const isHidden = !elements.filtersPanel.hidden;
  elements.filtersPanel.hidden = isHidden;
  elements.filtersButton.textContent = isHidden ? "Show filters" : "Hide filters";
  elements.filtersButton.setAttribute("aria-expanded", String(!isHidden));
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
  elements.settingsButton.setAttribute("aria-expanded", "false");
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
elements.invoiceFilter.addEventListener("change", (event) => {
  state.filters.invoice = event.target.value;
  render();
});
elements.sourceFilter.addEventListener("change", (event) => {
  state.filters.source = event.target.value;
  render();
});
elements.monthFilter.addEventListener("change", (event) => {
  state.filters.month = event.target.value;
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
document.addEventListener("click", closeActionMenus);

loadDashboard();

async function loadDashboard() {
  setStatus("Loading ledger...");
  try {
    const [loads, scans, accounts, settlements] = await Promise.all([
      apiGet("/loads?limit=2500"),
      apiGet("/tripScans?limit=10"),
      apiGet("/gmail/accounts"),
      apiGet("/settlements?limit=500")
    ]);
    state.loads = Array.isArray(loads.loads) ? loads.loads : [];
    state.settlements = Array.isArray(settlements.settlements) ? settlements.settlements : [];
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

async function apiDelete(path, payload) {
  const response = await fetch(`${cleanBaseUrl()}${path}`, {
    method: "DELETE",
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
  const loads = ledgerLoads();
  replaceOptions(elements.driverFilter, "All drivers", uniqueValues(loads.map((load) => displayDriver(load.driverName))));
  replaceOptions(elements.statusFilter, "All statuses", uniqueValues(loads.map((load) => displayStatusLabel(load))));
  replaceOptionsFromPairs(elements.monthFilter, "All months", monthFilterOptions());
  elements.driverFilter.value = state.filters.driver;
  elements.statusFilter.value = state.filters.status;
  elements.monthFilter.value = state.filters.month;
}

function replaceOptions(select, label, values) {
  const previous = select.value;
  select.replaceChildren(new Option(label, ""));
  values.forEach((value) => select.append(new Option(value, value)));
  select.value = values.includes(previous) ? previous : "";
}

function replaceOptionsFromPairs(select, label, pairs) {
  const previous = select.value;
  select.replaceChildren(new Option(label, ""));
  pairs.forEach((pair) => select.append(new Option(pair.label, pair.value)));
  select.value = pairs.some((pair) => pair.value === previous) ? previous : "";
}

function monthFilterOptions() {
  const months = new Map();
  ledgerLoads().forEach((load) => {
    const week = weekRangeForLoad(load);
    if (week.monthKey && week.monthLabel) {
      months.set(week.monthKey, { value: week.monthKey, label: week.monthLabel, sort: week.monthSort });
    }
  });

  return [...months.values()].sort((a, b) => b.sort - a.sort);
}

function render() {
  pruneSelectedLoads();
  const filtered = sortedLoads(filteredLoads());
  renderSortHeaders();
  renderQuickFilters();
  renderSummary(filtered);
  renderInsights(filtered);
  renderTable(filtered);
  renderBulkActions();
}

function renderQuickFilters() {
  elements.quickFilterButtons.forEach((button) => {
    const active = (button.dataset.quickFilter || "all") === state.quickFilter;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  });
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
      return displayDriver(load.driverName);
    case "pickup":
      return cleanPlace(load.origin);
    case "dropoff":
      return cleanPlace(load.destination);
    case "start":
      return sortableDate(load.tripStartDate || load.pickupDate || load.bookedAt || load.emailDate);
    case "end":
      return sortableDate(load.tripEndDate || "");
    case "payout":
      return ledgerPayout(load);
    case "status":
      return displayStatusLabel(load);
    case "source":
      return load.source || "trips";
    case "invoice":
      return load.invoiceStatus || "Unmatched";
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
  return ["start", "end", "payout"].includes(field) ? "desc" : "asc";
}

function filteredLoads() {
  return ledgerLoads().filter((load) => {
    const searchable = [
      load.amazonTripId,
      load.amazonLoadId,
      displayDriver(load.driverName),
      load.origin,
      load.destination,
      load.status,
      load.invoiceStatus,
      load.notes
    ].join(" ").toLowerCase();

    if (state.filters.id && !loadIdMatches(load, state.filters.id)) return false;
    if (state.filters.search && !searchable.includes(state.filters.search) && !loadIdMatches(load, normalizeSearchId(state.filters.search))) return false;
    if (state.filters.driver && displayDriver(load.driverName) !== state.filters.driver) return false;
    if (state.filters.status && displayStatusLabel(load) !== state.filters.status) return false;
    if (state.filters.invoice && (load.invoiceStatus || "Unmatched") !== state.filters.invoice) return false;
    if (state.filters.source === "trips" && !sourceHas(load, "trips")) return false;
    if (state.filters.source === "gmail" && !sourceHas(load, "gmail")) return false;
    if (state.filters.source === "settlements" && !sourceHas(load, "settlements")) return false;
    if (state.filters.source === "missing" && !(sourceHas(load, "gmail") && !sourceHas(load, "trips") && load.missingFromTrips)) return false;
    if (state.filters.month && weekRangeForLoad(load).monthKey !== state.filters.month) return false;
    if (!quickFilterMatches(load)) return false;
    return true;
  });
}

function quickFilterMatches(load) {
  switch (state.quickFilter) {
    case "review":
      return needsReview(load);
    case "unpaid":
      return !isInvoicePaid(load);
    case "completed":
      return displayStatusLabel(load) === "Completed";
    case "cancelled":
      return displayStatusLabel(load).includes("Cancelled");
    default:
      return true;
  }
}

function loadIdMatches(load, query) {
  const normalizedQuery = normalizeSearchId(query);
  if (!normalizedQuery) return true;
  return loadIdSearchValues(load).some((value) => value.includes(normalizedQuery) || value.endsWith(normalizedQuery));
}

function loadIdSearchValues(load) {
  return uniqueValues([
    load.id,
    load.amazonTripId,
    load.amazonLoadId,
    load.shortCode,
    load.parentTourId
  ].map(normalizeSearchId).filter(Boolean));
}

function normalizeSearchId(value) {
  return String(value || "").replace(/[^a-z0-9]/gi, "").toUpperCase();
}

function ledgerLoads() {
  return state.loads.filter((load) => hasLedgerDate(load) || sourceHas(load, "gmail")).filter((load) => !isCoveredChildLoad(load));
}

function hasLedgerDate(load) {
  return Boolean(load.tripStartDate || load.pickupDate || load.bookedAt || load.emailDate);
}

function isCoveredChildLoad(load) {
  if (sourceHas(load, "gmail")) return false;

  const childId = normalizedLoadId(load.amazonTripId || load.amazonLoadId || load.id);
  if (!childId) return false;

  const parentTourId = normalizedLoadId(load.parentTourId);
  if (parentTourId && hasLedgerTour(parentTourId)) return true;

  const settlementInferredTourId = normalizedLoadId(load.childTourId);
  return Boolean(settlementInferredTourId && hasLedgerTour(settlementInferredTourId) && !hasUsableRoute(load));
}

function hasLedgerTour(tourId) {
  const normalizedTour = normalizedLoadId(tourId);
  if (!normalizedTour) return false;
  return state.loads.some((load) => {
    if (load === undefined) return false;
    const id = normalizedLoadId(load.amazonTripId || load.amazonLoadId || load.id);
    return id === normalizedTour && !load.parentTourId && !load.childTourId;
  });
}

function normalizedLoadId(value) {
  return String(value || "").trim().toUpperCase().replace(/^TRIP_/, "").replace(/^T-/, "");
}

function normalizeIdList(value) {
  if (Array.isArray(value)) return [...new Set(value.map((item) => normalizedLoadId(item)).filter(Boolean))];
  return String(value || "").split(",").map((item) => normalizedLoadId(item)).filter(Boolean);
}

function hasUsableRoute(load) {
  const route = displayRoute(load);
  return isUsableCity(route.origin) && isUsableCity(route.destination);
}

function isUsableCity(value) {
  const text = String(value || "").trim();
  if (!text) return false;
  if (/tractor|trailer|equipment|unknown/i.test(text)) return false;
  return text.length >= 3;
}

function renderSummary(loads) {
  const totalPayout = sum(loads.map((load) => ledgerPayout(load)));
  const unpaidPayout = sum(loads.filter((load) => !isInvoicePaid(load)).map((load) => ledgerPayout(load)));
  const reviewCount = loads.filter((load) => needsReview(load)).length;
  const gmailMissing = loads.filter((load) => sourceHas(load, "gmail") && !sourceHas(load, "trips") && load.missingFromTrips).length;
  elements.totalLoads.textContent = String(loads.length);
  elements.totalPayout.textContent = currency(totalPayout);
  elements.unpaidPayout.textContent = currency(unpaidPayout);
  elements.needsReview.textContent = String(reviewCount);
  elements.gmailMissing.textContent = String(gmailMissing);
}

function renderInsights(loads) {
  renderDriverInsights(loads);
}

function renderDriverInsights(loads) {
  const totals = new Map();
  loads.forEach((load) => {
    const driver = displayDriver(load.driverName);
    const current = totals.get(driver) || { loads: 0, total: 0, unpaid: 0 };
    current.loads += 1;
    current.total += ledgerPayout(load);
    if (!isInvoicePaid(load)) current.unpaid += ledgerPayout(load);
    totals.set(driver, current);
  });

  const rows = [...totals.entries()]
    .sort((a, b) => b[1].total - a[1].total)
    .slice(0, 4)
    .map(([driver, item]) => insightRow(driver, `${item.loads} loads`, currency(item.total), item.unpaid > 0 ? `Unpaid ${currency(item.unpaid)}` : "Paid"));

  elements.driverInsights.replaceChildren(...(rows.length ? rows : [emptyInsight("No driver totals")]));
}

function insightRow(label, meta, value, extra) {
  const row = document.createElement("div");
  row.className = "insight-row";
  const left = document.createElement("span");
  left.className = "insight-label";
  left.textContent = label;
  const detail = document.createElement("span");
  detail.className = "insight-meta";
  detail.textContent = [meta, extra].filter(Boolean).join(" · ");
  const right = document.createElement("strong");
  right.textContent = value;
  row.append(left, detail, right);
  return row;
}

function emptyInsight(text) {
  const row = document.createElement("div");
  row.className = "insight-empty";
  row.textContent = text;
  return row;
}

function renderTable(loads) {
  elements.loadsBody.replaceChildren();
  elements.emptyState.hidden = loads.length !== 0;

  groupLoadsByWeek(loads).forEach((week) => {
    elements.loadsBody.append(weekHeaderRow(week));
    week.loads.forEach((load) => {
      elements.loadsBody.append(loadRow(load));
    });
  });
}

function weekHeaderRow(week) {
  const row = document.createElement("tr");
  row.className = "week-row";
  const cell = document.createElement("td");
  cell.colSpan = 11;
  const weekIds = week.loads.map((load) => load.id).filter(Boolean);
  const allSelected = weekIds.length > 0 && weekIds.every((id) => state.selectedLoadIds.has(id));
  const partiallySelected = weekIds.some((id) => state.selectedLoadIds.has(id));
  const settlement = settlementSummaryForWeek(week.contextId);
  const settlementMarkup = settlement.count > 0
    ? `
      <span>Amazon ${currency(settlement.mainTotal)}</span>
      ${settlement.disputeTotal > 0 ? `<span>Disputes ${currency(settlement.disputeTotal)}</span>` : ""}
      <span class="${settlementDiffClass(week.total, settlement.paidTotal)}">Diff ${currency(settlementDiffValue(week.total, settlement.paidTotal))}</span>
      <span>${settlement.status}</span>
    `
    : `<span>No Amazon payment row</span>`;
  cell.innerHTML = `
    <div class="week-summary">
      <label class="week-select">
        <input data-action="select-week" type="checkbox" ${allSelected ? "checked" : ""}>
        <span>Select week</span>
      </label>
      <strong>${week.label}</strong>
      <span>${week.loads.length} loads</span>
      <span>Total ${currency(week.total)}</span>
      <span>Unpaid ${currency(week.unpaid)}</span>
      <span>${week.reviewCount} review</span>
      ${settlementMarkup}
    </div>
  `;
  const checkbox = cell.querySelector('[data-action="select-week"]');
  checkbox.indeterminate = partiallySelected && !allSelected;
  checkbox.addEventListener("change", () => {
    toggleWeekSelection(weekIds, checkbox.checked);
  });
  row.append(cell);
  return row;
}

function loadRow(load) {
    const row = elements.rowTemplate.content.firstElementChild.cloneNode(true);
    row.dataset.id = load.id;
    const select = row.querySelector('[data-action="select-load"]');
    select.checked = state.selectedLoadIds.has(load.id);
    select.addEventListener("change", () => {
      toggleLoadSelection(load.id, select.checked);
    });
    setTripLink(row, load);
    const driverSelect = row.querySelector('[data-action="driver"]');
    populateDriverSelect(driverSelect, load.driverName);
    driverSelect.title = "Set driver";
    driverSelect.addEventListener("change", () => {
      const driverName = driverSelect.value;
      updateLoad(load.id, { driverName });
    });
    const route = displayRoute(load);
    setCell(row, "origin", route.origin);
    setCell(row, "destination", route.destination);
    setCell(row, "start", load.tripStartDate || load.pickupDate || "");
    setCell(row, "payout", currency(ledgerPayout(load)));
    const statusCell = row.querySelector('[data-field="status"]');
    statusCell.append(statusBadge(load));
    if (hasDispute(load) && !isCancelledLoad(load) && !isDisputePaid(load)) statusCell.append(disputeBadge(load));
    row.querySelector('[data-field="source"]').append(sourceBadge(load));

    const invoiceText = row.querySelector('[data-field="invoice-status"]');
    invoiceText.textContent = load.invoiceStatus || "Unmatched";

    const menuButton = row.querySelector('[data-action="toggle-actions"]');
    const menu = row.querySelector('[data-field="action-menu"]');
    const invoice = row.querySelector('[data-action="invoice"]');
    invoice.value = load.invoiceStatus || "Unmatched";
    invoice.addEventListener("change", () => updateLoad(load.id, { invoiceStatus: invoice.value }));

    menuButton.addEventListener("click", (event) => {
      event.stopPropagation();
      const shouldOpen = menu.hidden;
      closeActionMenus();
      menu.hidden = !shouldOpen;
      menuButton.setAttribute("aria-expanded", String(shouldOpen));
    });
    menu.addEventListener("click", (event) => event.stopPropagation());

    const reviewButton = row.querySelector('[data-action="toggle-review"]');
    reviewButton.textContent = load.manualReview ? "Clear review flag" : "Mark for review";
    reviewButton.addEventListener("click", () => updateLoad(load.id, { manualReview: !load.manualReview }));

    const noteButton = row.querySelector('[data-action="show-note"]');
    const notePreview = row.querySelector('[data-field="note-preview"]');
    const notes = row.querySelector('[data-action="notes"]');
    notes.value = load.notes || "";
    noteButton.textContent = load.notes ? "Edit note" : "Add note";
    if (load.notes) {
      menuButton.title = `Note: ${load.notes}`;
      notePreview.textContent = load.notes;
      notePreview.hidden = false;
    }

    noteButton.addEventListener("click", () => {
      notes.hidden = false;
      notes.focus();
      notes.select();
    });
    notes.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        notes.value = load.notes || "";
        notes.hidden = true;
        menuButton.focus();
      }
      if (event.key === "Enter") {
        notes.blur();
      }
    });
    notes.addEventListener("blur", () => {
      if (!notes.value.trim()) notes.hidden = true;
    });
    notes.addEventListener("change", () => {
      updateLoad(load.id, { notes: notes.value.trim() });
      if (!notes.value.trim()) notes.hidden = true;
    });

    return row;
}

function closeActionMenus() {
  document.querySelectorAll('[data-field="action-menu"]').forEach((menu) => {
    menu.hidden = true;
  });
  document.querySelectorAll('[data-action="toggle-actions"]').forEach((button) => {
    button.setAttribute("aria-expanded", "false");
  });
}

function toggleLoadSelection(id, selected) {
  if (!id) return;
  if (selected) {
    state.selectedLoadIds.add(id);
  } else {
    state.selectedLoadIds.delete(id);
  }
  render();
}

function toggleWeekSelection(ids, selected) {
  ids.forEach((id) => {
    if (selected) {
      state.selectedLoadIds.add(id);
    } else {
      state.selectedLoadIds.delete(id);
    }
  });
  render();
}

function pruneSelectedLoads() {
  const validIds = new Set(state.loads.map((load) => load.id).filter(Boolean));
  [...state.selectedLoadIds].forEach((id) => {
    if (!validIds.has(id)) state.selectedLoadIds.delete(id);
  });
}

function renderBulkActions() {
  const count = state.selectedLoadIds.size;
  elements.bulkActions.hidden = count === 0;
  elements.selectedCount.textContent = `${count} selected`;
  elements.deleteSelectedButton.disabled = count === 0;
}

async function deleteSelectedLoads() {
  const ids = [...state.selectedLoadIds];
  if (ids.length === 0) return;

  const confirmed = window.confirm(`Delete ${ids.length} selected load${ids.length === 1 ? "" : "s"} from the ledger? This cannot be undone.`);
  if (!confirmed) return;

  elements.deleteSelectedButton.disabled = true;
  setStatus(`Deleting ${ids.length} load${ids.length === 1 ? "" : "s"}...`);
  try {
    const result = await apiDelete("/loads", { ids });
    const deletedIds = new Set(ids);
    state.loads = state.loads.filter((load) => !deletedIds.has(load.id));
    state.selectedLoadIds.clear();
    populateFilterOptions();
    render();
    setStatus(`Deleted ${result.deleted || ids.length} load${ids.length === 1 ? "" : "s"}.`);
  } catch (error) {
    setStatus(`Delete failed: ${error.message}`);
    renderBulkActions();
  }
}

function groupLoadsByWeek(loads) {
  const weeks = new Map();
  loads.forEach((load) => {
    const week = weekRangeForLoad(load);
    const existing = weeks.get(week.key) || {
      ...week,
      loads: [],
      total: 0,
      unpaid: 0,
      reviewCount: 0
    };

    existing.loads.push(load);
    existing.total += ledgerPayout(load);
    if (!isInvoicePaid(load)) existing.unpaid += ledgerPayout(load);
    if (needsReview(load)) {
      existing.reviewCount += 1;
    }
    weeks.set(week.key, existing);
  });

  return [...weeks.values()].sort((a, b) => b.sort - a.sort);
}

function weekRangeForLoad(load) {
  if (load.settlementContextId) {
    const settlementWeek = weekRangeFromSettlementContext(load.settlementContextId);
    if (settlementWeek) return settlementWeek;
  }

  const date = loadDate(load.tripStartDate || load.pickupDate || load.bookedAt || load.emailDate);
  if (!date) return { key: "no-date", label: "No date", sort: 0, contextId: "", monthKey: "", monthLabel: "", monthSort: 0 };

  // Amazon Relay pay weeks run Sunday through Saturday.
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate() - date.getDay());
  const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 6);
  const contextId = amazonWeekContextId(start);
  const majorityMonth = majorityMonthForWeek(start, end);
  return {
    key: dateKey(start),
    label: `${formatMonthDay(start)} - ${formatMonthDay(end)}`,
    sort: start.getTime(),
    contextId,
    ...majorityMonth
  };
}

function weekRangeFromSettlementContext(contextId) {
  const settlement = state.settlements.find((item) => item.contextId === contextId && item.weekStartDate && item.weekEndDate);
  if (settlement) {
    const start = loadDate(settlement.weekStartDate);
    const end = loadDate(settlement.weekEndDate);
    if (start && end) {
      return {
        key: dateKey(start),
        label: `${formatMonthDay(start)} - ${formatMonthDay(end)}`,
        sort: start.getTime(),
        contextId,
        ...majorityMonthForWeek(start, end)
      };
    }
  }

  const match = String(contextId || "").match(/^(\d{4})#(\d{1,2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const week = Number(match[2]);
  const janFirst = new Date(year, 0, 1, 12);
  const firstWeekStart = new Date(year, 0, 1 - janFirst.getDay(), 12);
  const start = new Date(firstWeekStart.getFullYear(), firstWeekStart.getMonth(), firstWeekStart.getDate() + (week - 1) * 7, 12);
  const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 6, 12);
  return {
    key: dateKey(start),
    label: `${formatMonthDay(start)} - ${formatMonthDay(end)}`,
    sort: start.getTime(),
    contextId,
    ...majorityMonthForWeek(start, end)
  };
}

function majorityMonthForWeek(start, end) {
  const counts = new Map();
  const cursor = new Date(start.getFullYear(), start.getMonth(), start.getDate(), 12);
  const last = new Date(end.getFullYear(), end.getMonth(), end.getDate(), 12);

  while (cursor <= last) {
    const key = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, "0")}`;
    const existing = counts.get(key) || {
      monthKey: key,
      monthLabel: cursor.toLocaleDateString("en-US", { month: "long", year: "numeric" }),
      monthSort: new Date(cursor.getFullYear(), cursor.getMonth(), 1).getTime(),
      count: 0
    };
    existing.count += 1;
    counts.set(key, existing);
    cursor.setDate(cursor.getDate() + 1);
  }

  const majority = [...counts.values()].sort((a, b) => b.count - a.count || b.monthSort - a.monthSort)[0];
  return {
    monthKey: majority?.monthKey || "",
    monthLabel: majority?.monthLabel || "",
    monthSort: majority?.monthSort || 0
  };
}

function amazonWeekContextId(weekStart) {
  const year = weekStart.getFullYear();
  const janFirst = new Date(year, 0, 1, 12);
  const firstWeekStart = new Date(year, 0, 1 - janFirst.getDay(), 12);
  const dayDiff = Math.round((utcDay(weekStart) - utcDay(firstWeekStart)) / (24 * 60 * 60 * 1000));
  const week = Math.floor(dayDiff / 7) + 1;
  return `${year}#${week}`;
}

function utcDay(date) {
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
}

function settlementSummaryForWeek(contextId) {
  const settlements = state.settlements.filter((settlement) => settlement.contextId === contextId);
  const mainSettlements = settlements.filter((settlement) => !settlement.friendlyDisputeId);
  const disputeSettlements = settlements.filter((settlement) => settlement.friendlyDisputeId);
  const mainTotal = sum(mainSettlements.map((settlement) => moneyValue(settlement.amount)));
  const disputeTotal = sum(disputeSettlements.map((settlement) => moneyValue(settlement.amount)));
  const paidTotal = mainTotal + disputeTotal;
  const statusRows = settlements;
  const statuses = statusRows.map((settlement) => settlement.displayStatus || settlement.paymentStatus || "").filter(Boolean);
  let status = "Unmatched";
  if (statuses.length > 0) {
    if (statuses.some((item) => String(item).toLowerCase() === "pending")) status = "Pending";
    else if (statuses.every((item) => String(item).toLowerCase() === "paid" || String(item).toUpperCase() === "INITIATED")) status = "Paid";
    else status = uniqueValues(statuses).join(", ");
  }
  return { count: settlements.length, mainTotal, disputeTotal, paidTotal, status };
}

function settlementDiffClass(loadTotal, settlementTotal) {
  return Math.abs(loadTotal - settlementTotal) < 5 ? "settlement-ok" : "settlement-warn";
}

function settlementDiffValue(loadTotal, settlementTotal) {
  const diff = loadTotal - settlementTotal;
  return Math.abs(diff) < 5 ? 0 : diff;
}

function dateKey(date) {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function formatMonthDay(date) {
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function setCell(row, field, value) {
  row.querySelector(`[data-field="${field}"]`).textContent = value || "";
}

function setTripLink(row, load) {
  const cell = row.querySelector('[data-field="trip"]');
  const tripId = load.amazonTripId || load.amazonLoadId || load.id;
  const link = document.createElement("a");
  link.href = relayTripsUrl(load);
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = tripId;
  link.title = "Open this week in Amazon Relay Trips";
  cell.replaceChildren(link);
}

function relayTripsUrl(load) {
  const week = weekRangeForLoad(load);
  const weekStart = localDateFromKey(week.key) || loadDate(load.tripStartDate || load.pickupDate || load.bookedAt || load.emailDate);
  if (!weekStart) return "https://relay.amazon.com/tours/history";

  const start = new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate(), 0, 0, 0, 0);
  const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 7, 0, 0, 0, -1);
  const params = new URLSearchParams({
    hsrtb: "START_DATE",
    hsrtdrctn: "asc",
    hstrtdt: start.toISOString(),
    henddt: end.toISOString()
  });

  return `https://relay.amazon.com/tours/${relayTripsTab(load)}?${params.toString()}`;
}

function relayTripsTab(load) {
  const status = String(load.status || load.currentTripStatus || "").toLowerCase();
  if (status.includes("upcoming")) return "upcoming";
  if (status.includes("transit")) return "in-transit";
  return "history";
}

function localDateFromKey(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12);
}

function statusBadge(load) {
  const badge = document.createElement("span");
  const label = displayStatusLabel(load);
  badge.className = "badge";
  if (label === "Cancelled" && hasDispute(load)) {
    badge.classList.add("bad", "dispute-combo");
    badge.textContent = isInvoicePaid(load) || load.paidAfterDispute ? "Cancelled + dispute paid" : "Cancelled + dispute";
    const id = disputeId(load);
    if (id) badge.title = `Dispute ID: ${id}`;
    return badge;
  }

  if (isDisputePaid(load)) {
    badge.classList.add("dispute");
    badge.textContent = "Dispute paid";
    const id = disputeId(load);
    if (id) badge.title = `Dispute ID: ${id}`;
    return badge;
  }

  if (label === "Completed") badge.classList.add("ok");
  if (label === "Needs review" || load.invoiceStatus === "Disputed") badge.classList.add("warn");
  if (label === "Cancelled") badge.classList.add("bad");

  badge.textContent = label;
  return badge;
}

function displayStatusLabel(load) {
  if (load.manualReview) return "Needs review";
  if (load.missingFromTrips && !isDisputePaid(load) && !isInvoicePaid(load)) return "Needs review";
  const status = String(load.status || load.currentTripStatus || "Unknown").trim();
  if (/^history$/i.test(status)) return "Completed";
  if (/^in[\s_-]*transit$/i.test(status)) return "In transit";
  if (/^upcoming$/i.test(status)) return "Upcoming";
  if (/^cancelled$/i.test(status)) return "Cancelled";
  return status || "Unknown";
}

function hasDispute(load) {
  return Boolean(disputeId(load) || load.paidAfterDispute || load.disputeStatus);
}

function isDisputePaid(load) {
  return Boolean(hasDispute(load) && (isInvoicePaid(load) || load.paidAfterDispute));
}

function disputeId(load) {
  return String(load.disputeId || load.settlementFriendlyDisputeId || "").trim();
}

function disputeBadge(load) {
  const badge = document.createElement("span");
  const id = disputeId(load);
  badge.className = "badge dispute";
  badge.textContent = isInvoicePaid(load) || load.paidAfterDispute ? "Dispute paid" : "Dispute";
  if (id) badge.title = `Dispute ID: ${id}`;
  return badge;
}

function sourceBadge(load) {
  const badge = document.createElement("span");
  const source = load.source || "trips";
  const hasGmail = sourceHas(load, "gmail");
  const hasTrips = sourceHas(load, "trips");
  const hasSettlements = sourceHas(load, "settlements");
  badge.className = `badge ${hasGmail && !hasTrips && !hasSettlements ? "gmail" : "trips"}`;
  if (hasTrips && hasGmail && hasSettlements) {
    badge.textContent = "Trips + Gmail + Settlement";
  } else if (hasTrips && hasGmail) {
    badge.textContent = "Trips + Gmail";
  } else if (hasSettlements && hasGmail) {
    badge.textContent = "Gmail + Settlement";
  } else if (hasSettlements && hasTrips) {
    badge.textContent = "Trips + Settlement";
  } else if (hasSettlements) {
    badge.textContent = "Settlement";
  } else if (hasGmail) {
    badge.textContent = load.missingFromTrips ? "Gmail only" : "Gmail";
  } else {
    badge.textContent = "Trips";
  }
  return badge;
}

function sourceHas(load, value) {
  return String(load.source || "trips").split("+").includes(value);
}

function isInvoicePaid(load) {
  return String(load.invoiceStatus || "").toLowerCase() === "paid";
}

function needsReview(load) {
  if (load.manualReview) return true;
  if (isDisputePaid(load) || isInvoicePaid(load)) return false;
  return Boolean(load.missingFromTrips || load.status === "Needs review" || load.invoiceStatus === "Disputed");
}

async function updateLoad(id, patch) {
  try {
    await apiPatch(`/loads/${encodeURIComponent(id)}`, patch);
    const index = state.loads.findIndex((load) => load.id === id);
    if (index >= 0) {
      state.loads[index] = { ...state.loads[index], ...patch };
      if (Object.prototype.hasOwnProperty.call(patch, "driverName")) {
        state.loads[index] = { ...state.loads[index], driverName: normalizeDriverName(patch.driverName), manualDriverOverride: true };
      }
    }
    if (Object.prototype.hasOwnProperty.call(patch, "driverName") || Object.prototype.hasOwnProperty.call(patch, "manualReview")) {
      populateFilterOptions();
    }
    render();
    setStatus("Saved change.");
  } catch (error) {
    setStatus(`Save failed: ${error.message}`);
  }
}

function populateDriverSelect(select, currentDriver) {
  const normalizedCurrent = normalizeDriverName(currentDriver);
  const values = driverOptionValues();
  if (normalizedCurrent && !values.includes(normalizedCurrent)) values.push(normalizedCurrent);
  select.replaceChildren(new Option("Unassigned", ""));
  values.forEach((value) => select.append(new Option(titleCaseCity(value), value)));
  select.value = normalizedCurrent || "";
}

function driverOptionValues() {
  return uniqueValues(ledgerLoads().map((load) => normalizeDriverName(load.driverName)).filter(Boolean)).sort((a, b) => {
    if (a === "RANJIT SINGH") return -1;
    if (b === "RANJIT SINGH") return 1;
    return a.localeCompare(b);
  });
}

function cleanPlace(value) {
  return String(value || "").replace(/\b[A-Z0-9]{3,5}\s+/g, "").replace(/\s+/g, " ").trim();
}

function displayRoute(load) {
  const fallback = routeFromRawEmail(load.rawEmailText);
  return {
    origin: cleanCity(load.origin || fallback.origin),
    destination: cleanCity(load.destination || fallback.destination)
  };
}

function routeFromRawEmail(value) {
  const text = decodeEmailText(value).replace(/\s+/g, " ").trim();
  const match = text.match(
    /\b[A-Z0-9]{3,5}\s+([A-Z][A-Z .'-]+?),\s*(CA|California)\s*(?:>|→|->)\s*[A-Z0-9]{3,5}\s+([A-Z][A-Z .'-]+?),\s*(CA|California)\b/i
  );

  if (!match) return { origin: "", destination: "" };
  return {
    origin: `${match[1]}, ${normalizeStateName(match[2])}`,
    destination: `${match[3]}, ${normalizeStateName(match[4])}`
  };
}

function decodeEmailText(value) {
  return String(value || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#x27;/gi, "'")
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&gt;/gi, ">")
    .replace(/&lt;/gi, "<")
    .replace(/&amp;/gi, "&");
}

function normalizeStateName(value) {
  return /^california$/i.test(String(value || "")) ? "CA" : String(value || "").toUpperCase();
}

function cleanCity(value) {
  const withoutCode = cleanPlace(value);
  const city = withoutCode
    .replace(/\b\d{5}(?:-\d{4})?\b/g, "")
    .replace(/,\s*(?:AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|IA|ID|IL|IN|KS|KY|LA|MA|MD|ME|MI|MN|MO|MS|MT|NC|ND|NE|NH|NJ|NM|NV|NY|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VA|VT|WA|WI|WV|WY)\b/gi, "")
    .replace(/,\s*(?:Alabama|Alaska|Arizona|Arkansas|California|Colorado|Connecticut|Delaware|Florida|Georgia|Hawaii|Idaho|Illinois|Indiana|Iowa|Kansas|Kentucky|Louisiana|Maine|Maryland|Massachusetts|Michigan|Minnesota|Mississippi|Missouri|Montana|Nebraska|Nevada|New Hampshire|New Jersey|New Mexico|New York|North Carolina|North Dakota|Ohio|Oklahoma|Oregon|Pennsylvania|Rhode Island|South Carolina|South Dakota|Tennessee|Texas|Utah|Vermont|Virginia|Washington|West Virginia|Wisconsin|Wyoming)\b/gi, "")
    .replace(/\s*,\s*$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return titleCaseCity(city);
}

function titleCaseCity(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}

function displayDriver(value) {
  const normalized = normalizeDriverName(value);
  if (!normalized) return "Unassigned";
  const parts = normalized.split(/\s+/).filter(Boolean);
  if (parts.length < 2) return normalized;
  return `${parts[0][0]}. ${parts.at(-1)}`;
}

function normalizeDriverName(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  const normalized = text.replace(/[^a-z]/gi, "").toLowerCase();
  if (normalized === "rsingh" || normalized === "ranjitsingh" || normalized === "rajitsingh") {
    return "RANJIT SINGH";
  }
  return text.toUpperCase();
}

function moneyValue(value) {
  const number = Number(String(value ?? "").replace(/[$,]/g, ""));
  return Number.isFinite(number) ? number : 0;
}

function ledgerPayout(load) {
  if (isDisputePaid(load) && moneyValue(load.settlementAmount) > 0) return moneyValue(load.settlementAmount);
  if (isCancelledLoad(load)) return 175;

  if (sourceHas(load, "gmail")) {
    const gmailPayout = moneyValue(load.gmailPayout ?? load.originalBookedPayout ?? load.bookedPayout);
    if (gmailPayout > 0) return gmailPayout;
  }
  return moneyValue(load.payout);
}

function isCancelledLoad(load) {
  return String(load.status || load.currentTripStatus || "").toLowerCase() === "cancelled";
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
  return loadDate(value)?.getTime() || 0;
}

function loadDate(value) {
  const text = String(value || "").trim();
  if (!text) return null;

  const isoDate = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoDate) {
    return new Date(Number(isoDate[1]), Number(isoDate[2]) - 1, Number(isoDate[3]), 12);
  }

  const monthMatch = text.match(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{1,2})\b/i);
  if (monthMatch) {
    const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
    const month = months.indexOf(monthMatch[1].slice(0, 3).toLowerCase());
    const day = Number(monthMatch[2]);
    const year = inferredYearForMonthDay(month, day);
    return new Date(year, month, day, 12);
  }

  const parsed = new Date(text);
  if (!Number.isNaN(parsed.getTime())) {
    return new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate(), 12);
  }

  return null;
}

function inferredYearForMonthDay(month, day) {
  const now = new Date();
  const candidate = new Date(now.getFullYear(), month, day, 12);
  const sixMonthsMs = 183 * 24 * 60 * 60 * 1000;
  if (candidate.getTime() - now.getTime() > sixMonthsMs) return now.getFullYear() - 1;
  if (now.getTime() - candidate.getTime() > sixMonthsMs) return now.getFullYear() + 1;
  return now.getFullYear();
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
