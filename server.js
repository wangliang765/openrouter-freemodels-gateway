import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { mkdir, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

function loadLocalEnv() {
  try {
    const raw = readFileSync(join(process.cwd(), ".env"), "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const separator = trimmed.indexOf("=");
      if (separator === -1) continue;

      const key = trimmed.slice(0, separator).trim();
      const value = trimmed.slice(separator + 1).trim().replace(/^["']|["']$/g, "");
      if (key && process.env[key] === undefined) process.env[key] = value;
    }
  } catch {
    // A local .env file is optional and is not used for API key fallback.
  }
}

loadLocalEnv();

const PORT = Number(process.env.PORT || 3000);
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const PUBLIC_DIR = join(process.cwd(), "public");
const OUTPUT_DIR = join(process.cwd(), "outputs");
const DATA_DIR = join(process.cwd(), "data");
const MODEL_CACHE_FILE = join(DATA_DIR, "model-cache.json");
const SERVICE_KEYS_FILE = join(DATA_DIR, "service-api-keys.json");
const OPENROUTER_KEYS_FILE = join(DATA_DIR, "openrouter-api-keys.json");
const CURL_COMMAND = process.platform === "win32" ? "curl.exe" : "curl";

const DEFAULT_IMAGE_MODEL = "sourceful/riverflow-v2.5-pro:free";
const DEFAULT_TEXT_MODEL = "nvidia/nemotron-3-ultra-550b-a55b:free";
const MAX_BATCH_REQUESTS = 200;
const BATCH_STREAM_HEARTBEAT_MS = 15000;
const DEFAULT_SERVICE_KEY_CONCURRENCY = clamp(process.env.DEFAULT_SERVICE_KEY_CONCURRENCY || 4, 1, 50);
const DEFAULT_OPENAI_IMAGE_N = clamp(process.env.DEFAULT_IMAGE_N || 20, 1, MAX_BATCH_REQUESTS);
const MAX_OPENAI_IMAGE_N = Math.max(
  DEFAULT_OPENAI_IMAGE_N,
  clamp(process.env.MAX_IMAGE_N || DEFAULT_OPENAI_IMAGE_N, 1, MAX_BATCH_REQUESTS)
);
const MODEL_AUDIT_HOUR_BEIJING = clamp(process.env.MODEL_AUDIT_HOUR_BEIJING || 8, 0, 23);
const MODEL_AUDIT_MINUTE_BEIJING = clamp(process.env.MODEL_AUDIT_MINUTE_BEIJING || 5, 0, 59);
const MODEL_AUDIT_MAX_PROBES = clamp(process.env.MODEL_AUDIT_MAX_PROBES || 12, 0, 200);
const OUTPUT_IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const PACKAGE_INFO = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml"
};

let modelCache = readStoredModelCache();
let serviceApiKeys = readStoredServiceApiKeys();
let openRouterApiKeys = readStoredOpenRouterApiKeys();
let modelCacheWriteTimer = null;

function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  return JSON.parse(raw);
}

function clamp(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.max(min, Math.min(max, Math.trunc(number)));
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Request aborted."));
      return;
    }

    const timeout = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        reject(new Error("Request aborted."));
      },
      { once: true }
    );
  });
}

function parseJsonResponse(text) {
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { raw: text };
  }
}

function buildPrompts({ prompt, promptList, count, maxCount = MAX_BATCH_REQUESTS }) {
  const parsedList = String(promptList || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (parsedList.length) return parsedList.slice(0, maxCount);

  const base = String(prompt || "").trim();
  if (!base) return [];
  return Array.from({ length: count }, (_, index) =>
    count === 1 ? base : `${base}\n\nVariation ${index + 1}: create a distinct composition.`
  );
}

function maskApiKey(key) {
  if (!key) return "empty";
  if (key.length <= 14) return `${key.slice(0, 4)}...${key.slice(-4)}`;
  return `${key.slice(0, 10)}...${key.slice(-6)}`;
}

function parseApiKeys(body) {
  if (!body || (!Array.isArray(body.apiKeys) && !body.apiKey)) return configuredOpenRouterApiKeys();
  const sourceKeys = Array.isArray(body.apiKeys)
    ? body.apiKeys
    : String(body.apiKey || "")
        .split(/[\r\n,;]+/)
        .map((key) => key.trim());

  return [...new Set(sourceKeys.map((key) => key.trim()).filter(Boolean))];
}

function parseDelimitedSecrets(...sources) {
  return [
    ...new Set(
      sources
        .flatMap((source) => String(source || "").split(/[\r\n,;]+/))
        .map((value) => value.trim())
        .filter(Boolean)
    )
  ];
}

function normalizeOpenRouterApiKeyRecord(item) {
  const key = typeof item === "string" ? item.trim() : String(item?.key || "").trim();
  if (!key) return null;
  return {
    id: typeof item === "string" ? randomUUID() : String(item.id || randomUUID()),
    key,
    label: maskApiKey(key),
    source: typeof item === "string" ? "stored" : String(item.source || "stored"),
    createdAt: typeof item === "string" ? Date.now() : Number(item.createdAt || Date.now()),
    status: typeof item === "string" ? "unknown" : String(item.status || "unknown"),
    lastOkAt: typeof item === "string" ? null : item.lastOkAt || null,
    lastError: typeof item === "string" ? "" : String(item.lastError || ""),
    lastErrorAt: typeof item === "string" ? null : item.lastErrorAt || null,
    cooldownUntil: typeof item === "string" ? null : item.cooldownUntil || null,
    dailyLimitedUntil: typeof item === "string" ? null : item.dailyLimitedUntil || null
  };
}

function readStoredOpenRouterApiKeys() {
  try {
    const raw = JSON.parse(readFileSync(OPENROUTER_KEYS_FILE, "utf8"));
    const items = Array.isArray(raw?.keys) ? raw.keys : Array.isArray(raw) ? raw : [];
    const seen = new Set();
    return items
      .map(normalizeOpenRouterApiKeyRecord)
      .filter((item) => {
        if (!item || seen.has(item.key)) return false;
        seen.add(item.key);
        return true;
      });
  } catch {
    return [];
  }
}

async function persistOpenRouterApiKeys() {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(OPENROUTER_KEYS_FILE, `${JSON.stringify({ keys: openRouterApiKeys }, null, 2)}\n`, "utf8");
}

function nextBeijing8ResetAt(now = new Date()) {
  const beijingNow = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const reset = new Date(Date.UTC(beijingNow.getUTCFullYear(), beijingNow.getUTCMonth(), beijingNow.getUTCDate(), 8, 0, 0, 0));
  if (beijingNow.getUTCHours() >= 8) reset.setUTCDate(reset.getUTCDate() + 1);
  return reset.getTime() - 8 * 60 * 60 * 1000;
}

function normalizeResetTimestamp(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  return number < 1e12 ? number * 1000 : number;
}

function resetExpiredOpenRouterKeyLimits() {
  const now = Date.now();
  let changed = false;
  for (const item of openRouterApiKeys) {
    if (item.status === "daily-limited" && Number(item.dailyLimitedUntil || 0) <= now) {
      item.status = "unknown";
      item.dailyLimitedUntil = null;
      item.lastError = "";
      item.lastErrorAt = null;
      changed = true;
    }
    if ((item.status === "rate-limited" || item.status === "provider-timeout") && Number(item.cooldownUntil || 0) <= now) {
      item.status = "unknown";
      item.cooldownUntil = null;
      item.lastError = "";
      item.lastErrorAt = null;
      changed = true;
    }
  }
  if (changed) persistOpenRouterApiKeys().catch((error) => console.warn(`Could not persist OpenRouter key reset: ${error.message}`));
}

function clearTransientOpenRouterKeyLimits() {
  let changed = false;
  for (const item of openRouterApiKeys) {
    if (item.status !== "rate-limited" && item.status !== "provider-timeout") continue;
    item.status = "unknown";
    item.cooldownUntil = null;
    item.lastError = "";
    item.lastErrorAt = null;
    changed = true;
  }
  if (changed) persistOpenRouterApiKeys().catch((error) => console.warn(`Could not persist OpenRouter key reset: ${error.message}`));
  return changed;
}

function allOpenRouterKeyRecords() {
  resetExpiredOpenRouterKeyLimits();
  const envKeys = parseDelimitedSecrets(process.env.OPENROUTER_API_KEYS, process.env.OPENROUTER_API_KEY).map((key, index) => ({
    id: `env-openrouter-key-${index + 1}`,
    key,
    label: maskApiKey(key),
    source: "env",
    createdAt: null,
    status: "env"
  }));
  const seen = new Set();
  const records = [...envKeys, ...openRouterApiKeys].filter((item) => {
    if (!item?.key || seen.has(item.key)) return false;
    seen.add(item.key);
    return true;
  });
  return records.sort((a, b) => Number(b.lastOkAt || 0) - Number(a.lastOkAt || 0));
}

function configuredOpenRouterKeyRecords() {
  const now = Date.now();
  const records = allOpenRouterKeyRecords();
  const notDailyLimited = records.filter((item) => item.status !== "daily-limited" || Number(item.dailyLimitedUntil || 0) <= now);
  const usable = notDailyLimited.filter((item) => !item.cooldownUntil || Number(item.cooldownUntil) <= now);
  const source = usable.length ? usable : notDailyLimited;
  return source.sort((a, b) => {
    const score = (item) => (item.status === "ok" ? 4 : item.source === "env" ? 3 : item.status === "provider-timeout" ? 0 : item.status === "daily-limited" ? -1 : 1);
    return score(b) - score(a) || Number(b.lastOkAt || 0) - Number(a.lastOkAt || 0);
  });
}

function configuredOpenRouterApiKeys() {
  return configuredOpenRouterKeyRecords().map((item) => item.key);
}

function updateOpenRouterKeyHealth(apiKey, status, error = "", options = {}) {
  const record = openRouterApiKeys.find((item) => item.key === apiKey);
  if (!record) return;
  if (status === "rate-limited" && options.scope !== "key") return;
  record.status = status;
  if (status === "ok") {
    record.lastOkAt = Date.now();
    record.lastError = "";
    record.lastErrorAt = null;
    record.cooldownUntil = null;
    record.dailyLimitedUntil = null;
  } else if (status === "daily-limited") {
    record.lastError = String(error || "").slice(0, 240);
    record.lastErrorAt = Date.now();
    record.cooldownUntil = null;
    record.dailyLimitedUntil = normalizeResetTimestamp(options.resetAt) || nextBeijing8ResetAt();
  } else {
    record.lastError = String(error || "").slice(0, 240);
    record.lastErrorAt = Date.now();
    if (status === "provider-timeout") record.cooldownUntil = Date.now() + 30 * 60 * 1000;
    if (status === "rate-limited") record.cooldownUntil = normalizeResetTimestamp(options.resetAt) || Date.now() + 60 * 1000;
  }
  persistOpenRouterApiKeys().catch((persistError) => {
    console.warn(`Could not persist OpenRouter key health: ${persistError.message}`);
  });
}

function configuredServiceApiKeys() {
  const envKeys = parseDelimitedSecrets(process.env.GATEWAY_API_KEYS, process.env.GATEWAY_API_KEY).map((key, index) => ({
    id: `env-service-key-${index + 1}`,
    key,
    name: `环境变量 Key ${index + 1}`,
    concurrency: DEFAULT_SERVICE_KEY_CONCURRENCY,
    defaultImageN: DEFAULT_OPENAI_IMAGE_N,
    maxImageN: MAX_OPENAI_IMAGE_N,
    enabled: true,
    source: "env"
  }));

  return [...envKeys, ...serviceApiKeys].map((item) => ({
    ...item,
    label: maskApiKey(item.key),
    concurrency: clamp(item.concurrency || DEFAULT_SERVICE_KEY_CONCURRENCY, 1, 50),
    defaultImageN: clamp(item.defaultImageN || DEFAULT_OPENAI_IMAGE_N, 1, MAX_BATCH_REQUESTS),
    maxImageN: Math.max(
      clamp(item.defaultImageN || DEFAULT_OPENAI_IMAGE_N, 1, MAX_BATCH_REQUESTS),
      clamp(item.maxImageN || MAX_OPENAI_IMAGE_N, 1, MAX_BATCH_REQUESTS)
    ),
    enabled: item.enabled !== false
  }));
}

function normalizeServiceApiKeyRecord(item) {
  const key = String(item?.key || "").trim();
  if (!key) return null;
  const defaultImageN = clamp(item.defaultImageN || DEFAULT_OPENAI_IMAGE_N, 1, MAX_BATCH_REQUESTS);
  return {
    id: String(item.id || randomUUID()),
    name: String(item.name || "服务 API Key").trim().slice(0, 80) || "服务 API Key",
    key,
    enabled: item.enabled !== false,
    concurrency: clamp(item.concurrency || DEFAULT_SERVICE_KEY_CONCURRENCY, 1, 50),
    defaultImageN,
    maxImageN: Math.max(defaultImageN, clamp(item.maxImageN || MAX_OPENAI_IMAGE_N, 1, MAX_BATCH_REQUESTS)),
    createdAt: Number(item.createdAt || Date.now()),
    updatedAt: Number(item.updatedAt || Date.now()),
    source: "stored"
  };
}

function readStoredServiceApiKeys() {
  try {
    const raw = JSON.parse(readFileSync(SERVICE_KEYS_FILE, "utf8"));
    const items = Array.isArray(raw?.keys) ? raw.keys : Array.isArray(raw) ? raw : [];
    return items.map(normalizeServiceApiKeyRecord).filter(Boolean);
  } catch {
    return [];
  }
}

async function persistServiceApiKeys() {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(SERVICE_KEYS_FILE, `${JSON.stringify({ keys: serviceApiKeys }, null, 2)}\n`, "utf8");
}

function publicServiceKeyRecord(item, includeSecret = false) {
  const payload = {
    id: item.id,
    name: item.name,
    label: maskApiKey(item.key),
    enabled: item.enabled !== false,
    concurrency: item.concurrency,
    defaultImageN: item.defaultImageN,
    maxImageN: item.maxImageN,
    createdAt: item.createdAt || null,
    updatedAt: item.updatedAt || null,
    source: item.source || "stored"
  };
  if (includeSecret || item.source !== "env") payload.key = item.key;
  return payload;
}

function bearerToken(req) {
  const header = req.headers.authorization || "";
  const match = String(header).match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

function openAIErrorPayload(message, type = "invalid_request_error", param = null, code = null) {
  return { error: { message, type, param, code } };
}

function sendOpenAIError(res, status, message, options = {}) {
  sendJson(
    res,
    status,
    openAIErrorPayload(
      message,
      options.type || (status === 401 ? "authentication_error" : status === 429 ? "rate_limit_error" : "invalid_request_error"),
      options.param ?? null,
      options.code ?? null
    )
  );
}

function writeSseEvent(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function beginOpenAIChatStream(res, { id, created, model }) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no"
  });
  res.flushHeaders?.();
  res.socket?.setKeepAlive?.(true);

  const base = {
    id,
    object: "chat.completion.chunk",
    created,
    model
  };
  writeSseEvent(res, {
    ...base,
    choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }]
  });
  return base;
}

