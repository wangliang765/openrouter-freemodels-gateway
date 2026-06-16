# OpenRouter Free Models Gateway

A local OpenRouter free-model console for chat, image generation, API key pooling, and model discovery. The current default chat model is `nvidia/nemotron-3-ultra-550b-a55b:free`; the default image model is `sourceful/riverflow-v2.5-pro:free`.

## Run

```powershell
npm start
```

Open http://localhost:3000.

Local alpha checks:

```powershell
npm run check
Invoke-WebRequest -UseBasicParsing http://localhost:3000/api/health
```

## Usage

- Add one or more OpenRouter API keys in `key池管理` before chatting or generating images.
- Use `聊天` for text models, `生图` for image models, `模型管理` for OpenRouter free-model discovery, and `key池管理` for API key management.
- Use `图片库` to search, review, or delete recently saved images from the local `outputs/` directory.
- Use `运行记录` to review local chat/image attempts, search/filter success/failure/limit states, export all records or the current filtered view as JSON, or clear local activity history.
- Use `本地数据` to export or import current settings, local prompt templates, model cache, chat history, and activity logs. Backups do not include API keys.
- OpenRouter API keys in `key池管理` are saved server-side in `data/openrouter-api-keys.json` and are shared by the web UI and `/v1` API.
- `OPENROUTER_API_KEYS` / `OPENROUTER_API_KEY` are still supported as environment-managed upstream keys.
- `模型管理` refreshes OpenRouter `/api/v1/models`, filters free models, separates text and image models, and can copy model IDs for testing.
- Model metadata and request-derived health status are cached in local `data/model-cache.json`; this file is ignored by git.
- Chat and image generation both use the selected model from the page dropdowns.
- Running chat requests can be stopped manually from the page.
- Selected models and task parameters are saved in browser localStorage and restored after refresh.
- The image generation page supports uploading any number of reference images for image-to-image/editing requests; reference images are kept in memory for the current page session and are not saved in templates or local backups.
- `Per-key concurrency` is applied to every active key. For example, 4 keys with concurrency 2 can run up to 8 tasks at once.
- When a key hits `free-models-per-day`, it is marked `daily-limited` and skipped for the rest of the batch.
- Daily-limited keys are stored with a reset timestamp and automatically return to ready after the next Beijing 08:00 reset.
- `Refresh quota` calls OpenRouter `/api/v1/key`; request results also read `X-RateLimit-*` headers when OpenRouter returns them, with local estimation used as a fallback.
- The key pool shows whether remaining quota came from response headers, local estimation, or account inference, and reset times are shown in Beijing time.
- The key pool also tracks locally counted charged model requests from 0 after the daily reset, so real free-model usage can be compared against OpenRouter's inferred total.
- Daily-limited keys can be manually unlocked from key pool management if the local limit mark is stale after reset.
- `Rate limited` responses are not retried on the same key. The task is returned to the queue and assigned to another active key.
- `Queue mode` forces each key to run one request at a time and waits between tasks.
- `Retry count` and `Wait seconds` control automatic retry for network interruptions, timeouts, and temporary 5xx errors.
- Running image batches can be stopped manually from the page; unfinished cards are marked as stopped.
- Successful base64 images are saved to the local `outputs/` directory and shown in the result card.
- The local image gallery lists and searches the latest saved output images without requiring API keys, and can delete selected local files.
- Prompt templates are saved in browser localStorage and do not store API keys.
- Runtime activity logs are saved in browser localStorage and store only masked key labels, model IDs, status, timing, errors, and saved output paths.
- Local data backups are JSON files for non-sensitive localStorage data only; API keys must be added again on another browser or computer.

## OpenAI-compatible API MVP

The service also exposes a local OpenAI-compatible API under `/v1` for other apps:

- `GET /v1/models`
- `POST /v1/chat/completions`
- `POST /v1/images/generations`

Configure the upstream OpenRouter key set in `key池管理`, or via environment variables:

```powershell
$env:OPENROUTER_API_KEYS="sk-or-v1-...,sk-or-v1-..."
npm start
```

- `OPENROUTER_API_KEYS` are optional environment-managed upstream OpenRouter keys used by the gateway.
- Service API keys accepted by this gateway can be created in `key池管理` -> `对外服务 API Key`.
- `GATEWAY_API_KEYS` / `GATEWAY_API_KEY` are still supported for environment-managed service keys.
- `DEFAULT_SERVICE_KEY_CONCURRENCY` controls per service-key image concurrency. Default: `4`.
- `DEFAULT_IMAGE_N` controls the default image count when `/v1/images/generations` omits `n`. Default: `20`.
- `MAX_IMAGE_N` controls the maximum accepted `n`. Default: the configured default image count.
- In OpenAI image requests, `n` means image count, not concurrency.

Example:

```powershell
Invoke-RestMethod `
  -Method Post `
  -Uri http://localhost:3000/v1/images/generations `
  -Headers @{ Authorization = "Bearer local-dev-key" } `
  -ContentType "application/json" `
  -Body '{"model":"gpt-image-local","prompt":"a glass teapot on a walnut table","n":2,"response_format":"url"}'
```

## Roadmap

See `docs/ROADMAP.md` for the local-console phase and the future OpenAI-compatible API gateway phase.
See `docs/ALPHA.md` for the current local alpha scope and acceptance checks.
