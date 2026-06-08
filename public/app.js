const promptInput = document.querySelector("#prompt");
const promptListInput = document.querySelector("#promptList");
const apiKeyInput = document.querySelector("#apiKeyInput");
const apiKeysBulkInput = document.querySelector("#apiKeysBulk");
const addApiKeyButton = document.querySelector("#addApiKeyButton");
const refreshQuotaButton = document.querySelector("#refreshQuotaButton");
const clearApiKeysButton = document.querySelector("#clearApiKeysButton");
const apiKeyList = document.querySelector("#apiKeyList");
const countInput = document.querySelector("#count");
const concurrencyInput = document.querySelector("#concurrency");
const queueModeInput = document.querySelector("#queueMode");
const retryMaxInput = document.querySelector("#retryMax");
const retryDelaySecondsInput = document.querySelector("#retryDelaySeconds");
const imageSizeInput = document.querySelector("#imageSize");
const aspectRatioInput = document.querySelector("#aspectRatio");
const templateNameInput = document.querySelector("#templateName");
const templateSelect = document.querySelector("#templateSelect");
const saveTemplateButton = document.querySelector("#saveTemplateButton");
const loadTemplateButton = document.querySelector("#loadTemplateButton");
const deleteTemplateButton = document.querySelector("#deleteTemplateButton");
const runButton = document.querySelector("#runButton");
const clearButton = document.querySelector("#clearButton");
const results = document.querySelector("#results");
const progressText = document.querySelector("#progressText");
const progressBar = document.querySelector("#progressBar");
const serverState = document.querySelector("#serverState");
const keyPoolSummary = document.querySelector("#keyPoolSummary");
const viewTabs = document.querySelectorAll(".tab");
const views = document.querySelectorAll(".view");

let activeRun = false;
let total = 0;
let finished = 0;
const cards = new Map();
const taskTimers = new Map();
const TEMPLATE_KEY = "riverflow.promptTemplates";
const API_KEYS_KEY = "riverflow.apiKeys";
const API_KEY_LIMITS_KEY = "riverflow.apiKeyLimits";
const API_KEY_INFO_KEY = "riverflow.apiKeyInfo";
const API_KEY_QUOTA_RESET_KEY = "riverflow.lastQuotaResetAt";
let apiKeys = readStoredApiKeys();
let apiKeyLimits = readStoredApiKeyLimits();
let apiKeyInfo = readStoredApiKeyInfo();
let lastQuotaResetAt = readStoredQuotaResetAt();
let currentBatchKeys = [];

function readTemplates() {
  try {
    return JSON.parse(localStorage.getItem(TEMPLATE_KEY) || "{}");
  } catch {
    return {};
  }
}

function writeTemplates(templates) {
  localStorage.setItem(TEMPLATE_KEY, JSON.stringify(templates));
}

function readStoredApiKeys() {
  try {
    const keys = JSON.parse(localStorage.getItem(API_KEYS_KEY) || "[]");
    return Array.isArray(keys) ? keys.filter((key) => typeof key === "string" && key.trim()) : [];
  } catch {
    return [];
  }
}

function writeStoredApiKeys() {
  localStorage.setItem(API_KEYS_KEY, JSON.stringify(apiKeys));
}

function readStoredApiKeyLimits() {
  try {
    const limits = JSON.parse(localStorage.getItem(API_KEY_LIMITS_KEY) || "{}");
    return limits && typeof limits === "object" && !Array.isArray(limits) ? limits : {};
  } catch {
    return {};
  }
}

function writeStoredApiKeyLimits() {
  localStorage.setItem(API_KEY_LIMITS_KEY, JSON.stringify(apiKeyLimits));
}

function readStoredApiKeyInfo() {
  try {
    const info = JSON.parse(localStorage.getItem(API_KEY_INFO_KEY) || "{}");
    return info && typeof info === "object" && !Array.isArray(info) ? info : {};
  } catch {
    return {};
  }
}

function writeStoredApiKeyInfo() {
  localStorage.setItem(API_KEY_INFO_KEY, JSON.stringify(apiKeyInfo));
}

function readStoredQuotaResetAt() {
  const value = Number(localStorage.getItem(API_KEY_QUOTA_RESET_KEY) || 0);
  return Number.isFinite(value) ? value : 0;
}