function writeOpenAIChatStreamResult(res, base, message, finishReason = "stop") {
  if (res.destroyed || res.writableEnded) return;

  if (typeof message.content === "string" && message.content) {
    writeSseEvent(res, {
      ...base,
      choices: [{ index: 0, delta: { content: message.content }, finish_reason: null }]
    });
  }

  if (Array.isArray(message.tool_calls)) {
    for (const [index, toolCall] of message.tool_calls.entries()) {
      writeSseEvent(res, {
        ...base,
        choices: [{ index: 0, delta: { tool_calls: [{ index, ...toolCall }] }, finish_reason: null }]
      });
    }
  }

  writeSseEvent(res, {
    ...base,
    choices: [{ index: 0, delta: {}, finish_reason: finishReason || "stop" }]
  });
  res.write("data: [DONE]\n\n");
  res.end();
}

function writeOpenAIChatStreamError(res, base, error) {
  if (res.destroyed || res.writableEnded) return;
  writeSseEvent(res, {
    ...base,
    choices: [
      {
        index: 0,
        delta: { content: "" },
        finish_reason: "stop"
      }
    ],
    error: openAIErrorPayload(error?.message || String(error), error?.openAIType || "server_error", null, error?.openAICode || "upstream_error").error
  });
  res.write("data: [DONE]\n\n");
  res.end();
}

function sendOpenAIChatStream(res, completion) {
  const base = beginOpenAIChatStream(res, {
    id: completion.id,
    created: completion.created,
    model: completion.model
  });
  writeOpenAIChatStreamResult(res, base, completion.choices?.[0]?.message || {}, completion.choices?.[0]?.finish_reason || "stop");
}

function authenticateServiceRequest(req, res) {
  const serviceKeys = configuredServiceApiKeys();
  if (!serviceKeys.length) {
    sendOpenAIError(res, 503, "Gateway API keys are not configured. Set GATEWAY_API_KEYS.", {
      type: "server_error",
      code: "gateway_api_keys_missing"
    });
    return null;
  }

  const token = bearerToken(req);
  const serviceKey = serviceKeys.find((item) => item.enabled && item.key === token);
  if (!serviceKey) {
    sendOpenAIError(res, 401, "Invalid or missing API key.", {
      type: "authentication_error",
      code: "invalid_api_key"
    });
    return null;
  }

  return serviceKey;
}

function resolveOpenAIModel(model, fallbackType) {
  const value = String(model || "").trim();
  if (!value) return fallbackType === "image" ? DEFAULT_IMAGE_MODEL : DEFAULT_TEXT_MODEL;
  if (value === "gpt-image-local") return DEFAULT_IMAGE_MODEL;
  if (value === "gpt-chat-local") return DEFAULT_TEXT_MODEL;
  return value;
}

function publicBaseUrl(req) {
  const configured = String(process.env.PUBLIC_BASE_URL || "").trim().replace(/\/+$/, "");
  if (configured) return configured;
  const protocol = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim() || "http";
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || `localhost:${PORT}`).split(",")[0].trim();
  return `${protocol}://${host}`;
}

function absolutePublicUrl(req, pathOrUrl) {
  const value = String(pathOrUrl || "");
  if (/^https?:\/\//i.test(value)) return value;
  return new URL(value, `${publicBaseUrl(req)}/`).toString();
}

function normalizeOpenAIMessageContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part?.type === "text") return part.text || "";
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function cleanOpenAIParam(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string" && ["", "[undefined]", "[null]", "undefined", "null"].includes(value.trim())) return undefined;
  return value;
}

function normalizeOpenAIMessages(messages) {
  if (!Array.isArray(messages)) return [];
  const allowedRoles = new Set(["system", "developer", "user", "assistant", "tool"]);
  return messages
    .map((message) => {
      const role = allowedRoles.has(message?.role) ? message.role : "user";
      const normalized = { role };
      if (message?.content !== undefined && message?.content !== null) normalized.content = message.content;
      else normalized.content = "";
      if (message?.name) normalized.name = String(message.name);
      if (message?.tool_call_id) normalized.tool_call_id = String(message.tool_call_id);
      if (Array.isArray(message?.tool_calls)) normalized.tool_calls = message.tool_calls;
      return normalized;
    })
    .filter((message) => {
      if (message.role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length) return true;
      if (message.role === "tool" && message.tool_call_id) return true;
      return normalizeOpenAIMessageContent(message.content);
    });
}

async function savedImageToB64Json(savedImage) {
  if (typeof savedImage?.original === "string") {
    const match = savedImage.original.match(/^data:image\/[a-z0-9.+-]+;base64,([\s\S]+)$/i);
    if (match) return match[1];
  }

  if (savedImage?.filename) {
    const filePath = join(OUTPUT_DIR, savedImage.filename);
    if (filePath.startsWith(OUTPUT_DIR)) {
      const bytes = await readFile(filePath);
      return bytes.toString("base64");
    }
  }

  return null;
}

function createKeyPool(apiKeys) {
  const keys = apiKeys.map((key, index) => ({
    id: index,
    key,
    label: maskApiKey(key),
    status: "active",
    error: ""
  }));
  let pointer = keys.length > 1 ? Math.floor(Math.random() * keys.length) : 0;

  function snapshot() {
    return keys.map(({ id, label, status, error }) => ({ id, label, status, error }));
  }

  function activeKeys() {
    return keys.filter((key) => key.status === "active");
  }

  function nextActiveKey() {
    if (!keys.length) {
      throw new Error("Missing API key. Add at least one key to the page key pool.");
    }

    for (let offset = 0; offset < keys.length; offset += 1) {
      const index = (pointer + offset) % keys.length;
      const key = keys[index];
      if (key.status === "active") {
        pointer = (index + 1) % keys.length;
        return key;
      }
    }

    throw new Error("All API keys are daily rate limited for free models.");
  }

  function markDailyLimited(keyEntry, error) {
    keyEntry.status = "daily-limited";
    keyEntry.error = error?.message || String(error);
  }

  function markRateLimited(keyEntry, error) {
    keyEntry.status = "rate-limited";
    keyEntry.error = error?.message || String(error);
  }

  function markError(keyEntry, error) {
    keyEntry.status = "error";
    keyEntry.error = error?.message || String(error);
  }

  function hasActiveKeys() {
    return activeKeys().length > 0;
  }

  return { activeKeys, hasActiveKeys, nextActiveKey, markDailyLimited, markRateLimited, markError, snapshot };
}

