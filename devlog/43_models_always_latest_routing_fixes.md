# Phase 8 — Always-latest models + two blocking routing/400 fixes

Three independent defects surfaced together: `codex exec` with a Claude model 400'd, the Anthropic
list was frozen on deprecated snapshots, and `grok-composer-2.5-fast` never appeared. All three are
fixed; verified live end-to-end (`codex exec -m anthropic/claude-opus-4-6` → clean reply).

## Bug 1 — Anthropic extended-thinking 400 (BLOCKING)
`src/adapters/anthropic.ts` set `max_tokens` and `thinking.budget_tokens` to the **same** value
(`maxOutputTokens ?? 8192`). Anthropic requires `max_tokens > budget_tokens` (max_tokens caps
thinking **+** visible output), so every reasoning request 400'd:
```
`max_tokens` must be greater than `thinking.budget_tokens`
```
Also unhandled: extended thinking rejects `temperature != 1` and `top_p`.

**Fix:** map the Responses reasoning effort → a thinking budget, then size `max_tokens` to exceed it
within a model-safe ceiling (32k), reserving output headroom; drop `temperature`/`top_p` when thinking
is on.
```
budget   = reasoningBudget(effort)            // minimal 1024 … max 32000
maxTokens = min(32000, max(maxOut, budget+8192))
budget   = max(1024, min(budget, maxTokens-4096))   // guarantees max_tokens > budget >= 1024
```

## Bug 2 — `codex exec` ignored the proxy (provider: openai)
`src/codex-inject.ts` appended the bare root key `model_provider = "opencodex"` at **EOF**. By then a
`[table]` is open (observed: `[plugins."chrome@openai-bundled"]`), so TOML parsed it as
`plugins."chrome@openai-bundled".model_provider` — never the global. Codex fell back to the `openai`
(ChatGPT) provider and rejected routed models:
```
The 'anthropic/claude-opus-4-6' model is not supported when using Codex with a ChatGPT account.
```
**Fix:** split injection — the bare `model_provider` key is inserted at the document **root** (before
the first table header) via `setRootModelProvider()`; only the `[model_providers.opencodex]` **table**
is appended at EOF (tables are position-independent). `stripExistingModelProvider()` cleans any prior
mis-nested/duplicate key for idempotent re-injection.

## Bug 3 — stale Anthropic list + missing grok-composer (always-latest)
Two causes:
1. **Wrong endpoint.** `fetchProviderModels`/`fetchAllModels` hit `${baseUrl}/models` with a bare
   `Bearer`. Anthropic's endpoint is `/v1/models` and needs `anthropic-version` + the OAuth beta
   (or `x-api-key`). It always 404'd → silently fell back to the static (deprecated) list. New shared
   `buildModelsRequest(prov, apiKey)` returns the adapter-correct URL+headers. Anthropic's
   `GET /v1/models` works with the Claude OAuth token (verified: returns `claude-opus-4-6/4-7/4-8`,
   `claude-sonnet-4-6`, `claude-fable-5`, …) — true always-latest.
2. **Registry edits didn't reach existing configs.** The grok-composer commit updated the OAuth
   registry, but `~/.opencodex/config.json` is written once at login, so `ocx start` kept the old
   models. New `reconcileOAuthProviders(config)` (run in `startServer`) refreshes OAuth-managed
   presets (`models`/`noReasoningModels`, and heals a dead `defaultModel`) from the registry on start.
   `grok-composer-2.5-fast` is not in xAI's `/v1/models`, so it relies on this static merge.

Registry Anthropic defaults bumped to current dateless ids; `OcxConfig.modelCacheTtlMs` added (typed
the field the model-cache resolver already read).

## Files
- `src/adapters/anthropic.ts` — reasoning budget sizing + temp/top_p drop
- `src/codex-inject.ts` — root-level `model_provider`, idempotent strip/insert
- `src/oauth/index.ts` — `buildModelsRequest`, `reconcileOAuthProviders`, current Anthropic defaults
- `src/codex-catalog.ts`, `src/server.ts` — use `buildModelsRequest`; reconcile on start
- `src/types.ts` — `modelCacheTtlMs`

## Verified
- `POST /v1/responses` model=`anthropic/claude-opus-4-6` reasoning=medium → reply, thinking summary,
  no 400.
- `codex exec -m anthropic/claude-opus-4-6` → `provider: opencodex`, reasoning high, clean reply.
- `/v1/models`: 9 live Anthropic ids incl. `claude-opus-4-6`; `xai/grok-composer-2.5-fast` present.
- grok-composer reasoning request → param dropped, no 400. `tsc` clean.
</content>
