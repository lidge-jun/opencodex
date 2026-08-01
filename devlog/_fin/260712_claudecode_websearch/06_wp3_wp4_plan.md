# WP3 + WP4 combined plan (diff-level) — parallel workers

Phase P. Two disjoint units implemented by parallel sol workers under one PABCD
cycle. Grounded in Gauss (WP3) + Godel (WP4) read-only scoping.

## WP3 — Claude-inbound sidecar auth reachability (worker A)

Write scope: src/server/claude-messages.ts + tests/claude-messages-endpoint.test.ts.
Out of scope: the native passthrough branch (leave byte-for-byte unchanged).

Problem (Gauss-verified): on a Claude-inbound request routing to a NON-forward
provider, claude-messages.ts strips caller authorization (lines 329-331) and
injects main ChatGPT auth ONLY inside `if (nativeRoute)` (335-343). So routed
replays carry no authorization; planWebSearch/planVisionSidecar bail
(auth-context.ts:79 -> kind "main"; gates at vision/index.ts:78 + web-search
openai gate). Images strip.

Diff: after the FORWARD_HEADERS copy loop, BEFORE the existing `if (nativeRoute)`
block, add a routed-only fallback:
```
if (!nativeRoute) {
  const { getMainAccountToken } = await import("../codex/main-account");
  const token = getMainAccountToken();
  if (token) {
    headers.set("authorization", `Bearer ${token.accessToken}`);
    headers.set("chatgpt-account-id", token.chatgptAccountId);
  }
}
```
Native block unchanged. x-codex-parent-thread-id already forwarded, so
resolveCodexAuthContext still upgrades to pool/main-pool when a pool account is
selected (pool wins over the fallback).

Acceptance: new endpoint test in tests/claude-messages-endpoint.test.ts (beside
the native-auth test ~line 145) — isolated auth.json, a forward openai-responses
provider + a non-forward text-only routed provider; a Claude request with a
web_search tool AND an image asserts (a) forward mock receives main authorization
+ chatgpt-account-id, (b) web-search sidecar runs, (c) vision sidecar runs and
REPLACES the image (not stripped); plus a companion no-ChatGPT-login request
staying fail-closed. Keep tests/claude-native-passthrough.test.ts green.

Risk: routed-path sidecars now consume the main ChatGPT account (intended
billing/attribution change). getMainAccountToken checks presence not expiry —
matches existing native behavior; acceptable.

## WP4 — Claude vision executor + cap + cache (worker B)