function createSeedModelCache() {
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
      source: "seed",
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
      source: "seed",
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
      source: "seed",
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

function rebuildModelGroups(cache) {
  const models = Array.isArray(cache?.models) ? cache.models.filter((model) => model && typeof model.id === "string") : [];
  return {
    ...cache,
    models,
    text: models.filter((model) => model.type === "text" || model.type === "mixed"),
    image: models.filter((model) => model.type === "image" || model.type === "mixed")
  };
}

function normalizeStoredModelCache(cache) {
  const seedCache = createSeedModelCache();
  if (!cache || !Array.isArray(cache.models)) return seedCache;

  const byId = new Map(seedCache.models.map((model) => [model.id, model]));
  for (const model of cache.models) {
    if (!model || typeof model.id !== "string" || !model.id.trim()) continue;
    const previous = byId.get(model.id);
    byId.set(model.id, {
      ...(previous || {}),
      ...model,
      id: model.id.trim(),
      status: model.status || previous?.status || "unknown",
      lastError: String(model.lastError || previous?.lastError || "").slice(0, 240),
      updatedAt: Number(model.updatedAt || previous?.updatedAt || Date.now())
    });
  }

  return rebuildModelGroups({
    models: [...byId.values()].sort((a, b) => a.id.localeCompare(b.id)),
    refreshedAt: Number(cache.refreshedAt || 0),
    lastAuditAt: Number(cache.lastAuditAt || 0),
    lastAuditSummary: cache.lastAuditSummary || null,
    source: cache.source || "disk",
    error: cache.error || ""
  });
}

function readStoredModelCache() {
  try {
    const raw = JSON.parse(readFileSync(MODEL_CACHE_FILE, "utf8"));
    return normalizeStoredModelCache(raw);
  } catch {
    return createSeedModelCache();
  }
}

async function persistModelCache() {
  const payload = JSON.stringify(modelCache, null, 2);
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(MODEL_CACHE_FILE, `${payload}\n`, "utf8");
}

function scheduleModelCachePersist() {
  if (modelCacheWriteTimer) return;
  modelCacheWriteTimer = setTimeout(() => {
    modelCacheWriteTimer = null;
    persistModelCache().catch((error) => {
      console.warn(`Could not persist model cache: ${error.message}`);
    });
  }, 250);
}

function numericPrice(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function isFreeOpenRouterModel(model) {
  if (String(model?.id || "").endsWith(":free")) return true;
  const pricing = model?.pricing || {};
  const values = Object.values(pricing).filter((value) => value !== null && value !== undefined);
  return values.length > 0 && values.every((value) => numericPrice(value) === 0);
}

function normalizeOpenRouterModel(model) {
  const id = String(model?.id || "").trim();
  if (!id || !isFreeOpenRouterModel(model)) return null;

  const architecture = model?.architecture || {};
  const outputModalities = Array.isArray(architecture.output_modalities) ? architecture.output_modalities : [];
  const inputModalities = Array.isArray(architecture.input_modalities) ? architecture.input_modalities : [];
  const supportedParameters = Array.isArray(model?.supported_parameters) ? model.supported_parameters : [];
  const hasImage = outputModalities.includes("image");
  const hasText = outputModalities.includes("text") || !outputModalities.length;
  const type = hasImage && hasText ? "mixed" : hasImage ? "image" : "text";

  if (!hasImage && !hasText) return null;

  return {
    id,
    name: model?.name || id,
    type,
    inputModalities: inputModalities.length ? inputModalities : ["text"],
    outputModalities: outputModalities.length ? outputModalities : ["text"],
    supportedParameters,
    pricing: model?.pricing || {},
    contextLength: model?.context_length || null,
    topProvider: model?.top_provider || null,
    status: "unknown",
    lastError: "",
    source: "openrouter",
    updatedAt: Date.now()
  };
}

function mergeModelLists(nextModels) {
  const currentById = new Map(modelCache.models.map((model) => [model.id, model]));
  const merged = new Map();

  for (const model of createSeedModelCache().models) {
    merged.set(model.id, { ...model, ...(currentById.get(model.id) || {}) });
  }

  for (const model of nextModels) {
    const previous = currentById.get(model.id);
    merged.set(model.id, {
      ...model,
      status: previous?.status || model.status,
      lastError: previous?.lastError || model.lastError,
      updatedAt: Date.now()
    });
  }

  const models = [...merged.values()].sort((a, b) => a.id.localeCompare(b.id));
  return {
    models,
    text: models.filter((model) => model.type === "text" || model.type === "mixed"),
    image: models.filter((model) => model.type === "image" || model.type === "mixed"),
    refreshedAt: Date.now(),
    source: "openrouter",
    error: ""
  };
}

function getModelInfo(modelId, fallbackType = "text") {
  const id = String(modelId || "").trim();
  return modelCache.models.find((model) => model.id === id) || {
    id: id || (fallbackType === "image" ? DEFAULT_IMAGE_MODEL : DEFAULT_TEXT_MODEL),
    name: id || (fallbackType === "image" ? DEFAULT_IMAGE_MODEL : DEFAULT_TEXT_MODEL),
    type: fallbackType,
    inputModalities: ["text"],
    outputModalities: fallbackType === "image" ? ["image"] : ["text"],
    supportedParameters: [],
    pricing: {},
    status: "unknown",
    lastError: "",
    source: "custom",
    updatedAt: Date.now()
  };
}

function updateModelHealth(modelId, status, error = "", fallbackType = "text") {
  const id = String(modelId || "").trim();
  if (!id) return;

  let model = modelCache.models.find((item) => item.id === id);
  if (!model) {
    model = {
      id,
      name: id,
      type: fallbackType,
      inputModalities: ["text"],
      outputModalities: fallbackType === "image" ? ["image"] : ["text"],
      supportedParameters: [],
      pricing: {},
      status: "unknown",
      lastError: "",
      source: "custom",
      updatedAt: Date.now()
    };
    modelCache.models.push(model);
  }

  model.status = status;
  model.lastError = String(error || "").slice(0, 240);
  model.updatedAt = Date.now();
  modelCache = rebuildModelGroups({ ...modelCache, models: modelCache.models });
  scheduleModelCachePersist();
}

function publicModelCache() {
  return {
    ...modelCache,
    counts: {
      all: modelCache.models.length,
      text: modelCache.text.length,
      image: modelCache.image.length
    }
  };
}

function clearTransientModelHealth() {
  let changed = false;
  const transientStatuses = new Set(["rate-limited", "provider-timeout"]);
  for (const model of modelCache.models || []) {
    if (!transientStatuses.has(model.status)) continue;
    model.status = "unknown";
    model.lastError = "";
    model.updatedAt = Date.now();
    changed = true;
  }
  if (changed) {
    modelCache = rebuildModelGroups({ ...modelCache, models: modelCache.models });
    scheduleModelCachePersist();
  }
  return changed;
}

function modelAuditCandidates(maxProbes = MODEL_AUDIT_MAX_PROBES) {
  if (maxProbes <= 0) return [];
  const textModels = (modelCache.text || []).filter((model) => model?.id);
  const priority = new Map();
  const add = (model, score) => {
    if (!model?.id) return;
    priority.set(model.id, Math.max(priority.get(model.id) || 0, score));
  };

  add(modelCache.models.find((model) => model.id === DEFAULT_TEXT_MODEL), 100);
  for (const model of textModels) {
    if (["rate-limited", "provider-timeout", "error", "no-text", "unknown", "seeded"].includes(model.status)) add(model, 80);
    else if (model.updatedAt && Date.now() - Number(model.updatedAt) > 24 * 60 * 60 * 1000) add(model, 20);
  }

  return textModels
    .filter((model) => priority.has(model.id))
    .sort((a, b) => (priority.get(b.id) || 0) - (priority.get(a.id) || 0) || a.id.localeCompare(b.id))
    .slice(0, maxProbes);
}

async function auditModelAvailability({ signal, maxProbes = MODEL_AUDIT_MAX_PROBES, refresh = true } = {}) {
  const startedAt = Date.now();
  clearTransientOpenRouterKeyLimits();
  clearTransientModelHealth();

  let refreshed = false;
  if (refresh) {
    await refreshOpenRouterModels(signal);
    refreshed = true;
  }

  const apiKeys = configuredOpenRouterApiKeys();
  const candidates = modelAuditCandidates(maxProbes);
  const results = [];

  if (apiKeys.length) {
    for (const model of candidates) {
      if (signal?.aborted) break;
      try {
        await runWithOpenRouterKeyPool({
          apiKeys,
          retryMax: 0,
          retryDelayMs: 5000,
          signal,
          action: (keyEntry) =>
            generateText({
              messages: [{ role: "user", content: "Reply with ok." }],
              options: { model: model.id, maxTokens: 8, temperature: 0 },
              apiKey: keyEntry.key,
              signal
            })
        });
        results.push({ id: model.id, status: "ok" });
      } catch (error) {
        const status = isRateLimitError(error) ? "rate-limited" : /empty unfinished response/i.test(error?.message || "") ? "provider-timeout" : "error";
        updateModelHealth(model.id, status, error?.message || String(error), "text");
        results.push({ id: model.id, status, error: error?.message || String(error) });
      }
    }
  }

  const summary = {
    refreshed,
    keyCount: apiKeys.length,
    probed: results.length,
    ok: results.filter((item) => item.status === "ok").length,
    limited: results.filter((item) => item.status === "rate-limited").length,
    failed: results.filter((item) => item.status !== "ok" && item.status !== "rate-limited").length,
    skipped: apiKeys.length ? 0 : candidates.length,
    durationMs: Date.now() - startedAt
  };
  modelCache.lastAuditAt = Date.now();
  modelCache.lastAuditSummary = summary;
  await persistModelCache();
  return { ...publicModelCache(), audit: { ...summary, results } };
}

function buildImageConfig({ aspectRatio, imageSize }) {
  const imageConfig = {};
  if (aspectRatio && aspectRatio !== "auto") imageConfig.aspect_ratio = aspectRatio;
  if (imageSize && imageSize !== "auto") imageConfig.image_size = imageSize;
  return Object.keys(imageConfig).length ? imageConfig : undefined;
}

function normalizeReferenceImages(source) {
  const items = Array.isArray(source) ? source : source ? [source] : [];
  return items
    .map((item) => (typeof item === "string" ? item : item?.url))
    .map((url) => String(url || "").trim())
    .filter((url) => /^data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+$/i.test(url) || /^https?:\/\/\S+$/i.test(url));
}

function modelSupportsParameter(modelInfo, parameter) {
  const supported = modelInfo?.supportedParameters || [];
  return !supported.length || supported.includes(parameter);
}

function extractImages(openRouterResponse) {
  const message = openRouterResponse?.choices?.[0]?.message;
  const images = Array.isArray(message?.images) ? message.images : [];
  const imageUrls = images
    .map((item) => item?.image_url?.url)
    .filter((url) => typeof url === "string" && url.length > 0);

  const content = typeof message?.content === "string" ? message.content : "";
  const fallbackUrls = content.match(/data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+|https?:\/\/\S+\.(?:png|jpe?g|webp)(?:\?\S*)?/gi) || [];

  return [...imageUrls, ...fallbackUrls];
}

async function saveDataImage(dataUrl, index) {
  const match = dataUrl.match(/^data:(image\/([a-z0-9.+-]+));base64,([\s\S]+)$/i);
  if (!match) return null;

  const mime = match[1].toLowerCase();
  const extension = match[2].toLowerCase().replace("jpeg", "jpg").replace(/[^a-z0-9]/g, "");
  const bytes = Buffer.from(match[3], "base64");
  const filename = `${new Date().toISOString().replace(/[:.]/g, "-")}-${index + 1}-${randomUUID()}.${extension}`;

  await mkdir(OUTPUT_DIR, { recursive: true });
  await writeFile(join(OUTPUT_DIR, filename), bytes);

  return {
    original: dataUrl,
    url: `/outputs/${filename}`,
    filename,
    mime,
    bytes: bytes.length
  };
}

async function saveImages(images) {
  const saved = [];
  for (const [index, image] of images.entries()) {
    const local = await saveDataImage(image, index);
    saved.push(local || { original: image, url: image, filename: null, mime: null, bytes: null });
  }
  return saved;
}

function isRateLimitError(error) {
  if (error?.statusCode === 429 || error?.upstreamStatus === 429) return true;
  if (Number(error?.upstreamErrorCode) === 429) return true;
  return String(error?.message || error).includes("OpenRouter 429:");
}

function isDailyRateLimitError(error) {
  return String(error?.message || error).includes("free-models-per-day");
}

function isProviderScopedRateLimitError(error) {
  if (!isRateLimitError(error) || isDailyRateLimitError(error)) return false;
  const metadata = error?.upstreamMetadata || {};
  return Boolean(metadata.provider_name || metadata.raw || /Provider returned error/i.test(error?.message || ""));
}

function isRetryableError(error) {
  const message = String(error?.message || error);
  if (isRateLimitError(error)) return false;
  if (/OpenRouter\s+(408|5\d\d):/.test(message)) return true;
  return /curl exited|timeout|timed out|ECONNRESET|terminated|socket|connection|network/i.test(message);
}

function isChargedOpenRouterError(error) {
  const message = String(error?.message || error);
  if (isRateLimitError(error) || isRetryableError(error)) return false;
  return message.includes("OpenRouter returned no image URLs");
}

function parseOpenRouterRateLimitHeaders(rawHeaders) {
  const blocks = String(rawHeaders || "")
    .split(/\r?\n\r?\n/)
    .map((block) => block.trim())
    .filter(Boolean);
  const latest = blocks.reverse().find((block) => /^HTTP\//i.test(block));
  if (!latest) return null;

  const headers = {};
  for (const line of latest.split(/\r?\n/).slice(1)) {
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    headers[line.slice(0, separator).trim().toLowerCase()] = line.slice(separator + 1).trim();
  }

  const limit = Number(headers["x-ratelimit-limit"]);
  const remaining = Number(headers["x-ratelimit-remaining"]);
  const resetAt = Number(headers["x-ratelimit-reset"]);
  if (!Number.isFinite(limit) && !Number.isFinite(remaining) && !Number.isFinite(resetAt)) return null;

  return {
    limit: Number.isFinite(limit) ? limit : null,
    remaining: Number.isFinite(remaining) ? remaining : null,
    resetAt: Number.isFinite(resetAt) ? resetAt : null
  };
}

function attachRateLimit(error, rateLimit) {
  if (rateLimit) error.rateLimit = rateLimit;
  return error;
}

function attachOpenRouterError(error, { status, data, text, rateLimit } = {}) {
  error.upstreamStatus = status;
  error.statusCode = Number(data?.error?.metadata?.code || data?.error?.code) === 429 ? 429 : status;
  error.upstreamErrorCode = data?.error?.metadata?.code || data?.error?.code || null;
  error.upstreamMetadata = data?.error?.metadata || null;
  error.upstreamBody = data || null;
  error.upstreamText = text || "";
  return attachRateLimit(error, rateLimit);
}

function freeDailyLimitForKeyInfo(data) {
  return data?.is_free_tier ? 50 : 1000;
}

async function requestOpenRouterModels(signal) {
  return await new Promise((resolve, reject) => {
    const child = spawn(
      CURL_COMMAND,
      [
        "-sS",
        "-X",
        "GET",
        OPENROUTER_MODELS_URL,
        "-H",
        "Accept-Encoding: identity",
        "-o",
        "-",
        "-w",
        "\n__OPENROUTER_STATUS__:%{http_code}",
        "--max-time",
        "45"
      ],
      { windowsHide: true }
    );

    const stdout = [];
    const stderr = [];
    let settled = false;

    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(result);
    };

    const abort = () => {
      child.kill();
      finish(new Error("Request aborted."));
    };

    if (signal?.aborted) {
      abort();
      return;
    }

    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      signal?.removeEventListener("abort", abort);
      const output = Buffer.concat(stdout).toString("utf8");
      const errorOutput = Buffer.concat(stderr).toString("utf8").trim();
      const marker = "\n__OPENROUTER_STATUS__:";
      const markerIndex = output.lastIndexOf(marker);

      if (markerIndex === -1) {
        finish(new Error(errorOutput || `curl exited with code ${code}`));
        return;
      }

      const text = output.slice(0, markerIndex);
      const status = Number(output.slice(markerIndex + marker.length).trim());
      const data = parseJsonResponse(text);

      if (code !== 0) {
        finish(new Error(errorOutput || `curl exited with code ${code}`));
        return;
      }

      if (status < 200 || status >= 300) {
        finish(new Error(data?.error?.message || data?.message || `OpenRouter ${status}`));
        return;
      }

      finish(null, data);
    });
  });
}

