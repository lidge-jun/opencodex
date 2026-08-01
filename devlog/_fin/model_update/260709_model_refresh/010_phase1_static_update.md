# 010 — Phase 1: static catalog update (diff-level)

## src/providers/registry.ts
- xai block (L176-189):
  - models: ["grok-4.5", "grok-4.3", "grok-4.20-multi-agent-0309", "grok-4.20-0309-reasoning",
    "grok-4.20-0309-non-reasoning", "grok-build-0.1", "grok-composer-2.5-fast"]
  - defaultModel: "grok-4.3" -> "grok-4.5"
  - noReasoningModels: += "grok-4.20-0309-non-reasoning" (keep build/composer)
  - noVisionModels: unchanged (conservative; see 001)
  - NEW modelReasoningEfforts: { "grok-4.5": ["low", "medium", "high"] }
  - NEW modelContextWindows: { "grok-4.5": 500_000, "grok-4.3": 1_000_000,
    "grok-4.20-multi-agent-0309": 1_000_000, "grok-4.20-0309-reasoning": 1_000_000,
    "grok-4.20-0309-non-reasoning": 1_000_000, "grok-build-0.1": 256_000 }
- ANTHROPIC_MODELS (L65): prepend "claude-fable-5"; ANTHROPIC_MODEL_CONTEXT_WINDOWS (L66):
  += { "claude-fable-5": 1_000_000 } (official overview lists 1M-class current line; keep others).
  Both anthropic entries defaultModel: "claude-sonnet-4-6" -> "claude-sonnet-5".
- openai-apikey (L255): += liveModels: true.
- umans models (L122,134,272): remove "umans-kimi-k2.6" from models list, contextWindows,
  modelReasoningEfforts.
- moonshot (L384): drop "kimi-k2-0905-preview" from models (kept in KIMI_THINKING_MODELS
  harmlessly? no — also prune from L112 list) — verify no other refs.

## src/adapters/cursor/discovery.ts (CURSOR_STATIC_MODELS)
- ADD: { id: "grok-4.5", contextWindow: CONTEXT_256K }, { id: "kimi-k2.7-code", contextWindow: CONTEXT_262K },
  { id: "claude-opus-4-7-fast", contextWindow: CONTEXT_200K, supportsReasoningEffort: true }.
- REMOVE: composer-1.5, composer-2, grok-4.3, grok-4.20, grok-build-0.1, grok-code-fast-1,
  kimi-k2.5, gpt-5.5-extra (absent from current Cursor docs; live GetUsableModels filter already
  drops them for logged-in users).
- glm-5.2 contextWindow: CONTEXT_200K -> CONTEXT_1M (official Z.AI).
- HOLD (UNVERIFIED): dot->dash renames (claude-4.5-* etc.) and dash-form "grok-4-5" — Cursor docs
  URL slugs cannot contain dots, so URL-derived ids are ambiguous; existing effort-map.ts keys and
  jawcode SOT use dot-form. Resolution path: live GetUsableModels check (Phase 2 / C); apply only
  with live evidence. Record outcome in D summary.
- Sync src/adapters/cursor/effort-map.ts ONLY if renames land.

## src/generated/jawcode-model-metadata.ts
- Refresh via `bun scripts/generate-jawcode-metadata.ts` ONLY (generated file). Network-dependent;
  failure => record + skip (registry modelContextWindows above still pin xai values).

## Tests
- tests/cli-models.test.ts / codex-catalog*.test.ts: update expectations where lists are asserted.
- NEW assertions: xai registry contains grok-4.5 with 500k context + ["low","medium","high"]
  efforts; built catalog entry xai/grok-4.5 exists; cursor static ids include grok-4.5 and
  exclude removed ids.

## Accept criteria
- tsc exit 0; targeted suites (cli-models, codex-catalog*, cursor*, reasoning-effort) green;
  full bun test 0 fail. Registry values trace 1:1 to 001/002 evidence.

## A-phase fold-back (reviewer gpt-5.5 "Raman", VERDICT FAIL -> amendments accepted)
- B1 (P1): Cursor grok addition DEFERRED to Phase 2 — id form (grok-4.5 vs grok-4-5) must come
  from live GetUsableModels, because the live filter (catalog.ts:823-826) drops statics whose id
  doesn't prefix-match live ids. kimi-k2.7-code (dot, matches existing kimi-k2.5 convention) and
  claude-opus-4-7-fast (dash, matches existing opus-4-7/4-8 keys) stay in Phase 1.
- B2 (P1): removals must also retire effort-map.ts stale keys (gpt-5.5-extra at L32; check every
  removed base) and update tests asserting removed ids: cursor-effort-suffix.test.ts:35,
  cursor-discovery.test.ts:29-31, cursor-static-catalog.test.ts:67-68,
  provider-registry-parity.test.ts:130,154,164.
- B3 (P2): grok-4.5 Codex picker default will be medium (catalog default rule) while upstream
  default is high — ACCEPTED drift, documented here; no per-model default override surface exists
  and adding one is out of scope.
- Reviewer confirmed: registry line cites accurate; default flips only affect seeding/new-config
  flows (derive.ts:63-90, oauth/index.ts:338-354, cli/init.ts:79-95); jawcode metadata does not
  override provider modelContextWindows; Phase 2 test seam = gatherRoutedModels + globalThis.fetch
  stub (pattern: tests/codex-catalog.test.ts:290-319, 697-765); GUI/management API registry-driven.

## D summary (Phase 1, DONE)
- Shipped: registry xai refresh (grok-4.5 default + metadata, multi-agent-0309 added,
  non-reasoning flag), anthropic (+claude-fable-5, default claude-sonnet-5), openai-apikey
  liveModels, umans/moonshot prunes; cursor static seed (-8 stale ids, +kimi-k2.7-code,
  +claude-opus-4-7-fast bare, glm-5.2 1M); effort-map -gpt-5.5-extra; docs-site
  codex-integration examples grok-4.3 -> grok-4.5 (en/ko/zh).
- Evidence: tsc exit 0; full bun test 1652 pass / 0 fail; targeted suites 32 pass incl.
  grok-4.5 seed->catalog-entry activation test. jawcode generator run: NOOP (no diff).
- LOOP-PESSIMIST: cursor id-form question still open (dot vs dash) — Phase 2 must resolve via
  live GetUsableModels or record BLOCKED-for-cursor-live; opus-4-7-fast effort tiers unknown
  (shipped bare, no tier picker); grok-4.5 Codex default shows medium vs upstream high (accepted).
