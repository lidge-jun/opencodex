# 140.10 — Phase 1: google-vertex (extend `google`, MEDIUM)

> One PABCD pass. Extends the existing `google` adapter — **no new adapter id**. Establishes the
> `googleMode` config-branch hook reused by Phase 20. Grounded in jawcode (cites are jawcode paths).
>
> External cross-check: `router-for-me/CLIProxyAPI` Vertex executor/auth — see `05_reference-repos.md`.

---

## Goal

Let opencodex stream Gemini via **Vertex AI** (project/location endpoints + GCP auth) by reusing the
existing `google` adapter's SSE parser and message conversion — adding only a mode branch + a GCP token resolver.

## What we port (jawcode)

- **Auth — ADC resolver** (`google-auth.ts:64-246`, ~180 LOC, pure TS + WebCrypto, no Node deps):
  - sources (priority): `GOOGLE_APPLICATION_CREDENTIALS` (service_account RS256 JWT exchange `:102-139`, or authorized_user refresh `:141-153`) → `~/.config/gcloud/application_default_credentials.json` → GCE metadata server (`:155-172`).
  - token cache + 60s refresh skew (`:56-58`) + inflight-promise dedup (`:54,230-245`).
- **URL templates** (`google-vertex.ts:38-51,79-81`): ADC → `https://{location}-aiplatform.googleapis.com/v1/projects/{project}/locations/{location}/publishers/google/models/{model}:streamGenerateContent?alt=sse`; `location==="global"` → `aiplatform.googleapis.com`; API-key path → `x-goog-api-key`.
- **Body:** unchanged — Vertex reuses the same Gemini params (`messagesToGeminiFormat`); opencodex `google.ts:16-67` is line-for-line equivalent to jawcode `google-shared.ts:convertMessages`. **No new wire.**

## opencodex fit

- **Config** (`src/types.ts` `OcxProviderConfig`): add `googleMode?: "ai-studio" | "vertex"`, `project?`, `location?`.
- **Adapter** (`src/adapters/google.ts createGoogleAdapter`): branch `buildRequest` on `googleMode` (default `"ai-studio"` → backward compatible). Vertex branch builds the project/location URL + resolves the ADC Bearer (or `x-goog-api-key`). `parseStream` **unchanged** (mode-agnostic SSE, `google.ts:120-184`).
- **Dispatch** (`src/server.ts:186 resolveAdapter`): **no new case** — stays `google`.
- **Models:** seed ~13 Vertex Gemini ids in the registry.
- **NEW file:** `src/lib/gcp-adc.ts` (the ported ADC resolver).

## Sub-steps (this PABCD pass)

1. **A:** port `google-auth.ts` → `src/lib/gcp-adc.ts` (JWT RS256 sign, file/env/metadata sources, cache+skew+dedup). Unit-test JWT signature + cache refresh (mocked token endpoint + time).
2. **B:** add `googleMode`/`project`/`location` to config; extend `createGoogleAdapter` with the vertex branch (URL + auth); leave `parseStream` + `resolveAdapter` untouched.
3. **B:** seed the 13 models + a config example.
4. **C:** mocked integration (ADC → token → buildRequest → parseStream → done) + API-key fallback + location→host mapping; existing AI-Studio google tests still green; `tsc`/`bun test`.

## Risks

| Risk | Mitigation |
|------|------------|
| JWT RS256 signing bug → 401 | use WebCrypto; unit-test signature shape vs a known sample |
| token refresh race | inflight-promise dedup (jawcode `:230-245`); test parallel callers |
| location→host mismatch → 404 | hardcode the jawcode mapping; test global + regional |
| AI-Studio regression | default `googleMode:"ai-studio"`; assert existing configs unchanged |

## Verify (minimal proof)

Stream one prompt with ADC; compare SSE parts to a jawcode golden (`02:216`). API-key path also streams.

## Depends-on / enables

- **Depends-on:** none (ships first).
- **Enables:** the `googleMode` hook reused by Phase 20 (antigravity).