async function requestOpenRouterKeyInfo(apiKey, signal) {
  apiKey = String(apiKey || "").trim();
  if (!apiKey) throw new Error("Missing API key.");

  return await new Promise((resolve, reject) => {
    const child = spawn(
      CURL_COMMAND,
      [
        "-sS",
        "-X",
        "GET",
        "https://openrouter.ai/api/v1/key",
        "--config",
        "-",
        "-o",
        "-",
        "-w",
        "\n__OPENROUTER_STATUS__:%{http_code}",
        "--max-time",
        "30"
      ],
      { windowsHide: true }
    );

    const stdout = [];
    const stderr = [];
    let settled = false;

    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(result);
    };

    const abort = () => {
      child.kill();
      finish(new Error("Request aborted."));
    };

    if (signal?.aborted) {
      abort();
      return;
    }

    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      signal?.removeEventListener("abort", abort);
      const output = Buffer.concat(stdout).toString("utf8");
      const errorOutput = Buffer.concat(stderr).toString("utf8").trim();
      const marker = "\n__OPENROUTER_STATUS__:";
      const markerIndex = output.lastIndexOf(marker);

      if (markerIndex === -1) {
        finish(new Error(errorOutput || `curl exited with code ${code}`));
        return;
      }

      const text = output.slice(0, markerIndex);
      const status = Number(output.slice(markerIndex + marker.length).trim());
      const data = parseJsonResponse(text);

      if (code !== 0) {
        finish(new Error(errorOutput || `curl exited with code ${code}`));
        return;
      }

      if (status < 200 || status >= 300) {
        finish(new Error(data?.error?.message || data?.message || `OpenRouter ${status}`));
        return;
      }

      finish(null, data);
    });

    child.stdin.end(
      [
        'header = "Accept-Encoding: identity"',
        `header = "Authorization: Bearer ${apiKey}"`
      ].join("\n")
    );
  });
}

function emptyUnfinishedResponseError(purpose = "request") {
  const detail = purpose === "image" ? "No image data was received." : "No text data was received.";
  return new Error(`OpenRouter provider returned an empty unfinished response. ${detail}`);
}

async function requestOpenRouter({ apiKey, body, signal, maxTime = 300, purpose = "request" }) {
  const bodyPath = join(tmpdir(), `openrouter-gateway-${randomUUID()}.json`);
  const headerPath = join(tmpdir(), `openrouter-gateway-${randomUUID()}.headers`);
  await writeFile(bodyPath, JSON.stringify(body), "utf8");

  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(
        CURL_COMMAND,
        [
          "-sS",
          "-X",
          "POST",
          OPENROUTER_URL,
          "--config",
          "-",
          "-D",
          headerPath,
          "-o",
          "-",
          "-w",
          "\n__OPENROUTER_STATUS__:%{http_code}",
          "--max-time",
          String(maxTime)
        ],
        { windowsHide: true }
      );

      const stdout = [];
      const stderr = [];
      let settled = false;

      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        if (error) reject(error);
        else resolve(result);
      };

      const abort = () => {
        child.kill();
        finish(new Error("Request aborted."));
      };

      if (signal?.aborted) {
        abort();
        return;
      }

      signal?.addEventListener("abort", abort, { once: true });
      child.stdout.on("data", (chunk) => stdout.push(chunk));
      child.stderr.on("data", (chunk) => stderr.push(chunk));
      child.on("error", (error) => finish(error));
      child.on("close", async (code) => {
        signal?.removeEventListener("abort", abort);
        const output = Buffer.concat(stdout).toString("utf8");
        const errorOutput = Buffer.concat(stderr).toString("utf8").trim();
        const rawHeaders = await readFile(headerPath, "utf8").catch(() => "");
        const rateLimit = parseOpenRouterRateLimitHeaders(rawHeaders);
        const marker = "\n__OPENROUTER_STATUS__:";
        const markerIndex = output.lastIndexOf(marker);

        if (markerIndex === -1) {
          if (output && !output.trim() && /Operation timed out|server closed abruptly/i.test(errorOutput)) {
            finish(attachRateLimit(emptyUnfinishedResponseError(purpose), rateLimit));
            return;
          }
          finish(attachRateLimit(new Error(errorOutput || `curl exited with code ${code}`), rateLimit));
          return;
        }

        const text = output.slice(0, markerIndex);
        const status = Number(output.slice(markerIndex + marker.length).trim());

        if (code !== 0) {
          if (status === 200 && !text.trim() && /Operation timed out|server closed abruptly/i.test(errorOutput)) {
            finish(attachRateLimit(emptyUnfinishedResponseError(purpose), rateLimit));
            return;
          }
          finish(attachRateLimit(new Error(errorOutput || `curl exited with code ${code}`), rateLimit));
          return;
        }

        finish(null, { status, text, rateLimit });
      });

      const config = [
        'header = "Content-Type: application/json"',
        'header = "Accept-Encoding: identity"',
        `header = "Authorization: Bearer ${apiKey}"`,
        'header = "HTTP-Referer: http://localhost"',
        'header = "X-Title: OpenRouter Free Models Gateway"',
        `data-binary = "@${bodyPath.replace(/\\/g, "/")}"`
      ].join("\n");

      child.stdin.end(config);
    });
  } finally {
    await unlink(bodyPath).catch(() => {});
    await unlink(headerPath).catch(() => {});
  }
}

async function refreshOpenRouterModels(signal) {
  const data = await requestOpenRouterModels(signal);
  const nextModels = (Array.isArray(data?.data) ? data.data : [])
    .map(normalizeOpenRouterModel)
    .filter(Boolean);
  modelCache = mergeModelLists(nextModels);
  await persistModelCache();
  return publicModelCache();
}

async function generateImage({ prompt, options, apiKey, signal }) {
  apiKey = String(apiKey || "").trim();
  if (!apiKey) {
    throw new Error("Missing API key. Add at least one key to the page key pool.");
  }

  const modelInfo = getModelInfo(options?.model || DEFAULT_IMAGE_MODEL, "image");
  const imageConfig = buildImageConfig(options || {});
  const referenceImages = normalizeReferenceImages(options?.referenceImages);
  const content = referenceImages.length
    ? [
        { type: "text", text: prompt },
        ...referenceImages.map((url) => ({ type: "image_url", image_url: { url } }))
      ]
    : prompt;
  const requestBody = {
    model: modelInfo.id,
    messages: [{ role: "user", content }],
    modalities: ["image"]
  };

  if (imageConfig && modelSupportsParameter(modelInfo, "image_config")) {
    requestBody.image_config = imageConfig;
  }

  const { status, text, rateLimit } = await requestOpenRouter({
    apiKey,
    signal,
    body: requestBody,
    maxTime: 300,
    purpose: "image"
  });

  const data = parseJsonResponse(text);

  if (status < 200 || status >= 300) {
    const detail = data?.error?.message || data?.message || text || "Request failed";
    const upstreamCode = Number(data?.error?.metadata?.code || data?.error?.code || status);
    updateModelHealth(modelInfo.id, upstreamCode === 429 ? "rate-limited" : "error", detail, "image");
    throw attachOpenRouterError(new Error(`OpenRouter ${status}: ${detail}`), { status, data, text, rateLimit });
  }

  const images = extractImages(data);
  const textContent = data?.choices?.[0]?.message?.content || "";
  if (!images.length) {
    const reason = data?.choices?.[0]?.finish_reason ? ` finish_reason=${data.choices[0].finish_reason}.` : "";
    const message = textContent || `OpenRouter returned no image URLs for this request.${reason}`;
    updateModelHealth(modelInfo.id, "no-image", message, "image");
    throw attachRateLimit(new Error(message), rateLimit);
  }

  const savedImages = await saveImages(images);
  updateModelHealth(modelInfo.id, "ok", "", "image");
  updateOpenRouterKeyHealth(apiKey, "ok");

  return {
    images: savedImages.map((image) => image.url),
    originalImages: savedImages.map((image) => image.original),
    savedImages,
    text: textContent,
    model: modelInfo.id,
    rateLimit
  };
}

