# 020 — Phase 2: dynamic loading (diff-level, re-verify against tree before B)

## Baseline (already shipped, verified in P exploration)
fetchProviderModels (src/codex/catalog.ts:807) already does live GET /models with TTL cache,
failure cooldown, stale fallback, config-merge; default is LIVE unless prov.liveModels === false;
oauth providers skip when no token. Cursor has bespoke GetUsableModels path (liveModels: true).

## Changes
1. registry.ts xai block: += liveModels: true (explicit intent doc; default already live) AND
   verify resolveModelsAuthToken resolves the xai OAuth token (oauthId: "xai") for /v1/models.
2. Live-merge hardening test (NEW tests/provider-live-models.test.ts): mock fetch returning
   xai-shaped { data: [{ id: "grok-4.5", ... }, { id: "grok-5-preview" }] }:
   - live ids merge with configured statics (dedupe), new live-only id appears;
   - fetch failure -> stale cache -> configured fallback chain;
   - oauth-without-token -> [] (documented behavior).
   Use existing test seams (check how codex-catalog tests stub fetch; reuse pattern).
3. Cursor live path verification: if a cursor OAuth token exists locally, exercise
   fetchCursorUsableModels via the running proxy /api/models (read-only) and record the real
   GetUsableModels ids => resolves 010's HOLD renames. No token => record BLOCKED-for-cursor-live
   and keep static fallback.
4. anthropic (oauth) liveModels: DO NOT enable blindly — OAuth token vs /v1/models auth is
   unverified; test with local token if present, else record NOOP + reason.
5. Docs: 003 convention already states dynamic-first; add findings to D summary; update
   docs/codex-app-model-catalog.md only if behavior (not just flags) changed.

## Accept criteria
- Mocked live-merge + fallback tests green; tsc exit 0; full bun test 0 fail; cursor rename
  question resolved-or-recorded; xai live discovery path evidenced (mock at minimum, live if token).

## P re-verify (cycle 2, post-Phase-1 tree + live snapshot 004)
Live /api/models snapshot (004_live_snapshot.md) resolves every open question:
- xai live /v1/models ALREADY returns grok-4.5 + composer-2.5-fast via user OAuth token => change 1
  narrows to an explicit `liveModels: true` intent flag + parity assertion (behavior already live).
- Cursor renames: REJECTED — live-filter survivors are dot-form (claude-4.5-opus, claude-4.6-*).
- Cursor grok: NOT added — no grok-* in this account's live GetUsableModels.
- NEW task (evidence-forced): RESTORE gpt-5.5-extra (discovery seed + effort-map ["high"] +
  suffix test) — it SURVIVED the live filter, so account-verified beats docs-absence (003 rule);
  Phase 1 removal reverted for this id only.
- Mocked-fetch tests confirmed seam: gatherRoutedModels + globalThis.fetch stub + clearModelCache
  (pattern at tests/codex-catalog.test.ts:290-320). New file tests/provider-live-models.test.ts:
  (a) live ids merge with configured statics, live-only id (grok-5-preview) appears, dedupe holds;
  (b) fetch failure -> configured fallback; (c) context_length from live item flows to metadata.
- anthropic oauth liveModels: NOOP — live rows already present in snapshot via existing paths;
  no flag change without adapter-specific verification.

## D summary (Phase 2, DONE)
- Shipped: xai `liveModels: true` (intent flag; live already default), gpt-5.5-extra restore
  (seed/effort-map/tests) per live-filter survival, NEW tests/provider-live-models.test.ts pinning
  the live-merge contract (dedupe, live-only ids, context_length flow, network + non-ok fallback),
  parity assertion for the flag.
- Evidence: tsc exit 0; full bun test 1655 pass / 0 fail / 170 files; live snapshot 004 shows the
  running proxy already serving grok-4.5 via xai live /v1/models.
- Resolved from Phase 1: cursor id-form = dot (live survivors); cursor grok NOT added (absent from
  this account's live GetUsableModels — revisit when a future snapshot shows it).
- LOOP-PESSIMIST: dynamic discovery for zai/moonshot/deepseek/minimax remains UNVERIFIED
  (endpoints undocumented in this pass) — static lists stay authoritative there; anthropic-oauth
  live flag deliberately untouched (auth semantics unverified); opus-4-7-fast/kimi-k2.7-code seeds
  are docs-sourced but absent from THIS account's live cursor catalog (live filter governs).
