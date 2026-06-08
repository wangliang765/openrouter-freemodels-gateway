# OpenRouter Free Models Gateway Roadmap

## Phase 1: Local Console

- Add top-level views for chat, image generation, key pool management, and model management.
- Pull OpenRouter model metadata from `/api/v1/models`.
- Classify free models into text and image groups.
- Let chat choose a free language model.
- Let image generation choose a free image model.
- Provide a local gallery for saved image outputs.
- Keep API keys in browser localStorage for this local-only phase.
- Persist selected models and task parameters in browser localStorage.
- Record and persist model health from real requests without spending quota on automatic probes.
- Keep a local activity log for chat/image attempts, saved output paths, and request errors.
- Support local export/import for non-sensitive browser data without including API keys.

## Phase 2: External API Gateway

- Add OpenAI-compatible endpoints:
  - `GET /v1/models`
  - `GET /v1/models/free`
  - `POST /v1/chat/completions`
  - `POST /v1/images/generations`
  - `POST /v1/gateway/generate`
  - `GET /v1/jobs/:id`
- Move API keys to server-side storage.
- Add gateway tokens for external users.
- Add per-user rate limits, daily quotas, logs, model allowlists, and async image jobs.
- Support `model: "auto"` routing to healthy free models.

## Phase 3: Ecosystem Integration

- Keep the gateway OpenAI-compatible so tools like New API or One API can use it as an upstream channel.
- Do not embed New API or One API directly unless the project needs their full user, billing, and channel-management stack.
- Consider paid fallback providers only after the free-model health and routing layer is stable.