async function generateText({ messages, options, apiKey, signal }) {
  apiKey = String(apiKey || "").trim();
  if (!apiKey) {
    throw new Error("Missing API key. Add at least one key to the page key pool.");
  }

  const modelInfo = getModelInfo(options?.model || DEFAULT_TEXT_MODEL, "text");
  const requestBody = {
    model: modelInfo.id,
    messages
  };

  if (options?.maxTokens) requestBody.max_tokens = clamp(options.maxTokens, 1, 8192);
  if (options?.temperature !== "" && options?.temperature !== undefined) {
    const temperature = Number(options.temperature);
    if (Number.isFinite(temperature)) requestBody.temperature = temperature;
  }
  if (Array.isArray(options?.tools) && options.tools.length) requestBody.tools = options.tools;
  if (options?.toolChoice !== undefined) requestBody.tool_choice = options.toolChoice;
  if (options?.parallelToolCalls !== undefined) requestBody.parallel_tool_calls = Boolean(options.parallelToolCalls);
  if (options?.topP !== undefined) {
    const topP = Number(options.topP);
    if (Number.isFinite(topP)) requestBody.top_p = topP;
  }
  if (options?.frequencyPenalty !== undefined) {
    const frequencyPenalty = Number(options.frequencyPenalty);
    if (Number.isFinite(frequencyPenalty)) requestBody.frequency_penalty = frequencyPenalty;
  }
  if (options?.presencePenalty !== undefined) {
    const presencePenalty = Number(options.presencePenalty);
    if (Number.isFinite(presencePenalty)) requestBody.presence_penalty = presencePenalty;
  }

  const { status, text, rateLimit } = await requestOpenRouter({
    apiKey,
    signal,
    body: requestBody,
    maxTime: 120,
    purpose: "text"
  });
  const data = parseJsonResponse(text);

  if (status < 200 || status >= 300) {
    const detail = data?.error?.message || data?.message || text || "Request failed";
    const upstreamCode = Number(data?.error?.metadata?.code || data?.error?.code || status);
    updateModelHealth(modelInfo.id, upstreamCode === 429 ? "rate-limited" : "error", detail, "text");
    throw attachOpenRouterError(new Error(`OpenRouter ${status}: ${detail}`), { status, data, text, rateLimit });
  }

  const choice = data?.choices?.[0] || {};
  const upstreamMessage = choice.message || {};
  const content = upstreamMessage.content;
  const toolCalls = Array.isArray(upstreamMessage.tool_calls) ? upstreamMessage.tool_calls : [];
  if (typeof content !== "string" && !toolCalls.length) {
    const message = "OpenRouter returned no assistant text for this request.";
    updateModelHealth(modelInfo.id, "no-text", message, "text");
    throw attachRateLimit(new Error(message), rateLimit);
  }

  updateModelHealth(modelInfo.id, "ok", "", "text");
  updateOpenRouterKeyHealth(apiKey, "ok");
  const message = { role: "assistant", content: typeof content === "string" ? content : null };
  if (toolCalls.length) message.tool_calls = toolCalls;
  return {
    message,
    finishReason: choice.finish_reason || (toolCalls.length ? "tool_calls" : "stop"),
    usage: data?.usage || null,
    model: data?.model || modelInfo.id,
    rateLimit
  };
}

async function withRetry({ action, keyEntry, retryMax, retryDelayMs, signal, onRetry, onKeyUse }) {
  let attempt = 0;

  while (true) {
    attempt += 1;
    onKeyUse?.(keyEntry);

    try {
      return await action();
    } catch (error) {
      const shouldRetry = isRetryableError(error) && attempt <= retryMax;
      if (!shouldRetry) throw error;

      onRetry?.({
        attempt,
        nextAttempt: attempt + 1,
        maxAttempts: retryMax + 1,
        waitMs: retryDelayMs,
        error: error?.message || String(error)
      });
      await sleep(retryDelayMs, signal);
    }
  }
}

async function runWithOpenRouterKeyPool({ apiKeys, retryMax = 2, retryDelayMs = 15000, signal, action }) {
  const keyPool = createKeyPool(apiKeys);

  while (keyPool.hasActiveKeys()) {
    const keyEntry = keyPool.nextActiveKey();
    try {
      const result = await withRetry({
        keyEntry,
        retryMax,
        retryDelayMs,
        signal,
        action: () => action(keyEntry)
      });
      return { result, keyEntry, keyPool };
    } catch (error) {
      if (isRateLimitError(error)) {
        if (isProviderScopedRateLimitError(error)) {
          throw Object.assign(error, { keyEntry, keyPool });
        } else if (isDailyRateLimitError(error)) {
          keyPool.markDailyLimited(keyEntry, error);
          updateOpenRouterKeyHealth(keyEntry.key, "daily-limited", error.message, { resetAt: error?.rateLimit?.resetAt });
        } else {
          keyPool.markRateLimited(keyEntry, error);
          updateOpenRouterKeyHealth(keyEntry.key, "rate-limited", error.message, { resetAt: error?.rateLimit?.resetAt, scope: "key" });
        }
        continue;
      }
      if (/empty unfinished response/i.test(error?.message || "")) {
        keyPool.markError(keyEntry, error);
        updateOpenRouterKeyHealth(keyEntry.key, "provider-timeout", error.message);
        continue;
      }
      throw Object.assign(error, { keyEntry, keyPool });
    }
  }

  const snapshot = keyPool.snapshot();
  const allErrored = snapshot.length && snapshot.every((key) => key.status === "error");
  const error = new Error(
    allErrored
      ? "All upstream OpenRouter API keys failed before a response was received."
      : "All upstream OpenRouter API keys are rate limited."
  );
  error.keyPool = keyPool;
  error.statusCode = allErrored ? 502 : 429;
  error.openAIType = allErrored ? "server_error" : "rate_limit_error";
  error.openAICode = allErrored ? "upstream_error" : "rate_limited";
  throw error;
}

function openAIModelObject(id) {
  return {
    id,
    object: "model",
    created: 0,
    owned_by: "openrouter-gateway"
  };
}

async function handleOpenAIModels(req, res) {
  if (req.method !== "GET") {
    sendOpenAIError(res, 405, "Method not allowed.", { code: "method_not_allowed" });
    return;
  }

  const serviceKey = authenticateServiceRequest(req, res);
  if (!serviceKey) return;

  const ids = new Set(["gpt-chat-local", "gpt-image-local", DEFAULT_TEXT_MODEL, DEFAULT_IMAGE_MODEL]);
  for (const model of modelCache.models || []) {
    if (model?.id) ids.add(model.id);
  }

  sendJson(res, 200, {
    object: "list",
    data: [...ids].map(openAIModelObject)
  });
}

async function handleOpenAIChatCompletions(req, res) {
  if (req.method !== "POST") {
    sendOpenAIError(res, 405, "Method not allowed.", { code: "method_not_allowed" });
    return;
  }

  const serviceKey = authenticateServiceRequest(req, res);
  if (!serviceKey) return;

  const upstreamKeys = configuredOpenRouterApiKeys();
  if (!upstreamKeys.length) {
    sendOpenAIError(res, 503, "Upstream OpenRouter API keys are not configured. Set OPENROUTER_API_KEYS.", {
      type: "server_error",
      code: "openrouter_api_keys_missing"
    });
    return;
  }

  let body;
  try {
    body = await readJson(req);
  } catch {
    sendOpenAIError(res, 400, "Invalid JSON body.", { code: "invalid_json" });
    return;
  }

  const messages = normalizeOpenAIMessages(body.messages);
  if (!messages.length) {
    sendOpenAIError(res, 400, "messages must contain at least one text message.", {
      param: "messages",
      code: "missing_messages"
    });
    return;
  }

  const controller = new AbortController();
  req.on("aborted", () => controller.abort());
  res.on("close", () => controller.abort());

  const stream = body.stream === true;
  const responseId = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  let streamBase = null;
  let streamHeartbeat = null;

  try {
    const model = resolveOpenAIModel(body.model, "text");
    const startedAt = Date.now();
    if (stream) {
      streamBase = beginOpenAIChatStream(res, { id: responseId, created, model });
      streamHeartbeat = setInterval(() => {
        if (!res.destroyed && !res.writableEnded) res.write(": keep-alive\n\n");
      }, BATCH_STREAM_HEARTBEAT_MS);
      streamHeartbeat.unref?.();
    }
    const { result } = await runWithOpenRouterKeyPool({
      apiKeys: upstreamKeys,
      retryMax: clamp(body.retryMax ?? 2, 0, 10),
      retryDelayMs: clamp(body.retryDelaySeconds ?? 15, 5, 600) * 1000,
      signal: controller.signal,
      action: (keyEntry) =>
        generateText({
          messages,
          options: {
            model,
            maxTokens: cleanOpenAIParam(body.max_tokens ?? body.maxTokens),
            temperature: cleanOpenAIParam(body.temperature),
            topP: cleanOpenAIParam(body.top_p),
            frequencyPenalty: cleanOpenAIParam(body.frequency_penalty),
            presencePenalty: cleanOpenAIParam(body.presence_penalty),
            tools: Array.isArray(body.tools) ? body.tools : undefined,
            toolChoice: cleanOpenAIParam(body.tool_choice),
            parallelToolCalls: cleanOpenAIParam(body.parallel_tool_calls)
          },
          apiKey: keyEntry.key,
          signal: controller.signal
        })
    });

    const payload = {
      id: responseId,
      object: "chat.completion",
      created,
      model: result.model || model,
      choices: [
        {
          index: 0,
          message: result.message,
          finish_reason: result.finishReason || "stop"
        }
      ],
      usage: result.usage || null,
      service_key: { id: serviceKey.id, label: serviceKey.label },
      duration_ms: Date.now() - startedAt
    };

    if (stream) {
      if (streamHeartbeat) clearInterval(streamHeartbeat);
      writeOpenAIChatStreamResult(res, streamBase, result.message, result.finishReason || "stop");
      return;
    }

    sendJson(res, 200, payload);
  } catch (error) {
    const status = error?.statusCode || (isRateLimitError(error) ? 429 : 502);
    if (stream && streamBase) {
      if (streamHeartbeat) clearInterval(streamHeartbeat);
      writeOpenAIChatStreamError(res, streamBase, error);
      return;
    }
    sendOpenAIError(res, status, error?.message || String(error), {
      type: error?.openAIType || (status === 429 ? "rate_limit_error" : "server_error"),
      code: error?.openAICode || (status === 429 ? "rate_limited" : "upstream_error")
    });
  }
}

