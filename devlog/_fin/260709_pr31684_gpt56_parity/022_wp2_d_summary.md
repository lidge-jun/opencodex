# 022 — WP2 D summary (terminal outcome: DONE)

## What shipped
- `src/codex/catalog.ts`: `disabledNativeSlugs` / `visibleNativeSlugs` /
  `nativeModelRows` / `applyNativeVisibility`; `mergeCatalogEntriesForSync` takes a
  `disabledNative` set and applies the visibility flip as the LAST pass (B1 fold-back:
  the 5.6 snapshot-upgrade branch can never clobber a hide flag). Backfill entries are
  synthesized normally and hidden by the same pass (B2 fold-back: enable/disable is a
  pure symmetric visibility flip; no skip asymmetry).
- `src/server/index.ts`: `/v1/models` client_version shape keeps disabled natives with
  `visibility: "hide"`; bare list shape omits them (`visibleNativeSlugs`).
- `src/server/management-api.ts`: `/api/models` leads with native rows
  (provider "openai", `native: true`, static supported set, contextWindow via
  `nativeOpenAiContextWindow`).
- GUI: native group pinned first with "OpenAI native" badge + hint; on/off toggles
  only (no allowlist/cap switches); cap aggregate counts routed groups only (B3
  fold-back); i18n en/ko/zh.
- Tests: `tests/native-model-toggle.test.ts` (8 cases). Docs: catalog doc native
  toggle section, structure/03, docs-site configuration tables en/ko/zh.

## Evidence
- `bun x tsc --noEmit` exit 0; full `bun test` 1684 pass / 0 fail (172 files, 22.78s).
- Activation: hide AND restore directions asserted; upgrade-branch interaction
  asserted; backfill-hidden asserted; /api/models + subagent filter asserted via real
  `handleManagementAPI` calls.
- Render grounding: built GUI + real management handler on :10199, Playwright
  (system Chrome headless, 1280x720). Observed: native group first, badge, 7 rows,
  pre-disabled gpt-5.4 struck through; clicking gpt-5.6-luna flipped aria-pressed to
  false, server config recorded disabled:true, "Applied" notice, count 6/7 -> 5/7.
  Screenshot: `021_wp2_render_observation.png`. Stub server torn down (port free).
- Commit: "models: native GPT on/off toggles via disabledModels bare slugs"
  (14 files, +268/-27).

## LOOP-PESSIMIST-01
- In-app browser could not reach ANY localhost port in this environment (even the
  live :10100 dashboard) — render grounding fell back to node_repl Playwright with
  `channel: "chrome"`. If a future unit needs IAB, investigate that restriction first.
- Not covered: a live end-to-end Codex picker observation (would need a restarted
  proxy + real Codex client); the on-disk catalog contract is covered by unit tests
  and codex-rs behavior was verified read-only (hidden entries skipped for picker and
  default selection, openai_models.rs:594,640-650).

## Goal close-out
Both work-phases DONE; goal criteria c1-c6 met with captured evidence in the
goalplan. Terminal outcome: DONE.
