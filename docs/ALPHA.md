# Alpha Acceptance

This alpha is a local-only console for internal use. It does not expose the Phase 2 OpenAI-compatible gateway endpoints yet, and API keys stay in browser localStorage.

## Scope

- Chat with a selected free text model.
- Generate image batches with a selected free image model.
- Manage a local API key pool with per-key concurrency, daily-limit skipping, quota metadata, and local charged-request counting.
- Browse, search, open, and delete locally saved output images.
- Browse, search, export, and clear local activity records.
- Export/import non-sensitive browser data. API keys are excluded from backups.
- Discover OpenRouter free models and cache request-derived model health locally.

## Local Checks

Run these before calling a build alpha-ready:

```powershell
npm run check
git diff --check
rg -n "sk-or-v1-[A-Za-z0-9_-]+" -S . -g "!outputs/**" -g "!node_modules/**" -g "!.git/**" -g "!data/**"
```

With the server running:

```powershell
npm start
Invoke-WebRequest -UseBasicParsing http://localhost:3000/api/health
```

The health response should return `ok: true`, `phase: "local-console-alpha"`, default model IDs, local storage directory status, and cached model counts. It does not call OpenRouter and does not use API keys.

## Browser Smoke Test

- Open `http://localhost:3000`.
- Confirm the top tabs render: chat, image generation, key pool, model management, image gallery, activity log, and local data.
- Add fake keys on a separate origin such as `http://127.0.0.1:3000` when testing UI only, so real `localhost` localStorage is not touched.
- Confirm key pool rows show account type, total quota, remaining quota, locally counted usage, status, and actions aligned in one table.
- Confirm empty states render for image gallery and activity log without API keys.
- Confirm local data export/import controls are visible and state text says backups do not include API keys.

## Known Alpha Limits

- Free-model availability and behavior can change on OpenRouter without notice.
- Remaining free-model quota is response-header driven when available and locally estimated otherwise.
- Real model smoke tests spend OpenRouter quota; use fake keys for layout checks.
- External gateway tokens, server-side key storage, per-user quotas, async jobs, and OpenAI-compatible `/v1/*` endpoints are Phase 2 work.