function aspectRatioFromOpenAISize(size) {
  const match = String(size || "").trim().match(/^(\d+)x(\d+)$/i);
  if (!match) return "auto";
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return "auto";

  function gcd(a, b) {
    while (b) {
      const next = a % b;
      a = b;
      b = next;
    }
    return a;
  }

  const divisor = gcd(width, height);
  return `${width / divisor}:${height / divisor}`;
}

async function runOpenAIImageTasks({ prompt, count, options, apiKeys, concurrency, signal }) {
  const pending = Array.from({ length: count }, (_, index) => index);
  const results = Array(count).fill(null);
  const errors = [];
  let inFlight = 0;

  const keyPool = createKeyPool(apiKeys);

  await new Promise((resolve) => {
    function finishIfDone() {
      if ((!pending.length && inFlight === 0) || (signal.aborted && inFlight === 0)) resolve();
    }

    function dispatch() {
      if (signal.aborted) {
        finishIfDone();
        return;
      }

      while (inFlight < concurrency && pending.length && keyPool.hasActiveKeys()) {
        const index = pending.shift();
        const keyEntry = keyPool.nextActiveKey();
        inFlight += 1;

        (async () => {
          try {
            const result = await withRetry({
              keyEntry,
              retryMax: 2,
              retryDelayMs: 15000,
              signal,
              action: () => generateImage({ prompt, options, apiKey: keyEntry.key, signal })
            });
            results[index] = result;
          } catch (error) {
            if (isRateLimitError(error)) {
              if (isProviderScopedRateLimitError(error)) {
                errors.push(error);
                pending.length = 0;
              } else {
                if (isDailyRateLimitError(error)) keyPool.markDailyLimited(keyEntry, error);
                else keyPool.markRateLimited(keyEntry, error);
                pending.unshift(index);
              }
            } else {
              errors.push(error);
            }
          } finally {
            inFlight -= 1;
            dispatch();
            finishIfDone();
          }
        })();
      }

      if (!keyPool.hasActiveKeys() && pending.length && inFlight === 0) {
        errors.push(new Error("All upstream OpenRouter API keys are rate limited."));
        pending.length = 0;
      }

      finishIfDone();
    }

    dispatch();
  });

  const savedImages = results.flatMap((result) => result?.savedImages || []);
  if (!savedImages.length) {
    throw errors[0] || new Error("Image generation returned no images.");
  }

  return { savedImages, errors };
}

async function handleOpenAIImageGenerations(req, res) {
  if (req.method !== "POST") {
    sendOpenAIError(res, 405, "Method not allowed.", { code: "method_not_allowed" });
    return;
  }

  const serviceKey = authenticateServiceRequest(req, res);
  if (!serviceKey) return;

  const upstreamKeys = configuredOpenRouterApiKeys();
  if (!upstreamKeys.length) {
    sendOpenAIError(res, 503, "Upstream OpenRouter API keys are not configured. Set OPENROUTER_API_KEYS.", {
      type: "server_error",
      code: "openrouter_api_keys_missing"
    });
    return;
  }

  let body;
  try {
    body = await readJson(req);
  } catch {
    sendOpenAIError(res, 400, "Invalid JSON body.", { code: "invalid_json" });
    return;
  }

  const prompt = String(body.prompt || "").trim();
  if (!prompt) {
    sendOpenAIError(res, 400, "prompt is required.", { param: "prompt", code: "missing_prompt" });
    return;
  }

  const rawN = body.n === undefined ? serviceKey.defaultImageN : Number(body.n);
  if (!Number.isFinite(rawN) || rawN < 1) {
    sendOpenAIError(res, 400, "n must be a positive integer.", { param: "n", code: "invalid_n" });
    return;
  }

  const count = Math.trunc(rawN);
  if (count > serviceKey.maxImageN) {
    sendOpenAIError(res, 400, `n must be less than or equal to ${serviceKey.maxImageN}.`, {
      param: "n",
      code: "n_too_large"
    });
    return;
  }

  const responseFormat = String(body.response_format || "url").trim();
  if (!["url", "b64_json"].includes(responseFormat)) {
    sendOpenAIError(res, 400, "response_format must be url or b64_json.", {
      param: "response_format",
      code: "invalid_response_format"
    });
    return;
  }

  const controller = new AbortController();
  req.on("aborted", () => controller.abort());
  res.on("close", () => controller.abort());

  try {
    const model = resolveOpenAIModel(body.model, "image");
    const referenceImages = normalizeReferenceImages(body.reference_images || body.referenceImages || body.image);
    const { savedImages } = await runOpenAIImageTasks({
      prompt,
      count,
      apiKeys: upstreamKeys,
      concurrency: serviceKey.concurrency,
      signal: controller.signal,
      options: {
        model,
        aspectRatio: body.aspect_ratio || body.aspectRatio || aspectRatioFromOpenAISize(body.size),
        imageSize: body.image_size || body.imageSize || "auto",
        referenceImages
      }
    });

    const data = [];
    for (const savedImage of savedImages.slice(0, count)) {
      if (responseFormat === "b64_json") {
        const b64 = await savedImageToB64Json(savedImage);
        if (!b64) continue;
        data.push({ b64_json: b64 });
      } else {
        data.push({ url: absolutePublicUrl(req, savedImage.url) });
      }
    }

    if (!data.length) {
      throw new Error("Image generation completed, but no compatible image output was available.");
    }

    sendJson(res, 200, {
      created: Math.floor(Date.now() / 1000),
      data,
      service_key: { id: serviceKey.id, label: serviceKey.label }
    });
  } catch (error) {
    const status = error?.statusCode || (isRateLimitError(error) ? 429 : 502);
    sendOpenAIError(res, status, error?.message || String(error), {
      type: error?.openAIType || (status === 429 ? "rate_limit_error" : "server_error"),
      code: error?.openAICode || (status === 429 ? "rate_limited" : "upstream_error")
    });
  }
}

async function handleModels(req, res) {
  if (req.method === "GET") {
    sendJson(res, 200, publicModelCache());
    return;
  }

  if (req.method === "POST" && req.url === "/api/models/refresh") {
    const controller = new AbortController();
    req.on("close", () => controller.abort());
    try {
      const models = await refreshOpenRouterModels(controller.signal);
      sendJson(res, 200, models);
    } catch (error) {
      modelCache = { ...modelCache, error: error?.message || String(error) };
      sendJson(res, 502, { ...publicModelCache(), error: error?.message || String(error) });
    }
    return;
  }

  sendJson(res, 405, { error: "Method not allowed" });
}

async function handleModelAudit(req, res) {
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }

  let body = {};
  try {
    body = await readJson(req);
  } catch {
    sendJson(res, 400, { error: "Invalid JSON body." });
    return;
  }

  const controller = new AbortController();
  req.on("aborted", () => controller.abort());
  res.on("close", () => controller.abort());

  try {
    const data = await auditModelAvailability({
      signal: controller.signal,
      maxProbes: clamp(body.maxProbes ?? MODEL_AUDIT_MAX_PROBES, 0, 200),
      refresh: body.refresh !== false
    });
    sendJson(res, 200, data);
  } catch (error) {
    modelCache = { ...modelCache, error: error?.message || String(error) };
    sendJson(res, 502, { ...publicModelCache(), error: error?.message || String(error) });
  }
}

async function handleKeyInfo(req, res) {
  let body;
  try {
    body = await readJson(req);
  } catch {
    sendJson(res, 400, { error: "Invalid JSON body." });
    return;
  }

  const apiKeys = parseApiKeys(body);
  if (!apiKeys.length) {
    sendJson(res, 400, { error: "Add at least one API key to query." });
    return;
  }

  const controller = new AbortController();
  req.on("close", () => controller.abort());

  const keys = await Promise.all(
    apiKeys.map(async (apiKey, id) => {
      try {
        const response = await requestOpenRouterKeyInfo(apiKey, controller.signal);
        const data = response?.data || {};
        return {
          id,
          label: maskApiKey(apiKey),
          status: "ok",
          credits: {
            limit: data.limit,
            remaining: data.limit_remaining,
            reset: data.limit_reset,
            usage: data.usage,
            usageDaily: data.usage_daily
          },
          freeModels: {
            total: freeDailyLimitForKeyInfo(data),
            remaining: null,
            resetAt: null,
            source: "inferred",
            note: data.is_free_tier
              ? "Free-tier account: OpenRouter documents 50 free-model requests per UTC day."
              : "Paid/credited account: OpenRouter documents 1000 free-model requests per UTC day after adding at least 10 credits."
          },
          isFreeTier: data.is_free_tier
        };
      } catch (error) {
        return {
          id,
          label: maskApiKey(apiKey),
          status: "error",
          error: error?.message || String(error)
        };
      }
    })
  );

  sendJson(res, 200, { keys });
}

function publicOpenRouterKeyRecord(item) {
  return {
    id: item.id,
    key: item.key,
    label: item.label || maskApiKey(item.key),
    source: item.source || "stored",
    createdAt: item.createdAt || null,
    status: item.status || "unknown",
    lastOkAt: item.lastOkAt || null,
    lastError: item.lastError || "",
    lastErrorAt: item.lastErrorAt || null,
    cooldownUntil: item.cooldownUntil || null
  };
}

async function handleUpstreamKeys(req, res) {
  if (req.method === "GET") {
    sendJson(res, 200, { keys: allOpenRouterKeyRecords().map(publicOpenRouterKeyRecord) });
    return;
  }

  if (req.method !== "POST") {
    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }

  let body;
  try {
    body = await readJson(req);
  } catch {
    sendJson(res, 400, { error: "Invalid JSON body." });
    return;
  }

  const action = String(body.action || "add");

  if (action === "add") {
    const incoming = parseDelimitedSecrets(...(Array.isArray(body.keys) ? body.keys : [body.key, body.keys]));
    const existing = new Set(allOpenRouterKeyRecords().map((item) => item.key));
    let added = 0;
    for (const key of incoming) {
      if (existing.has(key)) continue;
      openRouterApiKeys.push(normalizeOpenRouterApiKeyRecord({ key, source: "stored", createdAt: Date.now() }));
      existing.add(key);
      added += 1;
    }
    if (added) await persistOpenRouterApiKeys();
    sendJson(res, 200, { added, keys: allOpenRouterKeyRecords().map(publicOpenRouterKeyRecord) });
    return;
  }

  if (action === "delete") {
    const id = String(body.id || "");
    const before = openRouterApiKeys.length;
    openRouterApiKeys = openRouterApiKeys.filter((item) => item.id !== id);
    if (openRouterApiKeys.length !== before) await persistOpenRouterApiKeys();
    sendJson(res, 200, { ok: true, keys: allOpenRouterKeyRecords().map(publicOpenRouterKeyRecord) });
    return;
  }

  if (action === "clear") {
    openRouterApiKeys = [];
    await persistOpenRouterApiKeys();
    sendJson(res, 200, { ok: true, keys: allOpenRouterKeyRecords().map(publicOpenRouterKeyRecord) });
    return;
  }

  sendJson(res, 400, { error: "Unsupported upstream key action." });
}

