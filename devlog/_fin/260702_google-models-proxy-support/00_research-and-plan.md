# Google models listing + outbound proxy support — research & plan

> Status: PABCD cycle CLOSED (P→A→B→C→D). Findings: `01_research-findings.md`;
> build + gates: `10_build-record.md`. Working tree holds the patch, uncommitted
> (commit split deferred — see 10_build-record "Known constraint").
> Goal mode: gates advanced on evidence (user set /goal).
> Branch: stacked on `cursor-fixes`.
> Drivers: PR #55 (broken but right idea) + issue #54 (slow/failing model loads behind proxy).

## Problem statement

Two related failures in provider model listing, to be fixed together in one patch stack:

**(A) Google Gemini models never appear** in the dashboard / Codex model picker.
`buildModelsRequest` (src/oauth/index.ts:193) sends `Authorization: Bearer` to
`${baseUrl}/models`, but the Generative Language API wants `x-goog-api-key` and returns
`{ models: [{ name: "models/..." }] }`, not OpenAI's `{ data: [{ id }] }`.
PR #55 attempts this but is unmergeable:

- Syntax error (template literal without backticks) in src/oauth/index.ts — does not compile.
- Branches on `prov.adapter === "google"`, which also captures `google-vertex` and
  `google-antigravity` (registry.ts:293–295); antigravity is OAuth and would lose its
  `Authorization: Bearer` header → its /models fetch breaks.
- Uses `/v1/models`; the API's standard surface is `/v1beta/models` (v1 misses newer models).
- No pagination handling (default pageSize 50).

**(B) No outbound proxy support** (issue #54). Users behind corporate proxies see
models/subagents pages hang: every provider `/models` fetch runs the full
`AbortSignal.timeout(8000)` (src/codex-catalog.ts:711) before failing. Nothing in src/
applies HTTP_PROXY/HTTPS_PROXY (only src/doctor.ts:76 *reports* them). Key runtime fact:
**ocx always runs on Bun** — the npm `bin/ocx.mjs` is a Node shim that execs a bundled Bun
(see bin/ocx.mjs header comment). So any proxy fix must work with *Bun's* fetch;
undici `setGlobalDispatcher`/`EnvHttpProxyAgent` does not apply.

## Research dispatched (3 parallel spark agents, read-only)

1. **Gemini models API facts** — v1beta vs v1, x-goog-api-key vs ?key= vs Bearer,
   response schema fields, pagination (pageSize/pageToken), chat-capable filtering
   (`supportedGenerationMethods` ∋ `generateContent`).
2. **Bun fetch proxy behavior** — does Bun honor HTTP(S)_PROXY/NO_PROXY env automatically
   (since which version), per-request `fetch(url, { proxy })` option, global default
   options, undici non-applicability.
3. **Codebase map** — all provider-bound fetch call sites, config schema location for a
   global `proxy` option, existing `adapter === "google"` special-casing, test files +
   fetch mocking pattern.

Findings land in `01_research-findings.md` when agents report back.

## Plan draft (to be firmed up with findings)

### Fix A — Google models listing (supersedes PR #55)

- `src/oauth/index.ts` `buildModelsRequest`: add a branch keyed on the **Generative
  Language API** case specifically (adapter `google` AND key-auth AND non-vertex,
  non-cloud-code-assist `googleMode`) — NOT bare `adapter === "google"`. Send
  `x-goog-api-key`, target `/v1beta/models` with a large `pageSize` (+ `pageToken` loop
  if research confirms it's needed).
- `src/codex-catalog.ts` `fetchProviderModels`: parse `{ models: [...] }` shape —
  strip `models/` prefix for ids, map `displayName`, filter to
  `supportedGenerationMethods` containing `generateContent`, use
  `inputTokenLimit`/`outputTokenLimit` for context hints if the catalog supports it.
  Keyed on the same predicate as the request builder (shared helper, not duplicated
  string checks).
- Tests: extend the existing google-adapter/catalog test files with the new response
  fixture; add a regression test that `google-antigravity` (OAuth) still sends
  `Authorization: Bearer`.

### Fix B — outbound proxy support (issue #54)

- Depends on research: if Bun's fetch already honors HTTP(S)_PROXY env, the gap is
  config/UX (users launch ocx without the env). Then: add a global `proxy` config option
  (and/or read env as fallback), thread it into provider fetch call sites via Bun's
  per-request `proxy` init option through one shared helper.
- Secondary UX: failed provider fetches should not stall the UI for the full 8s
  repeatedly — consider a short negative-result cache in `fetchProviderModels`.
- `src/doctor.ts` proxy section: report whether the configured/env proxy is actually
  being applied.

### Sequencing

One logical commit per fix on top of `cursor-fixes`:
1. `fix(google): list Generative Language models via x-goog-api-key + v1beta` (closes the
   PR #55 use case; comment on PR #55 that it's superseded, credit the approach)
2. `feat(net): outbound proxy support for provider fetches` (closes #54 with the
   negative-cache follow-up noted)

### Open questions for user

- PR #55: close as superseded (with credit) vs. ask author to fix? (default: supersede,
  leave a review comment)
- Global proxy config: env-only vs. config-file option? (default: both, config wins)

## Verification plan

- `bun x tsc --noEmit` + `bun test ./tests/` green.
- Manual: `ocx start` with a real Gemini API key → google models visible in catalog;
  with `HTTPS_PROXY` set to a local mitm/dummy → provider fetches route through it.
