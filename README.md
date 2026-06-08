# OpenRouter Free Models Gateway

A local OpenRouter free-model console for chat, image generation, API key pooling, and model discovery. The current default chat model is `nvidia/nemotron-3-ultra-550b-a55b:free`; the default image model is `sourceful/riverflow-v2.5-pro:free`.

## Run

```powershell
npm start
```

Open http://localhost:3000.

## Usage

- Add one or more OpenRouter API keys in `key池管理` before chatting or generating images.
- Use `聊天` for text models, `生图` for image models, `模型管理` for OpenRouter free-model discovery, and `key池管理` for API key management.
- API keys in the page key pool are saved in browser localStorage and remain after refresh.
- The app only uses keys currently shown in the page key pool. `.env` is not used as a fallback.
- `模型管理` refreshes OpenRouter `/api/v1/models`, filters free models, and separates text and image models.
- Model metadata and request-derived health status are cached in local `data/model-cache.json`; this file is ignored by git.
- Chat and image generation both use the selected model from the page dropdowns.
- `Per-key concurrency` is applied to every active key. For example, 4 keys with concurrency 2 can run up to 8 tasks at once.
- When a key hits `free-models-per-day`, it is marked `daily-limited` and skipped for the rest of the batch.
- Daily-limited keys are stored with a reset timestamp and automatically return to ready after the next Beijing 08:00 reset.
- `Refresh quota` calls OpenRouter `/api/v1/key`; free-model daily total is inferred from account tier, and remaining count is locally estimated when OpenRouter does not expose it.
- `Rate limited` responses are not retried on the same key. The task is returned to the queue and assigned to another active key.
- `Queue mode` forces each key to run one request at a time and waits between tasks.
- `Retry count` and `Wait seconds` control automatic retry for network interruptions, timeouts, and temporary 5xx errors.
- Successful base64 images are saved to the local `outputs/` directory and shown in the result card.
- Prompt templates are saved in browser localStorage and do not store API keys.

## Roadmap

See `docs/ROADMAP.md` for the local-console phase and the future OpenAI-compatible API gateway phase.
