const chatModelSelect = document.querySelector("#chatModelSelect");
const chatMessagesEl = document.querySelector("#chatMessages");
const chatInput = document.querySelector("#chatInput");
const sendChatButton = document.querySelector("#sendChatButton");
const clearChatButton = document.querySelector("#clearChatButton");
const refreshModelsFromChatButton = document.querySelector("#refreshModelsFromChatButton");
const chatKeySummary = document.querySelector("#chatKeySummary");
const imageModelSelect = document.querySelector("#imageModelSelect");
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
const refreshModelsButton = document.querySelector("#refreshModelsButton");
const modelSummary = document.querySelector("#modelSummary");
const textModelList = document.querySelector("#textModelList");
const imageModelList = document.querySelector("#imageModelList");
const viewTabs = document.querySelectorAll(".tab");
const views = document.querySelectorAll(".view");

const DEFAULT_TEXT_MODEL = "nvidia/nemotron-3-ultra-550b-a55b:free";
const DEFAULT_IMAGE_MODEL = "sourceful/riverflow-v2.5-pro:free";
const TEMPLATE_KEY = "riverflow.promptTemplates";
const API_KEYS_KEY = "riverflow.apiKeys";
const API_KEY_LIMITS_KEY = "riverflow.apiKeyLimits";
const API_KEY_INFO_KEY = "riverflow.apiKeyInfo";
const API_KEY_QUOTA_RESET_KEY = "riverflow.lastQuotaResetAt";
const MODEL_CACHE_KEY = "openrouter.modelCache";
const CHAT_MESSAGES_KEY = "openrouter.chatMessages";

let activeRun = false;
let activeChat = false;
let total = 0;
let finished = 0;
const cards = new Map();
const taskTimers = new Map();
let apiKeys = readStoredApiKeys();
let apiKeyLimits = readStoredApiKeyLimits();
let apiKeyInfo = readStoredApiKeyInfo();
let lastQuotaResetAt = readStoredQuotaResetAt();
let modelCache = readStoredModelCache();
let chatMessages = readStoredChatMessages();
let currentBatchKeys = [];

function fallbackModelCache() {
  const now = Date.now();
  const models = [
    {
      id: DEFAULT_TEXT_MODEL,
      name: "NVIDIA: Nemotron 3 Ultra (free)",
      type: "text",
      inputModalities: ["text"],
      outputModalities: ["text"],
      supportedParameters: ["max_tokens", "temperature"],
      pricing: { prompt: "0", completion: "0" },
      status: "seeded",
      lastError: "",
      updatedAt: now
    },
    {
      id: DEFAULT_IMAGE_MODEL,
      name: "Sourceful: Riverflow v2.5 Pro (free)",
      type: "image",
      inputModalities: ["text"],
      outputModalities: ["image"],
      supportedParameters: ["image_config"],
      pricing: { image: "0" },
      status: "seeded",
      lastError: "",
      updatedAt: now
    },
    {
      id: "sourceful/riverflow-v2.5-fast:free",
      name: "Sourceful: Riverflow v2.5 Fast (free)",
      type: "image",
      inputModalities: ["text"],
      outputModalities: ["image"],
      supportedParameters: ["image_config"],
      pricing: { image: "0" },
      status: "seeded",
      lastError: "",
      updatedAt: now
    }
  ];

  return {
    models,
    text: models.filter((model) => model.type === "text" || model.type === "mixed"),
    image: models.filter((model) => model.type === "image" || model.type === "mixed"),
    refreshedAt: 0,
    source: "seed",
    error: ""
  };
}

function readJsonStorage(key, fallback) {
  try {
    const value = JSON.parse(localStorage.getItem(key) || "null");
    return value ?? fallback;
  } catch {
    return fallback;
  }
}

