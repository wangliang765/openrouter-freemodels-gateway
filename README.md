# OpenRouter Free Models Gateway

A local batch image-generation app for OpenRouter free image models. The current default model is `sourceful/riverflow-v2.5-pro:free`.

## Run

```powershell
npm start
```

Open http://localhost:3000.

## Usage

- Add one or more OpenRouter API keys in the page key pool before starting a batch.
- Use the `生图` view for generation and `key池管理` for API key management.
- API keys in the page key pool are saved in browser localStorage and remain after refresh.
- The app only uses keys currently shown in the page key pool. `.env` is not used as a fallback.
- `Per-key concurrency` is applied to every active key. For example, 4 keys with concurrency 2 can run up to 8 tasks at once.
- When a key hits `free-models-per-day`, it is marked `daily-limited` and skipped for the rest of the batch.
- Daily-limited keys are stored with a reset timestamp and automatically return to ready after the next Beijing 08:00 reset.
- `Refresh quota` calls OpenRouter `/api/v1/key`; free-model daily total is inferred from account tier, and remaining count is locally estimated when OpenRouter does not expose it.
- `Rate limited` responses are not retried on the same key. The task is returned to the queue and assigned to another active key.
- `Queue mode` forces each key to run one request at a time and waits between tasks.
- `Retry count` and `Wait seconds` control automatic retry for network interruptions, timeouts, and temporary 5xx errors.
- Successful base64 images are saved to the local `outputs/` directory and shown in the result card.
- Prompt templates are saved in browser localStorage and do not store API keys.