function writeStoredQuotaResetAt() {
  localStorage.setItem(API_KEY_QUOTA_RESET_KEY, String(lastQuotaResetAt));
}

function nextBeijing8ResetAt(now = new Date()) {
  const beijingOffsetMs = 8 * 60 * 60 * 1000;
  const beijingNow = new Date(now.getTime() + beijingOffsetMs);
  const year = beijingNow.getUTCFullYear();
  const month = beijingNow.getUTCMonth();
  const date = beijingNow.getUTCDate();
  let resetAt = Date.UTC(year, month, date, 0, 0, 0);

  if (now.getTime() >= resetAt) {
    resetAt = Date.UTC(year, month, date + 1, 0, 0, 0);
  }

  return resetAt;
}

function latestBeijing8ResetAt(now = new Date()) {
  const beijingOffsetMs = 8 * 60 * 60 * 1000;
  const beijingNow = new Date(now.getTime() + beijingOffsetMs);
  const year = beijingNow.getUTCFullYear();
  const month = beijingNow.getUTCMonth();
  const date = beijingNow.getUTCDate();
  let resetAt = Date.UTC(year, month, date, 0, 0, 0);

  if (now.getTime() < resetAt) {
    resetAt = Date.UTC(year, month, date - 1, 0, 0, 0);
  }

  return resetAt;
}

function resetExpiredApiKeyLimits() {
  const now = Date.now();
  let changed = false;

  for (const [key, limit] of Object.entries(apiKeyLimits)) {
    if (!apiKeys.includes(key) || Number(limit?.resetAt || 0) <= now) {
      delete apiKeyLimits[key];
      resetEstimatedRemaining(key);
      changed = true;
    }
  }

  if (changed) writeStoredApiKeyLimits();
  return changed;
}

function resetDailyQuotaEstimates() {
  const latestResetAt = latestBeijing8ResetAt();
  if (lastQuotaResetAt >= latestResetAt) return false;

  let changed = false;
  for (const key of apiKeys) {
    if (resetEstimatedRemaining(key, latestResetAt)) {
      changed = true;
    }
  }

  lastQuotaResetAt = latestResetAt;
  writeStoredQuotaResetAt();
  return changed;
}

function refreshDailyKeyState() {
  const limitsChanged = resetExpiredApiKeyLimits();
  const quotasChanged = resetDailyQuotaEstimates();
  return limitsChanged || quotasChanged;
}

function markApiKeyDailyLimited(key) {
  if (!key) return;
  apiKeyLimits[key] = {
    status: "daily-limited",
    resetAt: nextBeijing8ResetAt()
  };
  writeStoredApiKeyLimits();
}

function isApiKeyDailyLimited(key) {
  refreshDailyKeyState();
  return apiKeyLimits[key]?.status === "daily-limited";
}

function activeApiKeys() {
  refreshDailyKeyState();
  return apiKeys.filter((key) => !isApiKeyDailyLimited(key));
}

function updateKeyPoolSummary() {
  const ready = activeApiKeys().length;
  const totalKeys = apiKeys.length;
  const limited = Object.keys(apiKeyLimits).filter((key) => apiKeys.includes(key)).length;
  keyPoolSummary.textContent = `${ready} ready / ${totalKeys} total${limited ? `, ${limited} daily-limited` : ""}`;
}

