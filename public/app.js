const chatModelSelect = document.querySelector("#chatModelSelect");
const chatMessagesEl = document.querySelector("#chatMessages");
const chatInput = document.querySelector("#chatInput");
const sendChatButton = document.querySelector("#sendChatButton");
const stopChatButton = document.querySelector("#stopChatButton");
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
const stopRunButton = document.querySelector("#stopRunButton");
const clearButton = document.querySelector("#clearButton");
const results = document.querySelector("#results");
const progressText = document.querySelector("#progressText");
const progressBar = document.querySelector("#progressBar");
const serverState = document.querySelector("#serverState");
const keyPoolSummary = document.querySelector("#keyPoolSummary");
const refreshModelsButton = document.querySelector("#refreshModelsButton");
const modelSummary = document.querySelector("#modelSummary");
const modelSearchInput = document.querySelector("#modelSearch");
const modelStatusFilter = document.querySelector("#modelStatusFilter");
const modelHealthStats = document.querySelector("#modelHealthStats");
const textModelList = document.querySelector("#textModelList");
const imageModelList = document.querySelector("#imageModelList");
const outputSummary = document.querySelector("#outputSummary");
const outputSearchInput = document.querySelector("#outputSearch");
const outputGallery = document.querySelector("#outputGallery");
const refreshOutputsButton = document.querySelector("#refreshOutputsButton");
const activitySummary = document.querySelector("#activitySummary");
const activitySearchInput = document.querySelector("#activitySearch");
const activityTypeFilter = document.querySelector("#activityTypeFilter");
const activityStatusFilter = document.querySelector("#activityStatusFilter");
const activityList = document.querySelector("#activityList");
const exportActivityButton = document.querySelector("#exportActivityButton");
const exportFilteredActivityButton = document.querySelector("#exportFilteredActivityButton");
const clearActivityButton = document.querySelector("#clearActivityButton");
const localDataSummary = document.querySelector("#localDataSummary");
const exportLocalDataButton = document.querySelector("#exportLocalDataButton");
const importLocalDataButton = document.querySelector("#importLocalDataButton");
const localDataImportInput = document.querySelector("#localDataImportInput");
const localDataStatus = document.querySelector("#localDataStatus");
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
const ACTIVITY_LOG_KEY = "openrouter.activityLog";
const APP_SETTINGS_KEY = "openrouter.appSettings";
const MAX_ACTIVITY_ITEMS = 200;
const LOCAL_BACKUP_VERSION = 1;
const LOCAL_BACKUP_ITEMS = [
  { key: APP_SETTINGS_KEY, label: "当前设置", fallback: null },
  { key: TEMPLATE_KEY, label: "提示词模板", fallback: {} },
  { key: MODEL_CACHE_KEY, label: "模型缓存", fallback: null },
  { key: CHAT_MESSAGES_KEY, label: "聊天记录", fallback: [] },
  { key: ACTIVITY_LOG_KEY, label: "运行记录", fallback: [] }
];

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
let activityLog = readStoredActivityLog();
let appSettings = readStoredAppSettings();
let currentBatchKeys = [];
let outputImages = [];
let activeRunController = null;
let stopRequested = false;
let activeChatController = null;
let stopChatRequested = false;

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

function ensureApiKeyInfo(key) {
  if (!key) return null;
  const previous = apiKeyInfo[key] || {};
  apiKeyInfo[key] = {
    ...previous,
    label: previous.label || maskApiKey(key),
    status: previous.status || "ok"
  };
  return apiKeyInfo[key];
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

function readStoredActivityLog() {
  const items = readJsonStorage(ACTIVITY_LOG_KEY, []);
  return Array.isArray(items)
    ? items.filter((item) => item && typeof item.id === "string" && ["chat", "image"].includes(item.type)).slice(0, MAX_ACTIVITY_ITEMS)
    : [];
}

function writeStoredActivityLog() {
  writeJsonStorage(ACTIVITY_LOG_KEY, activityLog.slice(0, MAX_ACTIVITY_ITEMS));
}

function defaultAppSettings() {
  return {
    chatModel: DEFAULT_TEXT_MODEL,
    imageModel: DEFAULT_IMAGE_MODEL,
    count: "4",
    concurrency: "3",
    queueMode: false,
    retryMax: "3",
    retryDelaySeconds: "70",
    imageSize: "auto",
    aspectRatio: "auto"
  };
}

function readStoredAppSettings() {
  const settings = readJsonStorage(APP_SETTINGS_KEY, {});
  return settings && typeof settings === "object" && !Array.isArray(settings)
    ? { ...defaultAppSettings(), ...settings }
    : defaultAppSettings();
}

function writeStoredAppSettings() {
  writeJsonStorage(APP_SETTINGS_KEY, appSettings);
}

function clipText(text, max = 180) {
  const value = String(text || "").trim();
  return value.length > max ? `${value.slice(0, max - 1)}...` : value;
}

function addActivity(entry) {
  const item = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    createdAt: Date.now(),
    ...entry
  };
  activityLog = [item, ...activityLog].slice(0, MAX_ACTIVITY_ITEMS);
  writeStoredActivityLog();
  renderActivityLog();
}

function isPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function downloadJson(filename, payload) {
  const blob = new Blob([`${JSON.stringify(payload, null, 2)}\n`], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
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

function resetModelUsageCount(key, resetAt = latestBeijing8ResetAt()) {
  const info = ensureApiKeyInfo(key);
  if (!info) return false;
  const usage = info.modelUsage || {};
  if (Number(usage.resetAt || 0) === resetAt && Number(usage.consumed || 0) === 0) return false;
  info.modelUsage = {
    consumed: 0,
    resetAt,
    updatedAt: Date.now()
  };
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
      resetModelUsageCount(key);
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
    if (resetModelUsageCount(key, latestResetAt)) changed = true;
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

function markApiKeyDailyLimited(key, resetAt = nextBeijing8ResetAt()) {
  if (!key) return;
  apiKeyLimits[key] = {
    status: "daily-limited",
    resetAt
  };
  writeStoredApiKeyLimits();
}

function unlockApiKeyLimit(key) {
  if (!key) return;
  delete apiKeyLimits[key];
  writeStoredApiKeyLimits();
  resetEstimatedRemaining(key);
  resetModelUsageCount(key);
  renderApiKeys();
  setState("已解除 key 限流标记", "idle");
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

function formatBeijingDateTime(timestamp) {
  if (!timestamp) return "";
  const date = new Date(timestamp + 8 * 60 * 60 * 1000);
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  const hh = String(date.getUTCHours()).padStart(2, "0");
  const min = String(date.getUTCMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${min}`;
}

function formatBeijingReset(resetAt) {
  if (!resetAt) return "";
  return `${formatBeijingDateTime(resetAt)} 北京时间`;
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

function modelUsageForKey(key) {
  const usage = apiKeyInfo[key]?.modelUsage;
  if (!usage) return "0";
  const latestResetAt = latestBeijing8ResetAt();
  if (Number(usage.resetAt || 0) < latestResetAt) return "0";
  return String(Math.max(0, Number(usage.consumed || 0)));
}

function quotaSourceForKey(key) {
  const free = freeInfoForKey(key);
  if (!free?.source) return "未知来源";
  if (free.source === "response-header") return "响应头";
  if (free.source === "local-estimate") return "本地估算";
  if (free.source === "inferred") return "账户推断";
  return free.source;
}

function quotaMetaForKey(key) {
  const free = freeInfoForKey(key);
  if (!free) return "";
  const parts = [quotaSourceForKey(key)];
  if (free.updatedAt) parts.push(formatBeijingDateTime(free.updatedAt));
  return parts.filter(Boolean).join(" · ");
}

function normalizeRateLimitReset(resetAt) {
  const value = Number(resetAt);
  if (!Number.isFinite(value) || value <= 0) return null;
  return value < 1000000000000 ? value * 1000 : value;
}

function applyRateLimitQuota(key, rateLimit) {
  if (!key || !rateLimit) return false;

  const limit = Number(rateLimit.limit);
  const remaining = Number(rateLimit.remaining);
  const resetAt = normalizeRateLimitReset(rateLimit.resetAt);
  const hasLimit = Number.isFinite(limit) && limit >= 0;
  const hasRemaining = Number.isFinite(remaining) && remaining >= 0;
  if (!hasLimit && !hasRemaining && !resetAt) return false;

  const previous = apiKeyInfo[key] || {
    label: maskApiKey(key),
    status: "ok"
  };
  const previousFree = previous.freeModels || {};
  const nextFree = {
    ...previousFree,
    total: hasLimit ? limit : previousFree.total ?? null,
    remaining: hasRemaining ? remaining : previousFree.remaining ?? null,
    resetAt,
    source: "response-header",
    updatedAt: Date.now(),
    note: "Updated from OpenRouter X-RateLimit response headers."
  };

  apiKeyInfo[key] = {
    ...previous,
    label: previous.label || maskApiKey(key),
    status: previous.status === "error" ? "ok" : previous.status || "ok",
    checkedAt: previous.checkedAt || Date.now(),
    freeModels: nextFree
  };
  writeStoredApiKeyInfo();

  if (hasRemaining && remaining <= 0) {
    markApiKeyDailyLimited(key, resetAt || nextBeijing8ResetAt());
  }

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

function incrementModelUsage(key) {
  const info = ensureApiKeyInfo(key);
  if (!info) return;
  const latestResetAt = latestBeijing8ResetAt();
  const previous = info.modelUsage || {};
  const previousConsumed = Number(previous.resetAt || 0) >= latestResetAt ? Number(previous.consumed || 0) : 0;
  info.modelUsage = {
    consumed: Math.max(0, previousConsumed) + 1,
    resetAt: latestResetAt,
    updatedAt: Date.now()
  };
  writeStoredApiKeyInfo();
}

function recordChargedKeyUse(key, rateLimit) {
  incrementModelUsage(key);
  if (!applyRateLimitQuota(key, rateLimit)) decrementEstimatedRemaining(key);
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
  persistAppSettings();
}

function currentAppSettings() {
  return {
    chatModel: chatModelSelect.value || appSettings.chatModel || DEFAULT_TEXT_MODEL,
    imageModel: imageModelSelect.value || appSettings.imageModel || DEFAULT_IMAGE_MODEL,
    count: countInput.value || "4",
    concurrency: concurrencyInput.value || "3",
    queueMode: queueModeInput.checked,
    retryMax: retryMaxInput.value || "3",
    retryDelaySeconds: retryDelaySecondsInput.value || "70",
    imageSize: imageSizeInput.value || "auto",
    aspectRatio: aspectRatioInput.value || "auto"
  };
}

function persistAppSettings() {
  appSettings = currentAppSettings();
  writeStoredAppSettings();
  renderLocalDataSummary();
}

function applyAppSettings() {
  chatModelSelect.value = appSettings.chatModel || DEFAULT_TEXT_MODEL;
  imageModelSelect.value = appSettings.imageModel || DEFAULT_IMAGE_MODEL;
  countInput.value = appSettings.count || "4";
  concurrencyInput.value = appSettings.concurrency || "3";
  queueModeInput.checked = appSettings.queueMode === true;
  retryMaxInput.value = appSettings.retryMax || "3";
  retryDelaySecondsInput.value = appSettings.retryDelaySeconds || "70";
  imageSizeInput.value = appSettings.imageSize || "auto";
  aspectRatioInput.value = appSettings.aspectRatio || "auto";
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
  const storedValue = select === chatModelSelect ? appSettings.chatModel : select === imageModelSelect ? appSettings.imageModel : "";
  const previous = select.value || storedValue || fallbackId;
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

function modelStatusLabel(status) {
  const labels = {
    ok: "可用",
    unknown: "未知",
    seeded: "默认种子",
    "rate-limited": "额度限制",
    error: "错误",
    "no-text": "无文本返回",
    "no-image": "无图片返回",
    "provider-timeout": "服务超时"
  };
  return labels[status] || status || "未知";
}

function modelMatchesFilters(model) {
  const query = (modelSearchInput.value || "").trim().toLowerCase();
  const status = modelStatusFilter.value || "all";
  const modelStatus = model.status || "unknown";

  if (status !== "all" && modelStatus !== status) return false;
  if (!query) return true;

  const haystack = [
    model.id,
    model.name,
    model.type,
    modelStatus,
    ...(model.inputModalities || []),
    ...(model.outputModalities || []),
    ...(model.supportedParameters || [])
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return haystack.includes(query);
}

function renderModelHealthStats(models) {
  modelHealthStats.innerHTML = "";
  const counts = models.reduce((acc, model) => {
    const status = model.status || "unknown";
    acc[status] = (acc[status] || 0) + 1;
    return acc;
  }, {});

  const statuses = Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (!statuses.length) {
    modelHealthStats.append(emptyModelState("还没有模型健康数据。"));
    return;
  }

  for (const [status, count] of statuses) {
    const item = document.createElement("span");
    item.className = `health-chip ${status}`;
    item.textContent = `${modelStatusLabel(status)} ${count}`;
    modelHealthStats.append(item);
  }
}

function selectModelForUse(model, target) {
  if (target === "chat") {
    chatModelSelect.value = model.id;
    persistAppSettings();
    showView("chatView");
    setState("已选择聊天模型", "idle");
    return;
  }

  imageModelSelect.value = model.id;
  persistAppSettings();
  showView("generateView");
  setState("已选择生图模型", "idle");
}

async function copyTextToClipboard(text) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Fall through to the textarea fallback for browsers that expose but deny clipboard writes.
    }
  }

  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.left = "-9999px";
  document.body.append(area);
  area.select();
  const copied = document.execCommand("copy");
  area.remove();
  if (!copied) throw new Error("Clipboard write failed.");
}

function selectElementText(element) {
  if (!element) return;
  const selection = window.getSelection?.();
  if (!selection) return;
  const range = document.createRange();
  range.selectNodeContents(element);
  selection.removeAllRanges();
  selection.addRange(range);
}

function flashButtonLabel(button, label) {
  const previous = button.textContent;
  button.textContent = label;
  button.disabled = true;
  setTimeout(() => {
    button.textContent = previous;
    button.disabled = false;
  }, 1200);
}

async function copyModelId(model, button, idElement) {
  try {
    await copyTextToClipboard(model.id);
    flashButtonLabel(button, "已复制");
  } catch (error) {
    selectElementText(idElement);
    flashButtonLabel(button, "已选中");
    setState("已选中模型 ID", "idle");
  }
}

function renderModelCard(model) {
  const div = document.createElement("div");
  div.className = `model-card ${model.status || "unknown"}`;
  const params = (model.supportedParameters || []).slice(0, 5).join(", ") || "default";
  const updated = model.updatedAt ? new Date(model.updatedAt).toLocaleString() : "未知";
  const typeLabel = model.type === "image" ? "生图" : model.type === "mixed" ? "混合" : "文本";
  div.innerHTML = `
    <div>
      <strong></strong>
      <code></code>
    </div>
    <span>${typeLabel} · ${modelStatusLabel(model.status)}</span>
    <small>参数：${params}</small>
    <small>更新：${updated}</small>
    ${model.lastError ? `<small class="model-error">${model.lastError}</small>` : ""}
  `;
  div.querySelector("strong").textContent = model.name || model.id;
  const idElement = div.querySelector("code");
  idElement.textContent = model.id;

  const actions = document.createElement("div");
  actions.className = "model-card-actions";
  const copyButton = document.createElement("button");
  copyButton.type = "button";
  copyButton.className = "secondary";
  copyButton.textContent = "复制 ID";
  copyButton.addEventListener("click", () => copyModelId(model, copyButton, idElement));
  actions.append(copyButton);

  if (model.type === "text" || model.type === "mixed") {
    const useChatButton = document.createElement("button");
    useChatButton.type = "button";
    useChatButton.className = "secondary";
    useChatButton.textContent = "用于聊天";
    useChatButton.addEventListener("click", () => selectModelForUse(model, "chat"));
    actions.append(useChatButton);
  }
  if (model.type === "image" || model.type === "mixed") {
    const useImageButton = document.createElement("button");
    useImageButton.type = "button";
    useImageButton.className = "secondary";
    useImageButton.textContent = "用于生图";
    useImageButton.addEventListener("click", () => selectModelForUse(model, "image"));
    actions.append(useImageButton);
  }
  if (actions.childElementCount) div.append(actions);

  return div;
}

function renderModelLists() {
  textModelList.innerHTML = "";
  imageModelList.innerHTML = "";

  const allModels = modelCache.models || [...(modelCache.text || []), ...(modelCache.image || [])];
  const textModels = (modelCache.text || []).filter(modelMatchesFilters);
  const imageModels = (modelCache.image || []).filter(modelMatchesFilters);
  renderModelHealthStats(allModels);

  for (const model of textModels) textModelList.append(renderModelCard(model));
  for (const model of imageModels) imageModelList.append(renderModelCard(model));

  if (!textModels.length) textModelList.append(emptyModelState("没有匹配的免费文本模型。"));
  if (!imageModels.length) imageModelList.append(emptyModelState("没有匹配的免费生图模型。"));

  const refreshed = modelCache.refreshedAt ? new Date(modelCache.refreshedAt).toLocaleString() : "尚未刷新";
  modelSummary.textContent = `${modelCache.text?.length || 0} 个文本 / ${modelCache.image?.length || 0} 个生图免费模型 · 当前显示 ${textModels.length + imageModels.length} 个 · 刷新时间 ${refreshed}${modelCache.error ? ` · ${modelCache.error}` : ""}`;
  renderModelSelectors();
}

function emptyModelState(text) {
  const div = document.createElement("div");
  div.className = "key-empty";
  div.textContent = text;
  return div;
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(2)} MB`;
}

function outputMatchesSearch(image) {
  const query = (outputSearchInput.value || "").trim().toLowerCase();
  if (!query) return true;

  const modified = image.modifiedAt ? new Date(image.modifiedAt).toLocaleString() : "";
  const haystack = [
    image.filename,
    image.mime,
    formatBytes(image.bytes),
    modified
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return haystack.includes(query);
}

function renderOutputGallery() {
  outputGallery.innerHTML = "";
  const visibleImages = outputImages.filter(outputMatchesSearch);
  outputSummary.textContent = `${outputImages.length} 张本地图片 · 当前显示 ${visibleImages.length} · outputs 目录 · 最近 200 张`;

  if (!visibleImages.length) {
    const message = outputImages.length
      ? "没有匹配的本地图片。"
      : "还没有本地图片。生图成功并保存后会出现在这里。";
    outputGallery.append(emptyModelState(message));
    return;
  }

  for (const image of visibleImages) {
    const card = document.createElement("article");
    card.className = "output-card";
    const modified = image.modifiedAt ? new Date(image.modifiedAt).toLocaleString() : "未知时间";
    card.innerHTML = `
      <a class="output-preview" target="_blank" rel="noreferrer"></a>
      <div>
        <strong></strong>
        <span>${modified} · ${formatBytes(image.bytes)}</span>
      </div>
      <div class="output-actions">
        <a class="download" target="_blank" rel="noreferrer">打开原图</a>
        <button type="button" class="secondary danger">删除</button>
      </div>
    `;
    const preview = card.querySelector(".output-preview");
    preview.href = image.url;
    preview.innerHTML = `<img alt="Saved output ${image.filename}" src="${image.url}" loading="lazy" />`;
    card.querySelector("strong").textContent = image.filename;
    card.querySelector(".download").href = image.url;
    card.querySelector("button").addEventListener("click", () => deleteOutputImage(image.filename));
    outputGallery.append(card);
  }
}

async function deleteOutputImage(filename) {
  if (!filename) return;
  if (!confirm(`删除本地图片 ${filename}？`)) return;

  outputSummary.textContent = `正在删除 ${filename}...`;
  try {
    const response = await fetch("/api/outputs/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || response.statusText);
    outputImages = outputImages.filter((image) => image.filename !== filename);
    renderOutputGallery();
  } catch (error) {
    outputSummary.textContent = error.message || "删除图片失败。";
  }
}

async function loadOutputs() {
  refreshOutputsButton.disabled = true;
  outputSummary.textContent = "正在读取本地 outputs 目录...";

  try {
    const response = await fetch("/api/outputs");
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || response.statusText);
    outputImages = Array.isArray(data.images) ? data.images : [];
  } catch (error) {
    outputSummary.textContent = error.message || "读取图片库失败";
    outputGallery.innerHTML = "";
    outputGallery.append(emptyModelState("读取图片库失败。"));
    return;
  } finally {
    refreshOutputsButton.disabled = false;
  }

  renderOutputGallery();
}

function activityStatusLabel(status) {
  const labels = {
    success: "成功",
    error: "失败",
    limited: "额度限制"
  };
  return labels[status] || status || "未知";
}

function activityTypeLabel(type) {
  return type === "image" ? "生图" : "聊天";
}

function filteredActivityLog() {
  const query = (activitySearchInput.value || "").trim().toLowerCase();
  const type = activityTypeFilter.value || "all";
  const status = activityStatusFilter.value || "all";
  return activityLog.filter((item) => {
    if (type !== "all" && item.type !== type) return false;
    if (status !== "all" && item.status !== status) return false;
    if (!query) return true;

    const haystack = [
      item.type,
      item.status,
      item.model,
      item.prompt,
      item.message,
      item.keyLabel,
      item.error,
      item.savedPath
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    if (!haystack.includes(query)) return false;
    return true;
  });
}

function renderActivityLog() {
  activityList.innerHTML = "";
  const visibleItems = filteredActivityLog();
  const successCount = activityLog.filter((item) => item.status === "success").length;
  const errorCount = activityLog.filter((item) => item.status === "error").length;
  const limitedCount = activityLog.filter((item) => item.status === "limited").length;
  activitySummary.textContent = `${activityLog.length} 条本地记录 · 成功 ${successCount} · 失败 ${errorCount} · 限流 ${limitedCount} · 当前显示 ${visibleItems.length}`;

  if (!visibleItems.length) {
    activityList.append(emptyModelState(activityLog.length ? "没有匹配的运行记录。" : "还没有运行记录。聊天或生图后会自动记录在这里。"));
    return;
  }

  for (const item of visibleItems) {
    const row = document.createElement("article");
    row.className = `activity-item ${item.status || "unknown"}`;
    const when = item.createdAt ? new Date(item.createdAt).toLocaleString() : "未知时间";
    const duration = Number.isFinite(item.durationMs) ? `${Math.round(item.durationMs / 1000)} 秒` : "";
    const savedPath = item.savedPath ? `<small>保存：${item.savedPath}</small>` : "";
    const keyLabel = item.keyLabel ? `<small>Key：${item.keyLabel}</small>` : "";
    row.innerHTML = `
      <div>
        <strong>${activityTypeLabel(item.type)} · ${activityStatusLabel(item.status)}</strong>
        <span>${when}${duration ? ` · ${duration}` : ""}</span>
      </div>
      <code></code>
      <p></p>
      ${keyLabel}
      ${savedPath}
      ${item.error ? `<small class="activity-error">${item.error}</small>` : ""}
    `;
    row.querySelector("code").textContent = item.model || "未知模型";
    row.querySelector("p").textContent = item.prompt || item.message || "";
    activityList.append(row);
  }
}

function exportActivityLog() {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  downloadJson(`openrouter-activity-${stamp}.json`, activityLog);
}

function exportFilteredActivityLog() {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const type = activityTypeFilter.value || "all";
  const status = activityStatusFilter.value || "all";
  const query = (activitySearchInput.value || "all").trim().replace(/[^\w.-]+/g, "-").slice(0, 40) || "all";
  downloadJson(`openrouter-activity-${type}-${status}-${query}-${stamp}.json`, filteredActivityLog());
}

function backupValueForKey(key) {
  if (key === APP_SETTINGS_KEY) return currentAppSettings();
  if (key === TEMPLATE_KEY) return readTemplates();
  if (key === MODEL_CACHE_KEY) return modelCache;
  if (key === CHAT_MESSAGES_KEY) return chatMessages.slice(-40);
  if (key === ACTIVITY_LOG_KEY) return activityLog.slice(0, MAX_ACTIVITY_ITEMS);
  return readJsonStorage(key, null);
}

function buildLocalBackup() {
  const data = {};
  for (const item of LOCAL_BACKUP_ITEMS) {
    data[item.key] = backupValueForKey(item.key);
  }

  return {
    app: "openrouter-freemodels-gateway",
    version: LOCAL_BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    includesApiKeys: false,
    data
  };
}

function exportLocalData() {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  downloadJson(`openrouter-local-data-${stamp}.json`, buildLocalBackup());
  localDataStatus.textContent = "已导出本地数据备份，文件不包含 API key。";
}

function validBackupValue(key, value) {
  if (key === APP_SETTINGS_KEY) return isPlainObject(value);
  if (key === TEMPLATE_KEY) return isPlainObject(value);
  if (key === MODEL_CACHE_KEY) return isPlainObject(value) && (Array.isArray(value.text) || Array.isArray(value.image) || Array.isArray(value.models));
  if (key === CHAT_MESSAGES_KEY) return Array.isArray(value);
  if (key === ACTIVITY_LOG_KEY) return Array.isArray(value);
  return false;
}

function reloadLocalBackupState() {
  appSettings = readStoredAppSettings();
  modelCache = readStoredModelCache();
  chatMessages = readStoredChatMessages();
  activityLog = readStoredActivityLog();
  applyAppSettings();
  refreshTemplates();
  renderModelLists();
  renderChatMessages();
  renderActivityLog();
  renderLocalDataSummary();
}

function importLocalBackupText(text) {
  const parsed = JSON.parse(text);
  const data = isPlainObject(parsed?.data) ? parsed.data : parsed;
  if (!isPlainObject(data)) throw new Error("备份文件格式不正确。");

  const imported = [];
  const skipped = [];
  for (const item of LOCAL_BACKUP_ITEMS) {
    if (!Object.prototype.hasOwnProperty.call(data, item.key)) continue;
    const value = data[item.key];
    if (!validBackupValue(item.key, value)) {
      skipped.push(item.label);
      continue;
    }
    writeJsonStorage(item.key, value);
    imported.push(item.label);
  }

  if (!imported.length) throw new Error("备份文件里没有可导入的本地数据。");
  reloadLocalBackupState();
  return { imported, skipped };
}

async function importLocalDataFromFile() {
  const file = localDataImportInput.files?.[0];
  if (!file) return;

  try {
    const result = importLocalBackupText(await file.text());
    localDataStatus.textContent = `已导入：${result.imported.join("、")}${result.skipped.length ? `；已跳过：${result.skipped.join("、")}` : ""}。`;
    setState("本地数据已导入", "idle");
  } catch (error) {
    localDataStatus.textContent = error.message || "导入失败。";
    setState("导入失败", "error");
  } finally {
    localDataImportInput.value = "";
  }
}

function renderLocalDataSummary() {
  const templates = Object.keys(readTemplates()).length;
  const modelCount = (modelCache.text?.length || 0) + (modelCache.image?.length || 0);
  localDataSummary.textContent = `${templates} 个模板 · ${modelCount} 个模型缓存 · ${chatMessages.length} 条聊天 · ${activityLog.length} 条运行记录 · 当前设置已保存 · 不包含 API key`;
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
    <span>已消耗</span>
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
      <span>${remainingQuotaForKey(key)}<small>${quotaMetaForKey(key)}</small></span>
      <span>${modelUsageForKey(key)}</span>
      <strong>${item.status}</strong>
      ${
        item.removable
          ? `<div class="key-actions">
              ${item.status === "daily-limited" ? '<button type="button" data-action="unlock">解除限流</button>' : ""}
              <button type="button" data-action="remove" aria-label="移除 API key">移除</button>
            </div>`
          : ""
      }
    `;
    const unlockButton = row.querySelector('[data-action="unlock"]');
    unlockButton?.addEventListener("click", () => unlockApiKeyLimit(key));
    const removeButton = row.querySelector('[data-action="remove"]');
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

function stopActiveChat() {
  if (!activeChat || !activeChatController) return;
  stopChatRequested = true;
  stopChatButton.disabled = true;
  setState("正在停止", "running");
  activeChatController.abort();
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
  stopChatButton.disabled = false;
  stopChatRequested = false;
  activeChatController = new AbortController();
  setState("聊天中", "running");
  const startedAt = Date.now();
  const selectedModel = chatModelSelect.value || DEFAULT_TEXT_MODEL;

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: activeChatController.signal,
      body: JSON.stringify({
        model: selectedModel,
        apiKeys: chatKeys,
        messages: chatMessages.slice(-20),
        retryMax: retryMaxInput.value,
        retryDelaySeconds: retryDelaySecondsInput.value
      })
    });
    const data = await response.json();
    if (!response.ok) throw Object.assign(new Error(data.error || response.statusText), { data });

    applyServerKeyStatuses(data.apiKeys);
    if (Number.isInteger(data.key?.id)) {
      const key = chatKeys[data.key.id];
      recordChargedKeyUse(key, data.rateLimit);
    }
    chatMessages.push(data.message);
    writeStoredChatMessages();
    renderChatMessages();
    addActivity({
      type: "chat",
      status: "success",
      model: data.model || selectedModel,
      message: clipText(content),
      keyLabel: data.key?.label || "",
      durationMs: Date.now() - startedAt
    });
    renderApiKeys();
    setState("就绪", "idle");
  } catch (error) {
    if (stopChatRequested || error.name === "AbortError") {
      chatMessages.push({ role: "assistant", content: "已停止生成。" });
      writeStoredChatMessages();
      renderChatMessages();
      addActivity({
        type: "chat",
        status: "error",
        model: selectedModel,
        message: clipText(content),
        durationMs: Date.now() - startedAt,
        error: "用户停止生成"
      });
      setState("已停止", "idle");
      return;
    }

    applyServerKeyStatuses(error.data?.apiKeys || []);
    if (Number.isInteger(error.data?.key?.id)) {
      const key = chatKeys[error.data.key.id];
      if (error.data?.charged) recordChargedKeyUse(key, error.data?.rateLimit);
      else applyRateLimitQuota(key, error.data?.rateLimit);
    }
    chatMessages.push({ role: "assistant", content: `错误：${error.message}` });
    writeStoredChatMessages();
    renderChatMessages();
    addActivity({
      type: "chat",
      status: error.data?.apiKeys?.some((key) => key.status === "daily-limited") ? "limited" : "error",
      model: selectedModel,
      message: clipText(content),
      keyLabel: error.data?.key?.label || "",
      durationMs: Date.now() - startedAt,
      error: String(error.message || error).slice(0, 240)
    });
    renderApiKeys();
    setState("错误", "error");
  } finally {
    activeChat = false;
    activeChatController = null;
    stopChatRequested = false;
    sendChatButton.disabled = false;
    stopChatButton.disabled = true;
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

function markRunningCardsStopped() {
  for (const [index, card] of cards.entries()) {
    if (!taskTimers.has(index)) continue;
    stopTaskTimer(index);
    card.querySelector(".preview").innerHTML = `<div class="error-text">已停止</div>`;
    setCardStatus(index, "已停止");
    appendCardNote(index, "任务已由用户手动停止。");
  }
}

function stopActiveRun() {
  if (!activeRun || !activeRunController) return;
  stopRequested = true;
  stopRunButton.disabled = true;
  progressText.textContent = "正在停止批量任务...";
  setState("正在停止", "running");
  activeRunController.abort();
  markRunningCardsStopped();
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
  applyRateLimitQuota(key, event.rateLimit);
  if (event.key?.status === "daily-limited") {
    markApiKeyDailyLimited(key, normalizeRateLimitReset(event.rateLimit?.resetAt) || nextBeijing8ResetAt());
    const free = freeInfoForKey(key);
    if (free) {
      free.remaining = 0;
      apiKeyInfo[key].freeModels = free;
      writeStoredApiKeyInfo();
    }
  }
  renderApiKeys(event.apiKeys);
  appendCardNote(event.index, `${event.key?.label || "API key"} 已达到额度限制，已跳过。`);
  addActivity({
    type: "image",
    status: "limited",
    model: imageModelSelect.value || DEFAULT_IMAGE_MODEL,
    prompt: clipText(event.prompt),
    keyLabel: event.key?.label || "",
    error: "API key 已达到额度限制"
  });
}

async function refreshQuota() {
  absorbPendingApiKeys();
  refreshDailyKeyState();

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
        const previousUsage = apiKeyInfo[key]?.modelUsage || null;
        const nextInfo = { ...item, checkedAt: Date.now() };
        if (previousUsage) nextInfo.modelUsage = previousUsage;
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
  recordChargedKeyUse(key, event.rateLimit);
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

  addActivity({
    type: "image",
    status: "success",
    model: event.model || imageModelSelect.value || DEFAULT_IMAGE_MODEL,
    prompt: clipText(event.prompt),
    keyLabel: event.key?.label || "",
    durationMs: event.durationMs,
    savedPath: saved?.filename ? `outputs/${saved.filename}` : ""
  });

  const link = document.createElement("a");
  link.className = "download";
  link.href = imageUrl;
  link.target = "_blank";
  link.rel = "noreferrer";
  link.textContent = "打开图片";
  card.querySelector(".card-body").append(link);

  if (document.querySelector("#outputGalleryView")?.classList.contains("active")) loadOutputs();
}

function markError(event) {
  const card = cards.get(event.index);
  if (!card) return;
  stopTaskTimer(event.index);

  if (Number.isInteger(event.key?.id)) {
    const key = currentBatchKeys[event.key.id];
    if (event.charged) recordChargedKeyUse(key, event.rateLimit);
    else applyRateLimitQuota(key, event.rateLimit);
    renderApiKeys();
  }

  card.querySelector(".preview").innerHTML = `<div class="error-text">请求失败</div>`;
  card.querySelector(".meta span:last-child").textContent = `${Math.round(event.durationMs / 1000)}s`;
  const error = document.createElement("div");
  error.className = "error-text";
  error.textContent = event.error;
  card.querySelector(".card-body").append(error);
  addActivity({
    type: "image",
    status: "error",
    model: imageModelSelect.value || DEFAULT_IMAGE_MODEL,
    prompt: clipText(event.prompt),
    keyLabel: event.key?.label || "",
    durationMs: event.durationMs,
    error: String(event.error || "请求失败").slice(0, 240)
  });
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
  stopRequested = false;
  activeRunController = new AbortController();
  runButton.disabled = true;
  stopRunButton.disabled = false;
  setState("运行中", "running");

  try {
    const response = await fetch("/api/batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: activeRunController.signal,
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

    if (stopRequested) {
      setState("已停止", "idle");
      progressText.textContent = "批量任务已停止";
      markRunningCardsStopped();
    } else {
      setState("就绪", "idle");
    }
    loadModels();
  } catch (error) {
    if (stopRequested || error.name === "AbortError") {
      setState("已停止", "idle");
      progressText.textContent = "批量任务已停止";
      markRunningCardsStopped();
    } else {
      setState("错误", "error");
      progressText.textContent = error.message;
    }
  } finally {
    activeRun = false;
    activeRunController = null;
    stopRequested = false;
    runButton.disabled = false;
    stopRunButton.disabled = true;
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

  if (viewId === "localDataView") renderLocalDataSummary();
  if (viewId === "outputGalleryView") loadOutputs();
}

sendChatButton.addEventListener("click", sendChat);
stopChatButton.addEventListener("click", stopActiveChat);
chatInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    sendChat();
  }
});
clearChatButton.addEventListener("click", () => {
  if (activeChat) stopActiveChat();
  chatMessages = [];
  writeStoredChatMessages();
  renderChatMessages();
});
refreshModelsFromChatButton.addEventListener("click", refreshModels);
runButton.addEventListener("click", runBatch);
stopRunButton.addEventListener("click", stopActiveRun);
clearButton.addEventListener("click", () => {
  if (activeRun) stopActiveRun();
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

chatModelSelect.addEventListener("change", persistAppSettings);
imageModelSelect.addEventListener("change", persistAppSettings);
for (const input of [countInput, concurrencyInput, retryMaxInput, retryDelaySecondsInput]) {
  input.addEventListener("input", persistAppSettings);
  input.addEventListener("change", persistAppSettings);
}
for (const input of [imageSizeInput, aspectRatioInput]) {
  input.addEventListener("change", persistAppSettings);
}
queueModeInput.addEventListener("change", () => {
  syncQueueControls();
  persistAppSettings();
});
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
modelSearchInput.addEventListener("input", renderModelLists);
modelStatusFilter.addEventListener("change", renderModelLists);
outputSearchInput.addEventListener("input", renderOutputGallery);
refreshOutputsButton.addEventListener("click", loadOutputs);
activitySearchInput.addEventListener("input", renderActivityLog);
activityTypeFilter.addEventListener("change", renderActivityLog);
activityStatusFilter.addEventListener("change", renderActivityLog);
exportActivityButton.addEventListener("click", exportActivityLog);
exportFilteredActivityButton.addEventListener("click", exportFilteredActivityLog);
clearActivityButton.addEventListener("click", () => {
  activityLog = [];
  writeStoredActivityLog();
  renderActivityLog();
  renderLocalDataSummary();
});
exportLocalDataButton.addEventListener("click", exportLocalData);
importLocalDataButton.addEventListener("click", () => localDataImportInput.click());
localDataImportInput.addEventListener("change", importLocalDataFromFile);

refreshTemplates();
applyAppSettings();
renderModelLists();
renderChatMessages();
renderApiKeys();
renderActivityLog();
renderLocalDataSummary();
updateProgress();
loadModels();

setInterval(() => {
  if (refreshDailyKeyState()) renderApiKeys();
}, 60 * 1000);