async function handleServiceKeys(req, res) {
  if (req.method === "GET") {
    sendJson(res, 200, {
      defaults: {
        concurrency: DEFAULT_SERVICE_KEY_CONCURRENCY,
        defaultImageN: DEFAULT_OPENAI_IMAGE_N,
        maxImageN: MAX_OPENAI_IMAGE_N
      },
      keys: configuredServiceApiKeys().map((item) => publicServiceKeyRecord(item))
    });
    return;
  }

  if (req.method !== "POST") {
    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }

  let body;
  try {
    body = await readJson(req);
  } catch {
    sendJson(res, 400, { error: "Invalid JSON body." });
    return;
  }

  const action = String(body.action || "create");

  if (action === "create") {
    const defaultImageN = clamp(body.defaultImageN || DEFAULT_OPENAI_IMAGE_N, 1, MAX_BATCH_REQUESTS);
    const item = normalizeServiceApiKeyRecord({
      id: randomUUID(),
      name: body.name || "服务 API Key",
      key: `sk-local-${randomUUID().replace(/-/g, "")}${randomUUID().replace(/-/g, "")}`,
      enabled: true,
      concurrency: body.concurrency || DEFAULT_SERVICE_KEY_CONCURRENCY,
      defaultImageN,
      maxImageN: Math.max(defaultImageN, clamp(body.maxImageN || MAX_OPENAI_IMAGE_N, 1, MAX_BATCH_REQUESTS)),
      createdAt: Date.now(),
      updatedAt: Date.now()
    });
    serviceApiKeys.push(item);
    await persistServiceApiKeys();
    sendJson(res, 200, { key: publicServiceKeyRecord(item, true), keys: configuredServiceApiKeys().map((entry) => publicServiceKeyRecord(entry)) });
    return;
  }

  const id = String(body.id || "");
  const index = serviceApiKeys.findIndex((item) => item.id === id);
  if (index === -1) {
    sendJson(res, 404, { error: "Service API key not found or is environment-managed." });
    return;
  }

  if (action === "delete") {
    serviceApiKeys.splice(index, 1);
    await persistServiceApiKeys();
    sendJson(res, 200, { ok: true, keys: configuredServiceApiKeys().map((entry) => publicServiceKeyRecord(entry)) });
    return;
  }

  if (action === "update") {
    const current = serviceApiKeys[index];
    const defaultImageN = clamp(body.defaultImageN ?? current.defaultImageN, 1, MAX_BATCH_REQUESTS);
    const next = normalizeServiceApiKeyRecord({
      ...current,
      name: body.name ?? current.name,
      enabled: body.enabled ?? current.enabled,
      concurrency: body.concurrency ?? current.concurrency,
      defaultImageN,
      maxImageN: Math.max(defaultImageN, clamp(body.maxImageN ?? current.maxImageN, 1, MAX_BATCH_REQUESTS)),
      updatedAt: Date.now()
    });
    serviceApiKeys[index] = next;
    await persistServiceApiKeys();
    sendJson(res, 200, { key: publicServiceKeyRecord(next), keys: configuredServiceApiKeys().map((entry) => publicServiceKeyRecord(entry)) });
    return;
  }

  sendJson(res, 400, { error: "Unsupported service key action." });
}

async function handleChat(req, res) {
  let body;
  try {
    body = await readJson(req);
  } catch {
    sendJson(res, 400, { error: "Invalid JSON body." });
    return;
  }

  const apiKeys = parseApiKeys(body);
  const keyPool = createKeyPool(apiKeys);
  const retryMax = clamp(body.retryMax ?? 2, 0, 10);
  const retryDelayMs = clamp(body.retryDelaySeconds ?? 15, 5, 600) * 1000;
  const model = String(body.model || DEFAULT_TEXT_MODEL).trim();
  const messages = Array.isArray(body.messages)
    ? body.messages
        .filter((message) => message && typeof message.content === "string")
        .map((message) => ({ role: message.role === "assistant" ? "assistant" : "user", content: message.content }))
    : [];

  if (!apiKeys.length) {
    sendJson(res, 400, { error: "Add at least one API key to the page key pool before chatting." });
    return;
  }

  if (!messages.length) {
    sendJson(res, 400, { error: "Enter a chat message first." });
    return;
  }

  const controller = new AbortController();
  req.on("close", () => controller.abort());

  while (keyPool.hasActiveKeys()) {
    const keyEntry = keyPool.nextActiveKey();
    const startedAt = Date.now();
    try {
      const result = await withRetry({
        keyEntry,
        retryMax,
        retryDelayMs,
        signal: controller.signal,
        action: () => generateText({
          messages,
          options: {
            model,
            maxTokens: body.maxTokens,
            temperature: body.temperature
          },
          apiKey: keyEntry.key,
          signal: controller.signal
        })
      });

      sendJson(res, 200, {
        ...result,
        durationMs: Date.now() - startedAt,
        key: { id: keyEntry.id, label: keyEntry.label },
        apiKeys: keyPool.snapshot()
      });
      return;
    } catch (error) {
      if (isRateLimitError(error)) {
        if (isProviderScopedRateLimitError(error)) {
          sendJson(res, 429, {
            error: error?.message || String(error),
            rateLimit: error?.rateLimit || null,
            durationMs: Date.now() - startedAt,
            key: { id: keyEntry.id, label: keyEntry.label },
            apiKeys: keyPool.snapshot()
          });
          return;
        }
        if (isDailyRateLimitError(error)) {
          keyPool.markDailyLimited(keyEntry, error);
          updateOpenRouterKeyHealth(keyEntry.key, "daily-limited", error.message, { resetAt: error?.rateLimit?.resetAt });
        } else {
          keyPool.markRateLimited(keyEntry, error);
          updateOpenRouterKeyHealth(keyEntry.key, "rate-limited", error.message, { resetAt: error?.rateLimit?.resetAt, scope: "key" });
        }
        continue;
      }

      if (/empty unfinished response/i.test(error?.message || "")) {
        keyPool.markError(keyEntry, error);
        updateOpenRouterKeyHealth(keyEntry.key, "provider-timeout", error.message);
        updateModelHealth(model, "provider-timeout", error.message, "text");
        continue;
      }

      sendJson(res, 502, {
        error: error?.message || String(error),
        charged: isChargedOpenRouterError(error),
        rateLimit: error?.rateLimit || null,
        durationMs: Date.now() - startedAt,
        key: { id: keyEntry.id, label: keyEntry.label },
        apiKeys: keyPool.snapshot()
      });
      return;
    }
  }

  const snapshot = keyPool.snapshot();
  const allErrored = snapshot.length && snapshot.every((key) => key.status === "error");
  sendJson(res, allErrored ? 502 : 429, {
    error: allErrored
      ? "All API keys failed before a text response was received."
      : "All API keys are daily rate limited for free models.",
    apiKeys: snapshot
  });
}

async function handleBatch(req, res) {
  let body;
  try {
    body = await readJson(req);
  } catch {
    sendJson(res, 400, { error: "Invalid JSON body." });
    return;
  }

  const count = clamp(body.count ?? 4, 1, MAX_BATCH_REQUESTS);
  const queueMode = body.queueMode === true;
  const perKeyConcurrency = queueMode ? 1 : clamp(body.concurrency ?? 3, 1, 8);
  const retryMax = clamp(body.retryMax ?? 3, 0, 10);
  const retryDelayMs = clamp(body.retryDelaySeconds ?? 70, 5, 600) * 1000;
  const prompts = buildPrompts({ ...body, count });
  const apiKeys = parseApiKeys(body);
  const selectedModel = String(body.model || DEFAULT_IMAGE_MODEL).trim();
  const options = {
    model: selectedModel,
    aspectRatio: String(body.aspectRatio || "auto"),
    imageSize: String(body.imageSize || "auto"),
    referenceImages: normalizeReferenceImages(body.referenceImages),
    queueMode,
    retryMax,
    retryDelayMs
  };
  const keyPool = createKeyPool(apiKeys);

  if (!prompts.length) {
    sendJson(res, 400, { error: "Enter a prompt or at least one prompt line." });
    return;
  }

  if (!apiKeys.length) {
    sendJson(res, 400, { error: "Add at least one API key to the page key pool before starting a batch." });
    return;
  }

  res.writeHead(200, {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-store, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
    "X-Content-Type-Options": "nosniff"
  });
  res.flushHeaders?.();
  res.socket?.setKeepAlive?.(true);

  const controller = new AbortController();
  req.on("aborted", () => controller.abort());
  res.on("close", () => controller.abort());

  const streamStartedAt = Date.now();
  let lastStreamWriteAt = 0;
  let pendingTasks = [];
  let completed = 0;
  let inFlight = 0;

  const writeEvent = (event) => {
    if (controller.signal.aborted || res.destroyed || res.writableEnded) return false;
    lastStreamWriteAt = Date.now();
    return res.write(`${JSON.stringify(event)}\n`);
  };

  const heartbeat = setInterval(() => {
    if (Date.now() - lastStreamWriteAt < BATCH_STREAM_HEARTBEAT_MS) return;
    writeEvent({
      type: "heartbeat",
      completed,
      total: prompts.length,
      inFlight,
      pending: pendingTasks.length,
      elapsedMs: Date.now() - streamStartedAt
    });
  }, BATCH_STREAM_HEARTBEAT_MS);
  heartbeat.unref?.();

  writeEvent({
    type: "start",
    total: prompts.length,
    concurrency: perKeyConcurrency,
    totalConcurrency: keyPool.activeKeys().length * perKeyConcurrency,
    queueMode,
    retryMax,
    retryDelayMs,
    apiKeys: keyPool.snapshot(),
    model: selectedModel,
    referenceImageCount: options.referenceImages.length
  });

  pendingTasks = prompts.map((prompt, index) => ({ index, prompt }));

  await new Promise((resolve) => {
    const keyLoads = new Map(keyPool.snapshot().map((key) => [key.id, 0]));

    function finishIfDone() {
      if (controller.signal.aborted && inFlight === 0) {
        resolve();
        return;
      }

      if (!keyPool.hasActiveKeys() && inFlight === 0 && pendingTasks.length) {
        while (pendingTasks.length) {
          const task = pendingTasks.shift();
          completed += 1;
          writeEvent({
            type: "task-error",
            index: task.index,
            prompt: task.prompt,
            durationMs: 0,
            error: "All API keys are daily rate limited for free models."
          });
        }
      }

      if (completed >= prompts.length && inFlight === 0) {
        resolve();
      }
    }

    function dispatchForKey(keyEntry) {
      if (controller.signal.aborted || keyEntry.status !== "active") return;

      while ((keyLoads.get(keyEntry.id) || 0) < perKeyConcurrency && pendingTasks.length) {
        const task = pendingTasks.shift();
        keyLoads.set(keyEntry.id, (keyLoads.get(keyEntry.id) || 0) + 1);
        inFlight += 1;
        runTaskForKey(task, keyEntry);
      }
    }

    function dispatchAll() {
      for (const keyEntry of keyPool.activeKeys()) {
        dispatchForKey(keyEntry);
      }
      finishIfDone();
    }

    async function runTaskForKey(task, keyEntry) {
      const { index, prompt } = task;
      writeEvent({ type: "task-start", index, prompt, key: { id: keyEntry.id, label: keyEntry.label } });

      const startedAt = Date.now();
      try {
        const result = await withRetry({
          keyEntry,
          retryMax,
          retryDelayMs,
          signal: controller.signal,
          action: () => generateImage({ prompt, options, apiKey: keyEntry.key, signal: controller.signal }),
          onRetry: (retry) => writeEvent({ type: "task-retry", index, prompt, key: { id: keyEntry.id, label: keyEntry.label }, ...retry }),
          onKeyUse: (key) => writeEvent({ type: "task-key", index, key: { id: key.id, label: key.label } })
        });
        completed += 1;
        writeEvent({
          type: "task-done",
          index,
          prompt,
          key: { id: keyEntry.id, label: keyEntry.label },
          durationMs: Date.now() - startedAt,
          ...result
        });
      } catch (error) {
        if (isRateLimitError(error)) {
          if (isProviderScopedRateLimitError(error)) {
            completed += 1;
            writeEvent({
              type: "task-error",
              index,
              prompt,
              key: { id: keyEntry.id, label: keyEntry.label },
              durationMs: Date.now() - startedAt,
              charged: false,
              rateLimit: error?.rateLimit || null,
              error: error?.message || String(error)
            });
          } else if (isDailyRateLimitError(error)) {
            keyPool.markDailyLimited(keyEntry, error);
            updateOpenRouterKeyHealth(keyEntry.key, "daily-limited", error.message, { resetAt: error?.rateLimit?.resetAt });
            pendingTasks.unshift(task);
            writeEvent({
              type: "key-limited",
              index,
              prompt,
              key: { id: keyEntry.id, label: keyEntry.label, status: keyEntry.status },
              apiKeys: keyPool.snapshot(),
              rateLimit: error?.rateLimit || null,
              error: error?.message || String(error)
            });
          } else {
            keyPool.markRateLimited(keyEntry, error);
            updateOpenRouterKeyHealth(keyEntry.key, "rate-limited", error.message, { resetAt: error?.rateLimit?.resetAt, scope: "key" });
            pendingTasks.unshift(task);
            writeEvent({
              type: "key-limited",
              index,
              prompt,
              key: { id: keyEntry.id, label: keyEntry.label, status: keyEntry.status },
              apiKeys: keyPool.snapshot(),
              rateLimit: error?.rateLimit || null,
              error: error?.message || String(error)
            });
          }
        } else {
          if (/empty unfinished response/i.test(error?.message || "")) updateModelHealth(selectedModel, "provider-timeout", error.message);
          completed += 1;
          writeEvent({
            type: "task-error",
            index,
            prompt,
            key: { id: keyEntry.id, label: keyEntry.label },
            durationMs: Date.now() - startedAt,
            charged: isChargedOpenRouterError(error),
            rateLimit: error?.rateLimit || null,
            error: error?.message || String(error)
          });
        }
      } finally {
        keyLoads.set(keyEntry.id, Math.max(0, (keyLoads.get(keyEntry.id) || 1) - 1));
        inFlight -= 1;

        if (queueMode && pendingTasks.length && keyEntry.status === "active" && !controller.signal.aborted) {
          writeEvent({ type: "task-wait", index, waitMs: retryDelayMs, reason: "queue-delay", key: { id: keyEntry.id, label: keyEntry.label } });
          await sleep(retryDelayMs, controller.signal).catch(() => {});
        }

        dispatchAll();
      }
    }

    dispatchAll();
  });

  clearInterval(heartbeat);
  writeEvent({ type: "done", completed, total: prompts.length });
  if (!res.destroyed && !res.writableEnded) res.end();
}

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const requestedPath = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const safePath = normalize(requestedPath).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(PUBLIC_DIR, safePath);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendJson(res, 403, { error: "Forbidden" });
    return;
  }

  try {
    const content = await readFile(filePath);
    res.writeHead(200, { "Content-Type": mimeTypes[extname(filePath)] || "application/octet-stream" });
    res.end(content);
  } catch {
    sendJson(res, 404, { error: "Not found" });
  }
}

