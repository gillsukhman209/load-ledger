(function installRelayTripsLedgerHook() {
  if (window.__relayTripsLedgerHookInstalled) return;
  window.__relayTripsLedgerHookInstalled = true;

  const LOG_PREFIX = "[Relay Trips Ledger hook]";
  console.info(`${LOG_PREFIX} installed on page`);

  const postPayload = (source, url, payload) => {
    if (!payload || typeof payload !== "object") return;
    console.info(`${LOG_PREFIX} captured JSON response`, { source, url: String(url || "") });
    window.postMessage(
      {
        type: "RELAY_TRIPS_LEDGER_RESPONSE",
        source,
        url: String(url || ""),
        payload
      },
      window.location.origin
    );
  };

  const parseJsonSafely = (text) => {
    if (!text || typeof text !== "string") return null;
    const isUsefulRelayPayload =
      text.includes("T-") ||
      text.includes('"entities"') ||
      text.includes('"settlementList"') ||
      text.includes('"settlementsMetadata"') ||
      text.includes('"paymentStatus"');
    if (!isUsefulRelayPayload) return null;
    try {
      return JSON.parse(text);
    } catch (_error) {
      return null;
    }
  };

  const originalFetch = window.fetch;
  window.fetch = async function relayTripsLedgerFetch(input, init) {
    const response = await originalFetch.apply(this, arguments);
    try {
      const url = typeof input === "string" ? input : input && input.url;
      response
        .clone()
        .text()
        .then((text) => postPayload("fetch", url, parseJsonSafely(text)))
        .catch(() => {});
    } catch (_error) {
      // Ignore hook failures so Relay page behavior is never affected.
    }
    return response;
  };

  const OriginalXhr = window.XMLHttpRequest;
  const originalOpen = OriginalXhr.prototype.open;
  const originalSend = OriginalXhr.prototype.send;

  OriginalXhr.prototype.open = function relayTripsLedgerOpen(method, url) {
    this.__relayTripsLedgerUrl = url;
    return originalOpen.apply(this, arguments);
  };

  OriginalXhr.prototype.send = function relayTripsLedgerSend() {
    this.addEventListener("load", () => {
      try {
        const contentType = this.getResponseHeader("content-type") || "";
        if (!contentType.includes("json") && typeof this.responseText !== "string") return;
        postPayload("xhr", this.__relayTripsLedgerUrl, parseJsonSafely(this.responseText));
      } catch (_error) {
        // Ignore hook failures so Relay page behavior is never affected.
      }
    });
    return originalSend.apply(this, arguments);
  };
})();
