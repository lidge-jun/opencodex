# Research findings — Google models listing + proxy support

> Sources: 2 spark web-research agents + direct codebase investigation (branch `cursor-fixes`).

## 1. Gemini Generative Language API (models listing)

- `models.list` exists on both `/v1/models` and `/v1beta/models`; **v1beta** carries
  preview/early models, so a model picker should use v1beta (matches the adapter, which
  already targets `${baseUrl}/v1beta/models/{model}:{method}` — src/adapters/google.ts:298).
  - 출처: https://ai.google.dev/api/models, https://ai.google.dev/gemini-api/docs/api-versions
- Auth: `x-goog-api-key: <key>` header is the documented way (also `?key=`); API keys must
  NOT go in `Authorization: Bearer` (that's OAuth-token-only).
  - 출처: https://ai.google.dev/api/, https://ai.google.dev/gemini-api/docs/oauth
- Response: `{ models: [Model], nextPageToken? }`; Model has `name` ("models/gemini-..."),
  `displayName`, `inputTokenLimit`, `outputTokenLimit`, `supportedGenerationMethods`.
  - 출처: https://ai.google.dev/api/models
- Pagination: default pageSize 50, **max 1000** → `?pageSize=1000` retrieves everything in
  one call today; only follow `nextPageToken` if present.
  - 출처: https://ai.google.dev/api/models
- Chat-capable filter: `supportedGenerationMethods` contains `"generateContent"`.
  - 출처: https://ai.google.dev/api/models

## 2. Bun fetch proxy behavior

- Bun's native fetch **automatically honors `HTTP_PROXY`/`HTTPS_PROXY` env vars** (official
  guide); first-supported version and `NO_PROXY`/lowercase behavior are undocumented.
  - 출처: https://bun.sh/docs/guides/http/proxy
- Per-request option: `fetch(url, { proxy })` — string URL, or `{ url, headers }` object
  form since Bun v1.3.4.
  - 출처: https://bun.com/blog/bun-v1.3.4
- undici `setGlobalDispatcher`/`EnvHttpProxyAgent` is irrelevant: ocx always runs on Bun
  (bin/ocx.mjs is a Node shim that execs a bundled Bun).
- **Empirically verified locally (Bun 1.3.14, scratchpad proxy-probe.ts)**: a spawned Bun
  process with `HTTP_PROXY` set routes `fetch()` through the proxy; `NO_PROXY=example.com`
  correctly bypasses it (undocumented but working); non-matching NO_PROXY still proxies.
- server.ts:2194's `Request("http://localhost/v1/responses")` is passed to
  `handleResponses()` directly (internal dispatch, no network) — env mirroring cannot
  break it. `clearModelCache` (src/model-cache.ts) is already used by tests, so the
  failure-cooldown state belongs in model-cache.ts and gets cleared by the same helper.

**Implication for issue #54**: the reporter's env simply lacks the proxy vars when ocx
launches. If ocx exposes a config `proxy` and mirrors it into `process.env.HTTP(S)_PROXY`
at startup, Bun applies it to every outbound fetch with zero call-site changes.

## 3. Codebase map (what matters for the patch)

| Site | Role |
|---|---|
| src/oauth/index.ts:193 `buildModelsRequest` | Builds /models request per provider; anthropic special-case exists; google falls into generic Bearer+`/models` branch (the bug) |
| src/codex-catalog.ts:677 `fetchProviderModels` | Parses `{ data: [...] }` only (line 716); TTL cache + stale fallback; 8s `AbortSignal.timeout`; no negative caching → repeated 8s stalls (issue #54 symptom) |
| src/codex-catalog.ts:586 `ProviderModelsApiItem` | `{ id, owned_by?, context_length?, ... }` — google Model maps cleanly: `id = name.replace(/^models\//, "")`, `context_length = inputTokenLimit` |
| src/adapters/google.ts:278–299 | `googleMode` discriminator: `"vertex"`, `"cloud-code-assist"`, default **ai-studio** already uses `/v1beta` + `x-goog-api-key` — the models-listing fix must key on the same predicate, NOT bare `adapter === "google"` |
| src/providers/registry.ts:293–295 | `google` (key auth), `google-vertex` (`googleMode: "vertex"`), `google-antigravity` (`googleMode: "cloud-code-assist"`, OAuth, static models) — the latter two must keep current behavior |
| src/server.ts:367,555 | Upstream dispatch: `fetchWithHeaderTimeout` OR adapter-custom `fetchResponse` — fetch call sites are scattered (oauth/*, adapters, catalog), so per-callsite proxy threading is invasive; env-mirror approach wins |
| src/config.ts:177 `loadConfig` | Config load entry; `OcxConfig` (src/types.ts:221) holds global options (`hostname`, `connectTimeoutMs`, ...) — natural home for `proxy?: string` |
| src/doctor.ts:76 | Already *reports* proxy env keys; extend to show config-sourced proxy |
| tests/codex-catalog.test.ts:16,272 | Mocks by swapping `globalThis.fetch`; no cache-reset helper — negative cache must be keyed/scoped so tests stay isolated |

## Decisions locked

1. **Fix A predicate**: `prov.adapter === "google" && (prov.googleMode ?? "ai-studio") === "ai-studio"` — shared helper used by both `buildModelsRequest` and the response parser.
2. **Fix A endpoint**: `${baseUrl}/v1beta/models?pageSize=1000`, header `x-goog-api-key`; parse `{ models }`, filter `generateContent`, map `inputTokenLimit` → `context_length`.
3. **Fix B mechanism**: `OcxConfig.proxy?: string` → at startup mirror into `process.env.HTTP_PROXY`/`HTTPS_PROXY` (only when not already set) + default `NO_PROXY` additions (`localhost,127.0.0.1`); Bun handles the rest globally. No per-callsite changes.
4. **Fix B UX**: negative-result cooldown in `fetchProviderModels` (skip live refetch for ~30s after a failure, serve stale/configured) to kill the repeated 8s UI stall.