async function serveOutput(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const requestedPath = decodeURIComponent(url.pathname.replace(/^\/outputs\//, ""));
  const safePath = normalize(requestedPath).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(OUTPUT_DIR, safePath);

  if (!filePath.startsWith(OUTPUT_DIR)) {
    sendJson(res, 403, { error: "Forbidden" });
    return;
  }

  try {
    const content = await readFile(filePath);
    res.writeHead(200, { "Content-Type": mimeTypes[extname(filePath)] || "application/octet-stream" });
    res.end(content);
  } catch {
    sendJson(res, 404, { error: "Not found" });
  }
}

async function handleOutputs(req, res) {
  try {
    await mkdir(OUTPUT_DIR, { recursive: true });
    const filenames = await readdir(OUTPUT_DIR);
    const images = [];

    for (const filename of filenames) {
      const extension = extname(filename).toLowerCase();
      if (!OUTPUT_IMAGE_EXTENSIONS.has(extension)) continue;

      const filePath = join(OUTPUT_DIR, filename);
      if (!filePath.startsWith(OUTPUT_DIR)) continue;

      const info = await stat(filePath).catch(() => null);
      if (!info?.isFile()) continue;

      images.push({
        filename,
        url: `/outputs/${encodeURIComponent(filename)}`,
        bytes: info.size,
        modifiedAt: info.mtimeMs,
        mime: mimeTypes[extension] || "application/octet-stream"
      });
    }

    images.sort((a, b) => b.modifiedAt - a.modifiedAt || a.filename.localeCompare(b.filename));
    sendJson(res, 200, {
      total: images.length,
      images: images.slice(0, 200)
    });
  } catch (error) {
    sendJson(res, 500, { error: error?.message || String(error) });
  }
}

async function handleDeleteOutput(req, res) {
  let body;
  try {
    body = await readJson(req);
  } catch {
    sendJson(res, 400, { error: "Invalid JSON body." });
    return;
  }

  const filename = String(body.filename || "").trim();
  if (!filename || filename.includes("/") || filename.includes("\\")) {
    sendJson(res, 400, { error: "Provide a valid output filename." });
    return;
  }

  const extension = extname(filename).toLowerCase();
  if (!OUTPUT_IMAGE_EXTENSIONS.has(extension)) {
    sendJson(res, 400, { error: "Only saved output image files can be deleted." });
    return;
  }

  const filePath = join(OUTPUT_DIR, filename);
  if (!filePath.startsWith(OUTPUT_DIR)) {
    sendJson(res, 403, { error: "Forbidden" });
    return;
  }

  try {
    await unlink(filePath);
    sendJson(res, 200, { ok: true, filename });
  } catch (error) {
    sendJson(res, 404, { error: error?.code === "ENOENT" ? "Output image not found." : error?.message || String(error) });
  }
}

async function pathStatus(path) {
  try {
    const info = await stat(path);
    return {
      exists: true,
      directory: info.isDirectory(),
      file: info.isFile()
    };
  } catch (error) {
    return {
      exists: false,
      error: error?.code || error?.message || String(error)
    };
  }
}

async function handleHealth(req, res) {
  try {
    await mkdir(OUTPUT_DIR, { recursive: true });
    await mkdir(DATA_DIR, { recursive: true });

    const [publicDir, outputDir, dataDir, modelCacheFile] = await Promise.all([
      pathStatus(PUBLIC_DIR),
      pathStatus(OUTPUT_DIR),
      pathStatus(DATA_DIR),
      pathStatus(MODEL_CACHE_FILE)
    ]);

    sendJson(res, 200, {
      ok: publicDir.directory && outputDir.directory && dataDir.directory,
      app: PACKAGE_INFO.name,
      version: PACKAGE_INFO.version,
      phase: "local-console-alpha",
      port: PORT,
      defaults: {
        textModel: DEFAULT_TEXT_MODEL,
        imageModel: DEFAULT_IMAGE_MODEL
      },
      models: {
        all: modelCache.models.length,
        text: modelCache.text.length,
        image: modelCache.image.length,
        refreshedAt: modelCache.refreshedAt || null,
        error: modelCache.error || ""
      },
      storage: {
        publicDir,
        outputDir,
        dataDir,
        modelCacheFile
      }
    });
  } catch (error) {
    sendJson(res, 500, { ok: false, error: error?.message || String(error) });
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "GET" && req.url === "/api/health") {
    await handleHealth(req, res);
    return;
  }

  if (url.pathname === "/v1/models") {
    await handleOpenAIModels(req, res);
    return;
  }

  if (url.pathname === "/v1/chat/completions") {
    await handleOpenAIChatCompletions(req, res);
    return;
  }

  if (url.pathname === "/v1/images/generations") {
    await handleOpenAIImageGenerations(req, res);
    return;
  }

  if (req.method === "GET" && req.url === "/api/models") {
    await handleModels(req, res);
    return;
  }

  if (req.method === "POST" && req.url === "/api/models/refresh") {
    await handleModels(req, res);
    return;
  }

  if (req.method === "POST" && req.url === "/api/models/audit") {
    await handleModelAudit(req, res);
    return;
  }

  if (req.method === "POST" && req.url === "/api/chat") {
    await handleChat(req, res);
    return;
  }

  if (req.method === "POST" && req.url === "/api/batch") {
    await handleBatch(req, res);
    return;
  }

  if (req.method === "POST" && req.url === "/api/key-info") {
    await handleKeyInfo(req, res);
    return;
  }

  if ((req.method === "GET" || req.method === "POST") && req.url === "/api/upstream-keys") {
    await handleUpstreamKeys(req, res);
    return;
  }

  if ((req.method === "GET" || req.method === "POST") && req.url === "/api/service-keys") {
    await handleServiceKeys(req, res);
    return;
  }

  if (req.method === "GET" && req.url === "/api/outputs") {
    await handleOutputs(req, res);
    return;
  }

  if (req.method === "POST" && req.url === "/api/outputs/delete") {
    await handleDeleteOutput(req, res);
    return;
  }

  if (req.method === "GET") {
    if (req.url?.startsWith("/outputs/")) {
      await serveOutput(req, res);
      return;
    }

    await serveStatic(req, res);
    return;
  }

  sendJson(res, 405, { error: "Method not allowed" });
});

function nextBeijingAuditAt(now = new Date()) {
  const beijingNow = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const target = new Date(
    Date.UTC(
      beijingNow.getUTCFullYear(),
      beijingNow.getUTCMonth(),
      beijingNow.getUTCDate(),
      MODEL_AUDIT_HOUR_BEIJING,
      MODEL_AUDIT_MINUTE_BEIJING,
      0,
      0
    )
  );
  if (beijingNow.getTime() >= target.getTime()) target.setUTCDate(target.getUTCDate() + 1);
  return target.getTime() - 8 * 60 * 60 * 1000;
}

function scheduleDailyModelAudit() {
  const delay = Math.max(1000, nextBeijingAuditAt() - Date.now());
  const timer = setTimeout(async () => {
    try {
      console.log("Running scheduled model availability audit...");
      await auditModelAvailability({ maxProbes: MODEL_AUDIT_MAX_PROBES, refresh: true });
    } catch (error) {
      console.warn(`Scheduled model availability audit failed: ${error?.message || error}`);
    } finally {
      scheduleDailyModelAudit();
    }
  }, delay);
  timer.unref?.();
}

clearTransientOpenRouterKeyLimits();
resetExpiredOpenRouterKeyLimits();
scheduleDailyModelAudit();

server.listen(PORT, () => {
  console.log(`OpenRouter free models gateway running at http://localhost:${PORT}`);
});
