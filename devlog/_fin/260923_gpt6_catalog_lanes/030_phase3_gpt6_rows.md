# 030 Phase 3 — gpt-6-sol, gpt-6-luna, gpt-6-astra-minor (PR 2)

Branch `codex/gpt6-sol-luna-astra-minor` from `origin/dev`; independent of PR 1.

## Decisions

- D1 `gpt-6-sol` and `gpt-6-luna` are SELF-DESCRIBED natives. Their rows are the live-roster rows captured on 2026-09-23 (client_version 0.155.0), stored verbatim in a NEW sibling file `src/codex/data/roster-pinned-models.json` so PR 1's wholesale re-pin of `upstream-models.json` does not conflict.
- D2 Both are listed unconditionally like `gpt-6-astra` (flagship owner decision). They are not account-gated.
- D3 `gpt-6-astra-minor` is an ACCOUNT-GATED capability alias of `gpt-6-astra` with hand-written presentation (display "GPT-6-Astra-Minor"). It stays hidden and request-refused until an authenticated roster lists it.
- D4 No API-key registry rows or pricing in this PR.
- D5 (audit B4) `isGpt56NativeSlug`/`ensureGpt56ReasoningLevels` (`effort.ts:281-287`) grant the full ladder only when the slug's own or source pinned row ships `ultra`; Luna keeps low..max. `finishUpstreamNativeEntry` (`derive-entry.ts:35`) and the sync branch (`build-entries.ts:688`) inherit this through the predicate.
- D6 (audit B4, rebutted in part) The first-five spawn roster is `config.subagentModels` (`src/config/subagent-models.ts:8`, migrated once); adding natives does not reorder it, so `DEFAULT_SUBAGENT_MODELS` stays unchanged in this PR. Users who want GPT-6 Sol/Luna as subagents pick them in the dashboard.

## Change map

| Path | Action |
|---|---|
| `src/codex/data/roster-pinned-models.json` | NEW: `{ "source": ..., "models": [gpt-6-sol row, gpt-6-luna row] }` copied from `.tmp/gpt6-roster-rows.json` |
| `src/codex/catalog/pinned-models.ts` | NEW: `pinnedNativeModelRows()` = upstream snapshot rows followed by roster rows whose slug the snapshot lacks |
| `src/codex/catalog/native-models.ts` | MODIFY: constants `NATIVE_GPT6_SOL_MODEL`, `NATIVE_GPT6_LUNA_MODEL`, `NATIVE_GPT6_ASTRA_MINOR_MODEL`; add all three to `NATIVE_OPENAI_MODELS`; minor to `ACCOUNT_GATED_NATIVE_OPENAI_MODELS`; sol+luna to `SELF_DESCRIBED_NATIVE_OPENAI_MODELS`; minor → astra in `NATIVE_OPENAI_CAPABILITY_SOURCES` + presentation; sol+luna to `NATIVE_MAIN_DRAIN_SENTINEL_MODELS` |
| `src/codex/catalog/metadata.ts` | MODIFY: `PINNED_UPSTREAM_MODELS` built from `pinnedNativeModelRows()`; sol+luna in `DOCUMENTED_NATIVE_OPENAI_ADDITIONS`; context overrides 272_000/872_000/872_000 for sol, luna, minor |
| `src/codex/catalog/effort.ts` | MODIFY: `isGpt56NativeSlug` full ladder only when the source row ships `ultra` — Luna ships low..max |
| `src/codex/model-entitlements.ts` | MODIFY: floor derivation reads `pinnedNativeModelRows()` |
| `tests/codex-integration/gpt6-native-rows.test.ts` | NEW (layout registered) |
| `structure/catalog.md`, `structure/providers/openai-tiers.md`, `docs-site/.../reference/configuration/providers.md` | MODIFY |

## Verification

`bun run typecheck` only; tests NOT RUN locally per user steering; hosted CI on the PR head.
