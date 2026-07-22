# GitHub Copilot App

OpenCodex can act as an **OpenAI-compatible model provider** for the GitHub Copilot
desktop app (Settings → Model providers). This is a client integration: Copilot App
calls OpenCodex; it is separate from the experimental upstream `github-copilot`
provider that uses a Copilot subscription as a backend.

## Requirements

1. OpenCodex proxy running locally (`ocx start` / `ocx gui`).
2. At least one configured provider with models (dashboard → Providers).
3. GitHub Copilot desktop app with **Model providers** support.

## Setup

1. Start OpenCodex and confirm health:

   ```bash
   curl http://127.0.0.1:10100/healthz
   curl http://127.0.0.1:10100/v1/models
   ```

2. In GitHub Copilot App: **Settings → Model providers → Add provider**.

3. Configure:

   | Field | Value |
   | --- | --- |
   | Name | `OpenCodex Gateway` (any label) |
   | Base URL | `http://127.0.0.1:10100/v1` |
   | API key | leave blank on loopback; for non-loopback binds use `OPENCODEX_API_AUTH_TOKEN` |

4. Sync models from the endpoint, or add a model by id (`provider/model`, e.g.
   `anthropic/claude-sonnet-4-6`).

5. Select a synced model and chat.

## Endpoints used

| Method | Path | Role |
| --- | --- | --- |
| `GET` | `/v1/models` | Model discovery (OpenAI list shape) |
| `POST` | `/v1/chat/completions` | Chat turns (stream + non-stream) |

OpenCodex translates Chat Completions into its internal Responses path, so all
existing providers, routing, OAuth, and sidecars apply.

## Troubleshooting

- **No models configured** — ensure the proxy is up, base URL ends with `/v1`
  (not `/v1/chat/completions`), and `GET /v1/models` returns a non-empty `data`
  array. Add/enable providers in the OpenCodex dashboard, then sync again.
- **401** — remote (non-loopback) binds require an admission token as
  `Authorization: Bearer …` or `x-opencodex-api-key`.
- **404 on chat** — older OpenCodex builds lacked `/v1/chat/completions`; upgrade
  to a build that includes this surface.
- **Model ids with `/`** — prefer the namespaced `provider/model` form returned
  by `/v1/models`. If a client rejects slashes, add the model by an alias id you
  control or open an issue for slash-safe aliases.
