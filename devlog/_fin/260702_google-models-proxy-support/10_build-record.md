# Build record — Google models listing + proxy support

> PABCD: P done (00/01 docs) → A done (independent audit: NEEDS_CHANGES, all four
> corrections incorporated) → B this doc → C gates below.

## Audit corrections applied (A → B)

1. **Effective-mode helper instead of raw `prov.googleMode`** — saved key-login configs
   don't carry `googleMode` (login-cli/enrich don't copy it), so `effectiveGoogleMode()`
   backfills from the provider registry by id, mirroring router.ts's backfill.
2. **Proxy mirror covers `ocx ensure`/`ocx sync`** — `applyProxyEnv` is called in
   `startServer()` AND `syncModelsToCodex()` (catalog sync runs outside the server process).
3. **Cooldown reset via `clearModelCache`** — failure timestamps live in model-cache.ts and
   are cleared by the same helper tests already call.
4. **Google key validation fixed too** — `validateApiKey` probed Bearer+`/models`, which the
   Generative Language API rejects; now probes `/v1beta/models?pageSize=1` with
   `x-goog-api-key` (400/401/403 → invalid key; Google uses 400 for malformed keys).

## Changes

### src/model-cache.ts — failure cooldown
- **Changes**: `MODELS_FETCH_FAILURE_COOLDOWN_MS` (30s), `markModelsFetchFailure`,
  `isModelsFetchCoolingDown`; `clearModelCache` clears both maps.
- **Impact**: codex-catalog.ts; tests keep working via `clearModelCache`.
- **Verification**: tests/google-models-listing.test.ts cooldown case (fetch called once
  across two polls; clear forces refetch).

### src/providers/registry.ts — `effectiveGoogleMode(providerId, prov)`
- **Changes**: config value → registry backfill → "ai-studio"; null for non-google adapters.
- **Impact**: oauth/index.ts, codex-catalog.ts.
- **Verification**: vertex/antigravity-without-googleMode tests hit the generic branch.

### src/oauth/index.ts — `buildModelsRequest` ai-studio branch
- **Changes**: new `providerName` param (single consumer updated); ai-studio google →
  `x-goog-api-key` + `${baseUrl}/v1beta/models?pageSize=1000`.
- **Impact**: codex-catalog.ts:709 (only consumer).
- **Verification**: 4 request-shape tests incl. antigravity Bearer regression.

### src/codex-catalog.ts — google response parsing + cooldown wiring
- **Changes**: `GoogleModelsApiModel` + `googleModelsToApiItems` (strip `models/` prefix,
  filter to `generateContent`, `inputTokenLimit` → `context_length`); cooldown check before
  live fetch; `markModelsFetchFailure` on !ok/catch.
- **Impact**: dashboard + Codex model picker listings for all providers.
- **Verification**: parses fixture with chat+embedding models; embedding filtered out.

### src/oauth/key-providers.ts — google key validation probe
- **Changes**: `googleMode` added to `KeyLoginProvider` (derive already emits it); ai-studio
  google branch probes `/v1beta/models?pageSize=1` with `x-goog-api-key`.
- **Impact**: `ocx login google` key validation.
- **Verification**: tsc + suite (no dedicated test; probe mirrors the tested request shape).

### src/types.ts + src/config.ts — `OcxConfig.proxy` + `applyProxyEnv`
- **Changes**: `proxy?: string` (passthrough schema keeps it); `applyProxyEnv` mirrors into
  HTTP(S)_PROXY when unset (user env wins), appends `localhost,127.0.0.1` to NO_PROXY,
  resolves `${VAR}` references via `resolveEnvValue`.
- **Impact**: all outbound fetches in the server/sync processes (Bun env-proxy, empirically
  verified incl. NO_PROXY on Bun 1.3.14).
- **Verification**: tests/proxy-env.test.ts (5 cases: no-op, mirror, env-wins, NO_PROXY
  dedup/append, ${VAR}).

### src/server.ts + src/cli.ts — applyProxyEnv call sites
- **Changes**: `startServer()` right after `loadConfig()`; `syncModelsToCodex()` for
  `ocx ensure`/`ocx sync` parent-process catalog fetches.
- **Impact**: server daemon + CLI catalog sync.
- **Verification**: full suite green.

## Gates (C)

- `bun x tsc --noEmit` — zero errors.
- `bun test ./tests/` — **1237 pass / 0 fail** (126 files), including 11 new tests.
- **E2E smoke (real server, stub proxy, no real network)** — PASS: started `ocx` with a temp
  `OPENCODEX_HOME` whose config sets only `proxy` + a google provider on a fake host; the
  models request arrived at the stub proxy in absolute-form
  (`http://google-stub.test/v1beta/models?pageSize=1000`, `x-goog-api-key` sent), proving
  `applyProxyEnv` ran at `startServer`; `/v1/models` listed `gemini-3-pro` and filtered the
  embedding model; other providers' traffic (chatgpt CONNECT) also routed via the proxy.
- Self-review of the full diff: pre-existing cursor-branch hunks in codex-catalog.ts are
  untouched; fixed one stale doc comment above `buildModelsRequest` ({ data } "for both").
- Independent diff verification dispatched (gpt-5.5 xhigh, read-only) — still running in a
  background Codex session at D-close; verdict to be appended here when it lands. The cycle
  closes on the A-phase independent audit + full gates + E2E evidence above; a NEEDS_FIX
  verdict, if any, becomes a follow-up patch.

## Known constraint for commit split

`src/codex-catalog.ts` carries pre-existing uncommitted cursor work on this branch alongside
this patch's hunks — a clean two-commit split of THIS work requires either committing the
cursor work first or hunk-level staging. Deferred to the user (no proactive git actions).

## Scoped out (follow-ups)

- `ocx doctor`: could additionally report whether config.proxy is applied (env presence
  rows already exist at src/doctor.ts:76).
- oauth login flows don't call `applyProxyEnv` (login fetches to provider auth endpoints
  behind a proxy) — separate slice if requested.
- `nextPageToken` loop unnecessary today (pageSize cap 1000 ≥ total models).
- PR #55: supersede with credit once merged; issue #54: config `proxy` + cooldown answer
  both reported symptoms.