Write scope: src/vision/anthropic-describe.ts (new), src/vision/index.ts,
src/types.ts (OcxVisionSidecarConfig fields), src/server/responses.ts (vision
plan threading ~line 616), src/server/management-api.ts (vision backend r/w),
tests/vision-anthropic.test.ts (new) + tests/vision-cache.test.ts (new).
Out of scope: WP5 GUI (config schema only), src/web-search/*.

Diffs (Godel-scoped):
- types.ts OcxVisionSidecarConfig (~487): + `backend?: "openai"|"anthropic"` +
  `maxDescriptionsPerTurn?: number`.
- new src/vision/anthropic-describe.ts: describeImageAnthropic — Anthropic
  /v1/messages with the SAME OAuth fingerprint as web-search anthropic-executor
  (getValidAccessToken, Bearer, ANTHROPIC_OAUTH_BETA, CLAUDE_CODE_HEADERS,
  X-Claude-Code-Session-Id, x-client-request-id, CLAUDE_CODE_SYSTEM_INSTRUCTION
  first system block), thinking disabled, one image block via the adapter's
  image-block builder shape ({type:image, source:{type:base64,media_type,data}}
  or {type:image,source:{type:url,url}}), optional context text; parse text_delta
  SSE to a description string; reuse the vision clamp. Never throws.
- src/vision/index.ts: mirror web-search findAnthropicSidecarProvider +
  resolveSidecarBackend; VisionPlan gains backend (+ anthropicSidecar for the
  anthropic path, forwardProvider optional for it); planVisionSidecar resolves
  backend (explicit wins; unset -> anthropic when usable credential else openai;
  explicit anthropic w/o credential FAILS CLOSED like web-search); dispatch
  describeImage vs describeImageAnthropic. Add per-turn cap counting cache MISSES
  (over-cap images -> explicit "description cap reached" marker, not dropped) and
  a bounded process-level LRU description cache keyed by (backend, model,
  sha256(normalized image bytes for data: / url string for https:)); cache only
  SUCCESSFUL descriptions; preserve replacement ordering; VISION_CONCURRENCY=3
  still bounds concurrent misses.
- src/server/responses.ts (~616): pass the backend-specific vision plan into
  describeImagesInPlace.
- src/server/management-api.ts (~192): read/write vision backend alongside model.

Acceptance:
- tests/vision-anthropic.test.ts: request shape (/v1/messages, OAuth headers,
  first system block, base64 + url image blocks, thinking disabled, text_delta
  extraction).
- tests/vision-cache.test.ts (or a unit file): per-turn miss cap + over-cap
  marker + ordering; duplicate data URL => one executor call; second request
  hits cache; changed bytes miss; failed outcomes NOT cached; backend/model key
  separation.
- Keep green: vision-sidecar-e2e, vision-fail-closed, catalog-vision-sidecar-
  modalities, anthropic-image-guard.

Cache scoping note (Godel): no stable per-conversation id is exposed to
src/vision; a bounded process-level LRU keyed by image hash is the minimal impl
(cross-conversation). Cache neutral (context-independent) base descriptions so a
hit is safe; include contextText handling by keeping the cached description
image-only (option 1). Acceptable for v1; per-conversation isolation is a later
enhancement.

Precedent/soak risk (both, record): reuses the EXACT web-search OAuth fingerprint
(already shipped WP2) — within repo precedent, does NOT exceed it. But image-
describe-under-subscription-OAuth is unproven live; flag as a soak-test item, not
a blocker.

## Verify (C): full `bun test --isolate ./tests/` + typecheck green over the
integrated tree; adversarial sol review of BOTH diffs; commit WP3 and WP4.

## Audit synthesis (Mencius/sol — VERDICT FAIL, 7 findings, all folded)

Evidence: .codexclaw/evidence/260712-wp3wp4-plan-audit.md

- F1 BLOCKER ACCEPT (cache not context-neutral): describeImage bakes contextText
  into the prompt (describe.ts:68), so a description is context-dependent. REVISED
  cache design: key = (backend, model, detail, sha256(image bytes),
  sha256(normalizeWhitespace(contextText))). Identical image+context+detail =>
  hit (the real per-turn waste: same historical image+question recurs every turn);
  different context => miss (no leak). Does NOT change the describe prompt.
- F2 MAJOR ACCEPT (detail + mutable URLs): `detail` is now IN the key. Cache ONLY
  `data:` (base64, immutable) images; NEVER cache `https:` URLs (mutable) — they
  always describe fresh. Removes the stale-remote risk entirely.
- F3 MAJOR ACCEPT (WP3 test machine-state): the WP3 endpoint test MUST set
  webSearchSidecar.backend="openai" AND visionSidecar.backend="openai" and use an
  isolated auth.json with NO stored anthropic credential and NO pool selection, so
  it actually exercises the injected main ChatGPT headers. The no-login companion
  likewise pins openai backends + no anthropic cred so anthropic can't validly run.
- F4 MINOR (confirmed): getMainAccountToken() returns {accessToken,
  chatgptAccountId} (main-account.ts:29); injection point + native non-alteration
  correct. No change.
- F5 MINOR (confirmed): write scopes disjoint; WP3 does not touch responses.ts.
  No change.
- F6 MINOR ACCEPT (cap edge tests): the LRU cache must be INJECTABLE/RESETTABLE for
  test determinism (export a reset or accept an instance). Tests add:
  maxDescriptionsPerTurn=0, negative/non-integer normalization, duplicate image
  single-flight (not two concurrent misses), failure/empty NOT cached, interleaved
  hit/miss/over-cap across messages preserving order.
- F7 MINOR ACCEPT (sharper acceptance): WP3 test asserts the ROUTED provider mock
  receives NO ChatGPT bearer while the FORWARD sidecar mock receives the main
  bearer+account id, distinguishes vision vs web-search forward calls by body, and
  keeps a native-path non-regression assertion. WP4 management tests verify GET/PUT
  vision backend validation+persistence. WP4 anthropic tests add explicit-anthropic-
  no-credential fail-closed, malformed/terminal SSE, abort/timeout cleanup,
  data:/https: validation parity, and only-non-empty-success caching.

Revised WP4 cache summary: process-level bounded LRU, injectable/resettable,
key=(backend,model,detail,imageHash,contextHash), data:-images only, stores only
non-empty successful descriptions; per-turn cap counts MISSES; over-cap => explicit
"description cap reached" marker; ordering preserved.