function writeJsonStorage(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function readTemplates() {
  return readJsonStorage(TEMPLATE_KEY, {});
}

function writeTemplates(templates) {
  writeJsonStorage(TEMPLATE_KEY, templates);
}

function readStoredApiKeys() {
  const keys = readJsonStorage(API_KEYS_KEY, []);
  return Array.isArray(keys) ? keys.filter((key) => typeof key === "string" && key.trim()) : [];
}

function writeStoredApiKeys() {
  writeJsonStorage(API_KEYS_KEY, apiKeys);
}

function readStoredApiKeyLimits() {
  const limits = readJsonStorage(API_KEY_LIMITS_KEY, {});
  return limits && typeof limits === "object" && !Array.isArray(limits) ? limits : {};
}

function writeStoredApiKeyLimits() {
  writeJsonStorage(API_KEY_LIMITS_KEY, apiKeyLimits);
}

function readStoredApiKeyInfo() {
  const info = readJsonStorage(API_KEY_INFO_KEY, {});
  return info && typeof info === "object" && !Array.isArray(info) ? info : {};
}

function writeStoredApiKeyInfo() {
  writeJsonStorage(API_KEY_INFO_KEY, apiKeyInfo);
}

function readStoredQuotaResetAt() {
  const value = Number(localStorage.getItem(API_KEY_QUOTA_RESET_KEY) || 0);
  return Number.isFinite(value) ? value : 0;
}

function writeStoredQuotaResetAt() {
  localStorage.setItem(API_KEY_QUOTA_RESET_KEY, String(lastQuotaResetAt));
}

function readStoredModelCache() {
  const fallback = fallbackModelCache();
  const cache = readJsonStorage(MODEL_CACHE_KEY, fallback);
  if (!cache || !Array.isArray(cache.text) || !Array.isArray(cache.image)) return fallback;
  return cache;
}

function writeStoredModelCache() {
  writeJsonStorage(MODEL_CACHE_KEY, modelCache);
}

function readStoredChatMessages() {
  const messages = readJsonStorage(CHAT_MESSAGES_KEY, []);
  return Array.isArray(messages)
    ? messages.filter((message) => message && typeof message.content === "string" && ["user", "assistant"].includes(message.role))
    : [];
}

function writeStoredChatMessages() {
  writeJsonStorage(CHAT_MESSAGES_KEY, chatMessages.slice(-40));
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
    if (resetEstimatedRemaining(key, latestResetAt)) changed = true;
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

function activeApiKeys() {
  refreshDailyKeyState();
  return apiKeys.filter((key) => apiKeyLimits[key]?.status !== "daily-limited");
}

function updateKeyPoolSummary() {
  const ready = activeApiKeys().length;
  const totalKeys = apiKeys.length;
  const limited = Object.keys(apiKeyLimits).filter((key) => apiKeys.includes(key)).length;
  const summary = `${ready} 可用 / ${totalKeys} 总数${limited ? `，${limited} 个已达每日额度` : ""}`;
  keyPoolSummary.textContent = summary;
  chatKeySummary.textContent = summary;
}

function formatBeijingReset(resetAt) {
  if (!resetAt) return "";
  const date = new Date(resetAt + 8 * 60 * 60 * 1000);
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} 北京时间 08:00`;
}

function formatNullable(value) {
  return value === null || value === undefined ? "未知" : String(value);
}

function freeInfoForKey(key) {
  const info = apiKeyInfo[key];
  if (!info || info.status === "error") return null;
  return info.freeModels || null;
}

function accountTypeForKey(key) {
  const total = freeInfoForKey(key)?.total;
  if (total === 50) return "免费账户";
  if (total === 1000) return "已充值账户";
  return "未知";
}

function totalQuotaForKey(key) {
  return formatNullable(freeInfoForKey(key)?.total);
}

function remainingQuotaForKey(key) {
  const free = freeInfoForKey(key);
  if (!free) return "unknown";
  return formatNullable(free.remaining);
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
    imageModel: imageModelSelect.value,
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
  if (template.imageModel) imageModelSelect.value = template.imageModel;
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

function modelLabel(model) {
  return `${model.name || model.id} (${model.id})`;
}

function setSelectOptions(select, models, fallbackId) {
  const previous = select.value || fallbackId;
  select.innerHTML = "";

  for (const model of models) {
    const option = document.createElement("option");
    option.value = model.id;
    option.textContent = modelLabel(model);
    select.append(option);
  }

  if (!models.some((model) => model.id === fallbackId)) {
    const option = document.createElement("option");
    option.value = fallbackId;
    option.textContent = fallbackId;
    select.prepend(option);
  }

  select.value = models.some((model) => model.id === previous) || previous === fallbackId ? previous : fallbackId;
}

function renderModelSelectors() {
  setSelectOptions(chatModelSelect, modelCache.text || [], DEFAULT_TEXT_MODEL);
  setSelectOptions(imageModelSelect, modelCache.image || [], DEFAULT_IMAGE_MODEL);
}

function renderModelCard(model) {
  const div = document.createElement("div");
  div.className = `model-card ${model.status || "unknown"}`;
  const params = (model.supportedParameters || []).slice(0, 5).join(", ") || "default";
  const updated = model.updatedAt ? new Date(model.updatedAt).toLocaleString() : "unknown";
  div.innerHTML = `
    <div>
      <strong></strong>
      <code></code>
    </div>
    <span>${model.type || "model"} · ${model.status || "unknown"}</span>
    <small>Params: ${params}</small>
    <small>Updated: ${updated}</small>
    ${model.lastError ? `<small class="model-error">${model.lastError}</small>` : ""}
  `;
  div.querySelector("strong").textContent = model.name || model.id;
  div.querySelector("code").textContent = model.id;
  return div;
}

function renderModelLists() {
  textModelList.innerHTML = "";
  imageModelList.innerHTML = "";

  const textModels = modelCache.text || [];
  const imageModels = modelCache.image || [];
  for (const model of textModels) textModelList.append(renderModelCard(model));
  for (const model of imageModels) imageModelList.append(renderModelCard(model));

  if (!textModels.length) textModelList.append(emptyModelState("还没有缓存免费文本模型。"));
  if (!imageModels.length) imageModelList.append(emptyModelState("还没有缓存免费生图模型。"));

  const refreshed = modelCache.refreshedAt ? new Date(modelCache.refreshedAt).toLocaleString() : "尚未刷新";
  modelSummary.textContent = `${textModels.length} 个文本 / ${imageModels.length} 个生图免费模型 · 刷新时间 ${refreshed}${modelCache.error ? ` · ${modelCache.error}` : ""}`;
  renderModelSelectors();
}

function emptyModelState(text) {
  const div = document.createElement("div");
  div.className = "key-empty";
  div.textContent = text;
  return div;
}

async function loadModels() {
  try {
    const response = await fetch("/api/models");
    if (!response.ok) throw new Error(response.statusText);
    modelCache = await response.json();
    writeStoredModelCache();
  } catch (error) {
    modelCache = { ...modelCache, error: error.message };
  }
  renderModelLists();
}

async function refreshModels() {
  refreshModelsButton.disabled = true;
  refreshModelsFromChatButton.disabled = true;
  modelSummary.textContent = "正在刷新 OpenRouter 免费模型列表...";

  try {
    const response = await fetch("/api/models/refresh", { method: "POST" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || response.statusText);
    modelCache = data;
    writeStoredModelCache();
  } catch (error) {
    modelCache = { ...modelCache, error: error.message };
  } finally {
    refreshModelsButton.disabled = false;
    refreshModelsFromChatButton.disabled = false;
    renderModelLists();
  }
}

function applyServerKeyStatuses(serverKeys = []) {
  for (const item of serverKeys) {
    const key = Number.isInteger(item.id) ? apiKeys[item.id] : "";
    if (!key) continue;
    if (item.status === "daily-limited") {
      markApiKeyDailyLimited(key);
      const free = freeInfoForKey(key);
      if (free) {
        free.remaining = 0;
        apiKeyInfo[key].freeModels = free;
        writeStoredApiKeyInfo();
      }
    }
  }
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
          resetText: limit?.resetAt ? `刷新 ${formatBeijingReset(limit.resetAt)}` : "",
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
    empty.textContent = "还没有添加 key。请先添加 key，再开始聊天或批量生图。";
    apiKeyList.append(empty);
    updateKeyPoolSummary();
    return;
  }

  const header = document.createElement("div");
  header.className = "key-row key-header";
  header.innerHTML = `
    <span>Key</span>
    <span>账户性质</span>
    <span>总额度</span>
    <span>剩余额度</span>
    <span>状态</span>
    <span>操作</span>
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
      ${item.removable ? '<button type="button" aria-label="移除 API key">移除</button>' : ""}
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
  progressText.textContent = total ? `${finished} / ${total} 已完成` : "等待任务";
}

function renderChatMessages() {
  chatMessagesEl.innerHTML = "";

  if (!chatMessages.length) {
    const empty = document.createElement("div");
    empty.className = "chat-empty";
    empty.textContent = "还没有消息。";
    chatMessagesEl.append(empty);
    return;
  }

  for (const message of chatMessages) {
    const bubble = document.createElement("article");
    bubble.className = `chat-message ${message.role}`;
    const label = document.createElement("strong");
    label.textContent = message.role === "user" ? "我" : "助手";
    const body = document.createElement("p");
    body.textContent = message.content;
    bubble.append(label, body);
    chatMessagesEl.append(bubble);
  }

  chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
}

async function sendChat() {
  if (activeChat) return;
  const content = chatInput.value.trim();
  if (!content) return;

  const chatKeys = activeApiKeys();
  if (!chatKeys.length) {
    const message = apiKeys.length
      ? "所有 API key 都已达到每日额度，等待下一个北京时间 08:00 刷新。"
      : "请先到 key 池管理里添加至少一个 API key。";
    setState("错误", "error");
    chatKeySummary.textContent = message;
    chatMessages.push({ role: "assistant", content: message });
    writeStoredChatMessages();
    renderChatMessages();
    renderApiKeys();
    return;
  }

  chatMessages.push({ role: "user", content });
  chatInput.value = "";
  writeStoredChatMessages();
  renderChatMessages();
  activeChat = true;
  sendChatButton.disabled = true;
  setState("聊天中", "running");

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: chatModelSelect.value || DEFAULT_TEXT_MODEL,
        apiKeys: chatKeys,
        messages: chatMessages.slice(-20),
        retryMax: retryMaxInput.value,
        retryDelaySeconds: retryDelaySecondsInput.value
      })
    });
    const data = await response.json();
    if (!response.ok) throw Object.assign(new Error(data.error || response.statusText), { data });

    applyServerKeyStatuses(data.apiKeys);
    if (Number.isInteger(data.key?.id)) decrementEstimatedRemaining(chatKeys[data.key.id]);
    chatMessages.push(data.message);
    writeStoredChatMessages();
    renderChatMessages();
    renderApiKeys();
    setState("就绪", "idle");
  } catch (error) {
    applyServerKeyStatuses(error.data?.apiKeys || []);
    chatMessages.push({ role: "assistant", content: `错误：${error.message}` });
    writeStoredChatMessages();
    renderChatMessages();
    renderApiKeys();
    setState("错误", "error");
  } finally {
    activeChat = false;
    sendChatButton.disabled = false;
  }
}

