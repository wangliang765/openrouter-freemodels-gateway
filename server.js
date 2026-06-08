import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
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
    // A local .env file is optional.
  }
}

loadLocalEnv();

const PORT = Number(process.env.PORT || 3000);
const MODEL = "sourceful/riverflow-v2.5-pro:free";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const PUBLIC_DIR = join(process.cwd(), "public");
const OUTPUT_DIR = join(process.cwd(), "outputs");
const CURL_COMMAND = process.platform === "win32" ? "curl.exe" : "curl";

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

function buildPrompts({ prompt, promptList, count }) {
  const parsedList = String(promptList || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (parsedList.length) return parsedList;

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
  const sourceKeys = Array.isArray(body.apiKeys)
    ? body.apiKeys
    : String(body.apiKey || "")
        .split(/[\r\n,;]+/)
        .map((key) => key.trim());

  return [...new Set(sourceKeys.map((key) => key.trim()).filter(Boolean))];
}

function createKeyPool(apiKeys) {
  const keys = apiKeys.map((key, index) => ({
    id: index,
    key,
    label: maskApiKey(key),
    status: "active",
    error: ""
  }));
  let pointer = 0;

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

  function hasActiveKeys() {
    return activeKeys().length > 0;
  }

  return { activeKeys, hasActiveKeys, nextActiveKey, markDailyLimited, markRateLimited, snapshot };
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

function buildImageConfig({ aspectRatio, imageSize }) {
  const imageConfig = {};
  if (aspectRatio && aspectRatio !== "auto") imageConfig.aspect_ratio = aspectRatio;
  if (imageSize && imageSize !== "auto") imageConfig.image_size = imageSize;
  return Object.keys(imageConfig).length ? imageConfig : undefined;
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

async function generateImage({ prompt, options, apiKey, signal }) {
  apiKey = String(apiKey || "").trim();
  if (!apiKey) {
    throw new Error("Missing API key. Add at least one key to the page key pool.");
  }

  const imageConfig = buildImageConfig(options || {});
  const requestBody = {
    model: MODEL,
    messages: [{ role: "user", content: prompt }],
    modalities: ["image"]
  };

  if (imageConfig) requestBody.image_config = imageConfig;

  const { status, text } = await requestOpenRouter({
    apiKey,
    signal,
    body: requestBody
  });

  const data = parseJsonResponse(text);

  if (status < 200 || status >= 300) {
    const detail = data?.error?.message || data?.message || text || "Request failed";
    throw new Error(`OpenRouter ${status}: ${detail}`);
  }

  const images = extractImages(data);
  const textContent = data?.choices?.[0]?.message?.content || "";
  if (!images.length) {
    const reason = data?.choices?.[0]?.finish_reason ? ` finish_reason=${data.choices[0].finish_reason}.` : "";
    throw new Error(textContent || `OpenRouter returned no image URLs for this request.${reason}`);
  }

  const savedImages = await saveImages(images);

  return {
    images: savedImages.map((image) => image.url),
    originalImages: savedImages.map((image) => image.original),
    savedImages,
    text: textContent
  };
}

function isRateLimitError(error) {
  return String(error?.message || error).includes("OpenRouter 429:");
}

function isDailyRateLimitError(error) {
  return String(error?.message || error).includes("free-models-per-day");
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
  return message.includes("OpenRouter returned no image URLs") || /OpenRouter\s+4\d\d:/.test(message);
}

async function generateImageWithRetry({ prompt, options, keyEntry, retryMax, retryDelayMs, signal, onRetry, onKeyUse }) {
  let attempt = 0;

  while (true) {
    attempt += 1;
    onKeyUse?.(keyEntry);

    try {
      return await generateImage({ prompt, options, apiKey: keyEntry.key, signal });
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

function parseJsonResponse(text) {
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { raw: text };
  }
}

function freeDailyLimitForKeyInfo(data) {
  return data?.is_free_tier ? 50 : 1000;
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

async function requestOpenRouter({ apiKey, body, signal }) {
  const bodyPath = join(tmpdir(), `riverflow-${randomUUID()}.json`);
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
          "-o",
          "-",
          "-w",
          "\n__OPENROUTER_STATUS__:%{http_code}",
          "--max-time",
          "300"
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
        if (output && !output.trim() && /Operation timed out|server closed abruptly/i.test(errorOutput)) {
          finish(new Error("OpenRouter provider returned an empty unfinished response. No image data was received."));
          return;
        }
        finish(new Error(errorOutput || `curl exited with code ${code}`));
        return;
      }

      const text = output.slice(0, markerIndex);
      const status = Number(output.slice(markerIndex + marker.length).trim());

      if (code !== 0) {
        if (status === 200 && !text.trim() && /Operation timed out|server closed abruptly/i.test(errorOutput)) {
          finish(new Error("OpenRouter provider returned an empty unfinished response. No image data was received."));
          return;
        }
        finish(new Error(errorOutput || `curl exited with code ${code}`));
        return;
      }

        finish(null, { status, text });
      });

      const config = [
        'header = "Content-Type: application/json"',
        'header = "Accept-Encoding: identity"',
        `header = "Authorization: Bearer ${apiKey}"`,
        'header = "HTTP-Referer: http://localhost"',
        'header = "X-Title: Riverflow Batch Generator"',
        `data-binary = "@${bodyPath.replace(/\\/g, "/")}"`
      ].join("\n");

      child.stdin.end(config);
    });
  } finally {
    await unlink(bodyPath).catch(() => {});
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

async function handleBatch(req, res) {
  let body;
  try {
    body = await readJson(req);
  } catch {
    sendJson(res, 400, { error: "Invalid JSON body." });
    return;
  }

  const count = clamp(body.count ?? 4, 1, 24);
  const queueMode = body.queueMode === true;
  const perKeyConcurrency = queueMode ? 1 : clamp(body.concurrency ?? 3, 1, 8);
  const retryMax = clamp(body.retryMax ?? 3, 0, 10);
  const retryDelayMs = clamp(body.retryDelaySeconds ?? 70, 5, 600) * 1000;
  const prompts = buildPrompts({ ...body, count });
  const apiKeys = parseApiKeys(body);
  const options = {
    aspectRatio: String(body.aspectRatio || "auto"),
    imageSize: String(body.imageSize || "auto"),
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
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });

  const controller = new AbortController();
  req.on("close", () => controller.abort());

  const writeEvent = (event) => {
    res.write(`${JSON.stringify(event)}\n`);
  };

  writeEvent({
    type: "start",
    total: prompts.length,
    concurrency: perKeyConcurrency,
    totalConcurrency: keyPool.activeKeys().length * perKeyConcurrency,
    queueMode,
    retryMax,
    retryDelayMs,
    apiKeys: keyPool.snapshot(),
    model: MODEL
  });

  const pendingTasks = prompts.map((prompt, index) => ({ index, prompt }));
  let completed = 0;
  let inFlight = 0;

  await new Promise((resolve) => {
    const keyLoads = new Map(keyPool.snapshot().map((key) => [key.id, 0]));

    function finishIfDone() {
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
        const result = await generateImageWithRetry({
          prompt,
          options,
          keyEntry,
          retryMax,
          retryDelayMs,
          signal: controller.signal,
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
          if (isDailyRateLimitError(error)) keyPool.markDailyLimited(keyEntry, error);
          else keyPool.markRateLimited(keyEntry, error);
          pendingTasks.unshift(task);
          writeEvent({
            type: "key-limited",
            index,
            key: { id: keyEntry.id, label: keyEntry.label, status: keyEntry.status },
            apiKeys: keyPool.snapshot(),
            error: error?.message || String(error)
          });
        } else {
          completed += 1;
          writeEvent({
            type: "task-error",
            index,
            prompt,
            key: { id: keyEntry.id, label: keyEntry.label },
            durationMs: Date.now() - startedAt,
            charged: isChargedOpenRouterError(error),
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

  writeEvent({ type: "done", completed, total: prompts.length });
  res.end();
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

const server = createServer(async (req, res) => {
  if (req.method === "POST" && req.url === "/api/batch") {
    await handleBatch(req, res);
    return;
  }

  if (req.method === "POST" && req.url === "/api/key-info") {
    await handleKeyInfo(req, res);
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

server.listen(PORT, () => {
  console.log(`Riverflow batch app running at http://localhost:${PORT}`);
});
