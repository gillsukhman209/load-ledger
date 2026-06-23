const DEFAULT_SETTINGS = {
  backendBaseUrl: "",
  apiKey: "",
  autoSync: true,
  syncIntervalMinutes: 15,
  dateRangeDays: 60
};

const form = document.querySelector("#settings-form");
const status = document.querySelector("#status");

loadSettings();

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const settings = {
    backendBaseUrl: form.backendBaseUrl.value.trim(),
    apiKey: form.apiKey.value.trim(),
    autoSync: form.autoSync.checked,
    syncIntervalMinutes: Number(form.syncIntervalMinutes.value || DEFAULT_SETTINGS.syncIntervalMinutes),
    dateRangeDays: Number(form.dateRangeDays.value || DEFAULT_SETTINGS.dateRangeDays)
  };

  await chrome.storage.sync.set(settings);
  status.textContent = "Settings saved.";
  setTimeout(() => {
    status.textContent = "";
  }, 2500);
});

async function loadSettings() {
  const settings = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  form.backendBaseUrl.value = settings.backendBaseUrl || "";
  form.apiKey.value = settings.apiKey || "";
  form.autoSync.checked = Boolean(settings.autoSync);
  form.syncIntervalMinutes.value = settings.syncIntervalMinutes || DEFAULT_SETTINGS.syncIntervalMinutes;
  form.dateRangeDays.value = settings.dateRangeDays || DEFAULT_SETTINGS.dateRangeDays;
}