function formatBeijingReset(resetAt) {
  if (!resetAt) return "";
  const date = new Date(resetAt + 8 * 60 * 60 * 1000);
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} 08:00 Beijing`;
}

function formatNullable(value) {
  return value === null || value === undefined ? "unknown" : String(value);
}

function freeInfoForKey(key) {
  const info = apiKeyInfo[key];
  if (!info || info.status === "error") return null;
  return info.freeModels || null;
}

function accountTypeForKey(key) {
  const total = freeInfoForKey(key)?.total;
  if (total === 50) return "Free";
  if (total === 1000) return "Credited";
  return "Unknown";
}

function totalQuotaForKey(key) {
  return formatNullable(freeInfoForKey(key)?.total);
}

function remainingQuotaForKey(key) {
  const free = freeInfoForKey(key);
  if (!free) return "unknown";
  return formatNullable(free.remaining);
}

function resetEstimatedRemaining(key, resetAt = latestBeijing8ResetAt()) {
  const free = freeInfoForKey(key);
  if (!free?.total) return false;
  free.remaining = free.total;
  free.source = "local-estimate";
  free.lastResetAt = resetAt;
  free.updatedAt = Date.now();
  apiKeyInfo[key].freeModels = free;
  writeStoredApiKeyInfo();
  return true;
}

function decrementEstimatedRemaining(key) {
  const free = freeInfoForKey(key);
  if (!free?.total) return;
  if (free.remaining === null || free.remaining === undefined) {
    free.remaining = free.total;
  }
  free.remaining = Math.max(0, Number(free.remaining) - 1);
  free.source = free.source || "local-estimate";
  free.lastResetAt = free.lastResetAt || latestBeijing8ResetAt();
  free.updatedAt = Date.now();
  apiKeyInfo[key].freeModels = free;
  writeStoredApiKeyInfo();
}

function refreshTemplates(selectedName = "") {
  const templates = readTemplates();
  const names = Object.keys(templates).sort((a, b) => a.localeCompare(b));
  templateSelect.innerHTML = "";

  const empty = document.createElement("option");
  empty.value = "";
  empty.textContent = names.length ? "Select a template" : "No templates saved";
  templateSelect.append(empty);

  for (const name of names) {
    const option = document.createElement("option");
    option.value = name;
    option.textContent = name;
    templateSelect.append(option);
  }

  templateSelect.value = selectedName && templates[selectedName] ? selectedName : "";
}

function currentTemplatePayload() {
  return {
    prompt: promptInput.value,
    promptList: promptListInput.value,
    count: countInput.value,
    concurrency: concurrencyInput.value,
    queueMode: queueModeInput.checked,
    retryMax: retryMaxInput.value,
    retryDelaySeconds: retryDelaySecondsInput.value,
    imageSize: imageSizeInput.value,
    aspectRatio: aspectRatioInput.value
  };
}

function applyTemplate(template) {
  promptInput.value = template.prompt || "";
  promptListInput.value = template.promptList || "";
  countInput.value = template.count || "4";
  concurrencyInput.value = template.concurrency || "3";
  queueModeInput.checked = template.queueMode === true;
  retryMaxInput.value = template.retryMax || "3";
  retryDelaySecondsInput.value = template.retryDelaySeconds || "70";
  imageSizeInput.value = template.imageSize || "auto";
  aspectRatioInput.value = template.aspectRatio || "auto";
  syncQueueControls();
}

function maskApiKey(key) {
  if (!key) return "empty";
  if (key.length <= 14) return `${key.slice(0, 4)}...${key.slice(-4)}`;
  return `${key.slice(0, 10)}...${key.slice(-6)}`;
}

function parseKeyText(text) {
  return String(text || "")
    .split(/[\r\n,;]+/)
    .map((key) => key.trim())
    .filter(Boolean);
}

function addApiKeys(keys) {
  const seen = new Set(apiKeys);
  let added = 0;
  for (const key of keys) {
    if (!seen.has(key)) {
      apiKeys.push(key);
      seen.add(key);
      added += 1;
    }
  }
  if (added) writeStoredApiKeys();
  refreshDailyKeyState();
  renderApiKeys();
  return added;
}

function absorbPendingApiKeys() {
  const added = addApiKeys([...parseKeyText(apiKeyInput.value), ...parseKeyText(apiKeysBulkInput.value)]);
  if (added) {
    apiKeyInput.value = "";
    apiKeysBulkInput.value = "";
  }
  return added;
}

function renderApiKeys(serverKeys = null) {
  refreshDailyKeyState();
  apiKeyList.innerHTML = "";

  const labels = apiKeys.length
    ? apiKeys.map((key, index) => {
        const serverState = serverKeys?.find((item) => item.id === index || item.label === maskApiKey(key));
        const limit = apiKeyLimits[key];
        return {
          index,
          label: maskApiKey(key),
          status: limit?.status || serverState?.status || "ready",
          resetText: limit?.resetAt ? `Resets ${formatBeijingReset(limit.resetAt)}` : "",
          removable: true
        };
      })
    : (serverKeys || []).map((item) => ({
        index: item.id,
        label: item.label,
        status: item.status || "active",
        removable: false
      }));

  if (!labels.length) {
    const empty = document.createElement("div");
    empty.className = "key-empty";
    empty.textContent = "No keys added. Add keys here before starting a batch.";
    apiKeyList.append(empty);
    updateKeyPoolSummary();
    return;
  }

  const header = document.createElement("div");
  header.className = "key-row key-header";
  header.innerHTML = `
    <span>Key</span>
    <span>Account</span>
    <span>Total</span>
    <span>Remaining</span>
    <span>Status</span>
    <span>Action</span>
  `;
  apiKeyList.append(header);

  for (const item of labels) {
    const row = document.createElement("div");
    const key = apiKeys[item.index];
    row.className = `key-row key-chip ${item.status}`;
    row.innerHTML = `
      <span>${item.label}${item.resetText ? `<small>${item.resetText}</small>` : ""}</span>
      <span>${accountTypeForKey(key)}</span>
      <span>${totalQuotaForKey(key)}</span>
      <span>${remainingQuotaForKey(key)}</span>
      <strong>${item.status}</strong>
      ${item.removable ? '<button type="button" aria-label="Remove API key">Remove</button>' : ""}
    `;
    const removeButton = row.querySelector("button");
    removeButton?.addEventListener("click", () => {
      const removedKey = apiKeys[item.index];
      apiKeys.splice(item.index, 1);
      delete apiKeyLimits[removedKey];
      delete apiKeyInfo[removedKey];
      writeStoredApiKeys();
      writeStoredApiKeyLimits();
      writeStoredApiKeyInfo();
      renderApiKeys();
    });
    apiKeyList.append(row);
  }
  updateKeyPoolSummary();
}

function setState(label, className) {
  serverState.textContent = label;
  serverState.className = `status ${className}`;
}

function updateProgress() {
  progressBar.max = Math.max(total, 1);
  progressBar.value = finished;
  progressText.textContent = total ? `${finished} / ${total} complete` : "Waiting for tasks";
}

function makeCard(index, prompt) {
  if (cards.has(index)) {
    startTaskTimer(index);
    appendCardNote(index, "Reassigned to another available key.");
    return;
  }

  const card = document.createElement("article");
  card.className = "result-card";
  card.innerHTML = `
    <div class="preview"><div class="spinner" aria-label="loading"></div></div>
    <div class="card-body">
      <div class="meta"><span>#${index + 1}</span><span>Running</span></div>
      <div class="prompt"></div>
    </div>
  `;
  card.querySelector(".prompt").textContent = prompt;
  results.append(card);
  cards.set(index, card);
  startTaskTimer(index);
}

function setCardStatus(index, label) {
  const card = cards.get(index);
  if (!card) return;
  card.querySelector(".meta span:last-child").textContent = label;
}

function startTaskTimer(index) {
  stopTaskTimer(index);
  const startedAt = Date.now();

  const update = () => {
    const seconds = Math.floor((Date.now() - startedAt) / 1000);
    setCardStatus(index, `正在生成（${seconds}秒）`);
  };

  update();
  taskTimers.set(index, setInterval(update, 1000));
}

function stopTaskTimer(index) {
  const timer = taskTimers.get(index);
  if (timer) clearInterval(timer);
  taskTimers.delete(index);
}

function appendCardNote(index, text) {
  const card = cards.get(index);
  if (!card) return;

  const note = document.createElement("div");
  note.className = "saved-path";
  note.textContent = text;
  card.querySelector(".card-body").append(note);
}

function markKeyLimited(event) {
  const key = Number.isInteger(event.key?.id) ? currentBatchKeys[event.key.id] : "";
  if (event.key?.status === "daily-limited") {
    markApiKeyDailyLimited(key);
    const free = freeInfoForKey(key);
    if (free) {
      free.remaining = 0;
      apiKeyInfo[key].freeModels = free;
      writeStoredApiKeyInfo();
    }
  }
  renderApiKeys(event.apiKeys);
  appendCardNote(event.index, `${event.key?.label || "API key"} hit a quota limit and was skipped.`);
}

async function refreshQuota() {
  absorbPendingApiKeys();

  if (!apiKeys.length) {
    progressText.textContent = "Add at least one key before checking quota";
    return;
  }

  refreshQuotaButton.disabled = true;
  progressText.textContent = "Checking key quota...";

  try {
    const response = await fetch("/api/key-info", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKeys })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || response.statusText);

    for (const item of data.keys || []) {
      const key = apiKeys[item.id];
      if (key) {
        const previousRemaining = apiKeyInfo[key]?.freeModels?.remaining;
        const nextInfo = { ...item, checkedAt: Date.now() };
        if (nextInfo.freeModels && (nextInfo.freeModels.remaining === null || nextInfo.freeModels.remaining === undefined)) {
          nextInfo.freeModels.remaining =
            previousRemaining === null || previousRemaining === undefined
              ? nextInfo.freeModels.total
              : previousRemaining;
          nextInfo.freeModels.source = "local-estimate";
        }
        apiKeyInfo[key] = nextInfo;
      }
    }

    writeStoredApiKeyInfo();
    renderApiKeys();
    progressText.textContent = "Quota refreshed";
  } catch (error) {
    progressText.textContent = error.message;
  } finally {
    refreshQuotaButton.disabled = false;
  }
}

function markDone(event) {
  const card = cards.get(event.index);
  if (!card) return;
  stopTaskTimer(event.index);
  const key = Number.isInteger(event.key?.id) ? currentBatchKeys[event.key.id] : "";
  decrementEstimatedRemaining(key);
  renderApiKeys();

  const preview = card.querySelector(".preview");
  const metaStatus = card.querySelector(".meta span:last-child");
  const imageUrl = event.images[0];
  const saved = event.savedImages?.[0];
  preview.innerHTML = `<img alt="Generated image ${event.index + 1}" src="${imageUrl}" />`;
  metaStatus.textContent = `${Math.round(event.durationMs / 1000)}s`;

  if (saved?.filename) {
    const savedLine = document.createElement("div");
    savedLine.className = "saved-path";
    savedLine.textContent = `Saved: outputs/${saved.filename}`;
    card.querySelector(".card-body").append(savedLine);
  }

  const link = document.createElement("a");
  link.className = "download";
  link.href = imageUrl;
  link.target = "_blank";
  link.rel = "noreferrer";
  link.textContent = "Open image";
  card.querySelector(".card-body").append(link);
}

function markError(event) {
  const card = cards.get(event.index);
  if (!card) return;
  stopTaskTimer(event.index);

  if (event.charged && Number.isInteger(event.key?.id)) {
    decrementEstimatedRemaining(currentBatchKeys[event.key.id]);
    renderApiKeys();
  }

  card.querySelector(".preview").innerHTML = `<div class="error-text">Request failed</div>`;
  card.querySelector(".meta span:last-child").textContent = `${Math.round(event.durationMs / 1000)}s`;
  const error = document.createElement("div");
  error.className = "error-text";
  error.textContent = event.error;
  card.querySelector(".card-body").append(error);
}

async function runBatch() {
  if (activeRun) return;
  absorbPendingApiKeys();
  refreshDailyKeyState();
  currentBatchKeys = activeApiKeys();

  if (!currentBatchKeys.length) {
    setState("Error", "error");
    progressText.textContent = apiKeys.length
      ? "All API keys are daily-limited until the next Beijing 08:00 reset."
      : "Add at least one API key to the key pool first.";
    renderApiKeys();
    return;
  }

  for (const index of taskTimers.keys()) stopTaskTimer(index);
  results.innerHTML = "";
  cards.clear();
  total = 0;
  finished = 0;
  updateProgress();
  activeRun = true;
  runButton.disabled = true;
  setState("Running", "running");

  try {
    const response = await fetch("/api/batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: promptInput.value,
        promptList: promptListInput.value,
        apiKeys: currentBatchKeys,
        count: countInput.value,
        concurrency: concurrencyInput.value,
        queueMode: queueModeInput.checked,
        retryMax: retryMaxInput.value,
        retryDelaySeconds: retryDelaySecondsInput.value,
        imageSize: imageSizeInput.value,
        aspectRatio: aspectRatioInput.value
      })
    });

    if (!response.ok || !response.body) {
      const error = await response.json().catch(() => ({ error: response.statusText }));
      throw new Error(error.error || response.statusText);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) continue;
        const event = JSON.parse(line);

        if (event.type === "start") {
          total = event.total;
          finished = 0;
          renderApiKeys(event.apiKeys);
          updateProgress();
        }

        if (event.type === "task-start") {
          makeCard(event.index, event.prompt);
        }

        if (event.type === "task-done") {
          finished += 1;
          markDone(event);
          updateProgress();
        }

        if (event.type === "task-key") {
          appendCardNote(event.index, `Using ${event.key.label}`);
        }

        if (event.type === "key-limited") {
          markKeyLimited(event);
        }

        if (event.type === "task-retry") {
          const seconds = Math.round(event.waitMs / 1000);
          const reason = event.error ? ` ${String(event.error).slice(0, 160)}` : "";
          setCardStatus(event.index, `Retry ${event.nextAttempt}/${event.maxAttempts}`);
          appendCardNote(event.index, `Request interrupted. Retrying in ${seconds}s.${reason}`);
        }

        if (event.type === "task-wait") {
          progressText.textContent = `Queue wait: ${Math.round(event.waitMs / 1000)}s before next request`;
        }

        if (event.type === "task-error") {
          finished += 1;
          markError(event);
          updateProgress();
        }

        if (event.type === "done") {
          finished = event.completed;
          updateProgress();
        }
      }
    }

    setState("Ready", "idle");
  } catch (error) {
    setState("Error", "error");
    progressText.textContent = error.message;
  } finally {
    activeRun = false;
    runButton.disabled = false;
  }
}

function syncQueueControls() {
  const queueEnabled = queueModeInput.checked;
  concurrencyInput.disabled = queueEnabled;
  concurrencyInput.title = queueEnabled ? "Queue mode forces per-key concurrency to 1." : "";
}

function showView(viewId) {
  for (const view of views) {
    view.classList.toggle("active", view.id === viewId);
  }

  for (const tab of viewTabs) {
    tab.classList.toggle("active", tab.dataset.view === viewId);
  }
}

runButton.addEventListener("click", runBatch);
clearButton.addEventListener("click", () => {
  for (const index of taskTimers.keys()) stopTaskTimer(index);
  results.innerHTML = "";
  cards.clear();
  total = 0;
  finished = 0;
  updateProgress();
  setState("Ready", "idle");
});

saveTemplateButton.addEventListener("click", () => {
  const name = templateNameInput.value.trim();
  if (!name) {
    progressText.textContent = "Enter a template name first";
    return;
  }

  const templates = readTemplates();
  templates[name] = currentTemplatePayload();
  writeTemplates(templates);
  refreshTemplates(name);
  progressText.textContent = `Template saved: ${name}`;
});

loadTemplateButton.addEventListener("click", () => {
  const name = templateSelect.value;
  const templates = readTemplates();
  if (!name || !templates[name]) return;

  applyTemplate(templates[name]);
  templateNameInput.value = name;
  progressText.textContent = `Template loaded: ${name}`;
});

deleteTemplateButton.addEventListener("click", () => {
  const name = templateSelect.value;
  if (!name) return;

  const templates = readTemplates();
  delete templates[name];
  writeTemplates(templates);
  refreshTemplates();
  progressText.textContent = `Template deleted: ${name}`;
});

queueModeInput.addEventListener("change", syncQueueControls);
viewTabs.forEach((tab) => {
  tab.addEventListener("click", () => showView(tab.dataset.view));
});
addApiKeyButton.addEventListener("click", () => {
  const added = absorbPendingApiKeys();
  progressText.textContent = added ? `${added} key(s) added to the pool` : "Paste at least one key first";
  if (added) refreshQuota();
});

apiKeyInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    const added = absorbPendingApiKeys();
    progressText.textContent = added ? `${added} key(s) added to the pool` : "Paste at least one key first";
  }
});

clearApiKeysButton.addEventListener("click", () => {
  apiKeys = [];
  apiKeyLimits = {};
  apiKeyInfo = {};
  lastQuotaResetAt = latestBeijing8ResetAt();
  writeStoredApiKeys();
  writeStoredApiKeyLimits();
  writeStoredApiKeyInfo();
  writeStoredQuotaResetAt();
  renderApiKeys();
});

refreshQuotaButton.addEventListener("click", refreshQuota);

refreshTemplates();
syncQueueControls();
renderApiKeys();
updateProgress();

setInterval(() => {
  if (refreshDailyKeyState()) renderApiKeys();
}, 60 * 1000);