function makeCard(index, prompt) {
  if (cards.has(index)) {
    startTaskTimer(index);
    appendCardNote(index, "已重新分配给另一个可用 key。");
    return;
  }

  const card = document.createElement("article");
  card.className = "result-card";
  card.innerHTML = `
    <div class="preview"><div class="spinner" aria-label="loading"></div></div>
    <div class="card-body">
      <div class="meta"><span>#${index + 1}</span><span>运行中</span></div>
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
  appendCardNote(event.index, `${event.key?.label || "API key"} 已达到额度限制，已跳过。`);
}

async function refreshQuota() {
  absorbPendingApiKeys();

  if (!apiKeys.length) {
    progressText.textContent = "请先添加至少一个 key，再刷新额度";
    return;
  }

  refreshQuotaButton.disabled = true;
  progressText.textContent = "正在检查 key 额度...";

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
    progressText.textContent = "额度已刷新";
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
    savedLine.textContent = `已保存：outputs/${saved.filename}`;
    card.querySelector(".card-body").append(savedLine);
  }

  const link = document.createElement("a");
  link.className = "download";
  link.href = imageUrl;
  link.target = "_blank";
  link.rel = "noreferrer";
  link.textContent = "打开图片";
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

  card.querySelector(".preview").innerHTML = `<div class="error-text">请求失败</div>`;
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
    setState("错误", "error");
    progressText.textContent = apiKeys.length
      ? "所有 API key 都已达到每日额度，等待下一个北京时间 08:00 刷新。"
      : "请先到 key 池管理里添加至少一个 API key。";
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
  setState("运行中", "running");

  try {
    const response = await fetch("/api/batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: imageModelSelect.value || DEFAULT_IMAGE_MODEL,
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
          progressText.textContent = `正在使用 ${event.model}`;
        }

        if (event.type === "task-start") makeCard(event.index, event.prompt);

        if (event.type === "task-done") {
          finished += 1;
          markDone(event);
          updateProgress();
        }

        if (event.type === "task-key") appendCardNote(event.index, `使用 ${event.key.label}`);
        if (event.type === "key-limited") markKeyLimited(event);

        if (event.type === "task-retry") {
          const seconds = Math.round(event.waitMs / 1000);
          const reason = event.error ? ` ${String(event.error).slice(0, 160)}` : "";
          setCardStatus(event.index, `重试 ${event.nextAttempt}/${event.maxAttempts}`);
          appendCardNote(event.index, `请求中断，${seconds} 秒后重试。${reason}`);
        }

        if (event.type === "task-wait") {
          progressText.textContent = `队列等待：${Math.round(event.waitMs / 1000)} 秒后发起下一次请求`;
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

    setState("就绪", "idle");
    loadModels();
  } catch (error) {
    setState("错误", "error");
    progressText.textContent = error.message;
  } finally {
    activeRun = false;
    runButton.disabled = false;
  }
}

function syncQueueControls() {
  const queueEnabled = queueModeInput.checked;
  concurrencyInput.disabled = queueEnabled;
  concurrencyInput.title = queueEnabled ? "队列模式会把每 key 并发固定为 1。" : "";
}

function showView(viewId) {
  for (const view of views) {
    view.classList.toggle("active", view.id === viewId);
  }

  for (const tab of viewTabs) {
    tab.classList.toggle("active", tab.dataset.view === viewId);
  }
}

sendChatButton.addEventListener("click", sendChat);
chatInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    sendChat();
  }
});
clearChatButton.addEventListener("click", () => {
  chatMessages = [];
  writeStoredChatMessages();
  renderChatMessages();
});
refreshModelsFromChatButton.addEventListener("click", refreshModels);
runButton.addEventListener("click", runBatch);
clearButton.addEventListener("click", () => {
  for (const index of taskTimers.keys()) stopTaskTimer(index);
  results.innerHTML = "";
  cards.clear();
  total = 0;
  finished = 0;
  updateProgress();
  setState("就绪", "idle");
});

saveTemplateButton.addEventListener("click", () => {
  const name = templateNameInput.value.trim();
  if (!name) {
    progressText.textContent = "请先输入模板名称";
    return;
  }

  const templates = readTemplates();
  templates[name] = currentTemplatePayload();
  writeTemplates(templates);
  refreshTemplates(name);
  progressText.textContent = `模板已保存：${name}`;
});

loadTemplateButton.addEventListener("click", () => {
  const name = templateSelect.value;
  const templates = readTemplates();
  if (!name || !templates[name]) return;

  applyTemplate(templates[name]);
  templateNameInput.value = name;
  progressText.textContent = `模板已载入：${name}`;
});

deleteTemplateButton.addEventListener("click", () => {
  const name = templateSelect.value;
  if (!name) return;

  const templates = readTemplates();
  delete templates[name];
  writeTemplates(templates);
  refreshTemplates();
  progressText.textContent = `模板已删除：${name}`;
});

queueModeInput.addEventListener("change", syncQueueControls);
viewTabs.forEach((tab) => {
  tab.addEventListener("click", () => showView(tab.dataset.view));
});
addApiKeyButton.addEventListener("click", () => {
  const added = absorbPendingApiKeys();
  progressText.textContent = added ? `已添加 ${added} 个 key 到 key 池` : "请先粘贴至少一个 key";
  if (added) refreshQuota();
});

apiKeyInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    const added = absorbPendingApiKeys();
    progressText.textContent = added ? `已添加 ${added} 个 key 到 key 池` : "请先粘贴至少一个 key";
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
refreshModelsButton.addEventListener("click", refreshModels);

refreshTemplates();
syncQueueControls();
renderModelLists();
renderChatMessages();
renderApiKeys();
updateProgress();
loadModels();

setInterval(() => {
  if (refreshDailyKeyState()) renderApiKeys();
}, 60 * 1000);
