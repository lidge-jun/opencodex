# 020 Phase 2 — opt-in admission of unlisted native models

> Decision 2026-09-23 (user, async answer): PR 1 ships the re-pin only; opt-in roster admission moves to a separate follow-up PR. This document is the design input for that PR, including the round-1 audit findings below.

> Status after audit round 1: BLOCKED ON USER DECISION. Reviewer B2 showed the admission has to reach both catalog writers (`retained-sync.ts` and `convergence.ts:268`) and six allowlists (`build-entries.ts:385`, `:674-681`, `:700-703`, `retained-sync.ts:326`, `metadata.ts:510` `applyNativeVisibility`, `subagent-roster.ts:102`), and `parseAccountModels` (`model-entitlements.ts:632`) must keep bodies. B3: the new module must take a structural `Record<string, unknown>` and import neither `parsing.ts` nor `metadata.ts` (cycle through `parsing.ts:34`). With local tests forbidden this is not shippable in PR 1 without tests being run somewhere; the user was asked whether to move it to a follow-up PR.

## Behaviour

New config field `codexAdmitUnlistedNativeModels?: boolean` (absent or malformed = off). When on, the authenticated main-account roster fetch keeps full rows for bare ids that are `gpt-*`/`o1-`/`o3-`/`o4-`, not in `SUPPORTED_NATIVE_OPENAI_SLUGS`, not in `RETIRED_NATIVE_OPENAI_MODELS`, `supported_in_api === true`, `visibility === "list"` and pass `hasNativeCatalogRowShape`. Catalog sync then emits those rows as bare picker rows. The roster is asked at the same client version as today (installed runtime raised to the gated floor), so a row appears only once the installed Codex can be served it; nothing raises the floor.

## Change map

| Path | Action |
|---|---|
| `src/codex/catalog/unlisted-natives.ts` | NEW: `hasNativeCatalogRowShape` (moved from metadata.ts, re-exported), `admissibleUnlistedNativeRow(row)`, main-account row store with `recordUnlistedNativeRows(accountId, clientVersion, rows)` / `unlistedNativeRowsForCatalog()` / reset for tests |
| `src/codex/model-entitlements.ts` | MODIFY: `parseAccountModels` also returns candidate rows; `fetchAccountModels` records them for `MAIN_CODEX_ACCOUNT_ID` on a confirmed roster |
| `src/codex/catalog/retained-sync.ts` | MODIFY: when the flag is on, bare rows from the store join the catalog with `visibility: "list"` and their slugs join `observedNativeSlugs` |
| `src/codex/catalog/metadata.ts` | MODIFY: import `hasNativeCatalogRowShape` from the new module |
| `src/types/config.ts`, `src/config/schema/config-schema.ts`, `src/config/feature-flags.ts`, `src/config/diagnostics.ts` | MODIFY: field doc, `z.boolean().optional().catch(false)`, `admitUnlistedNativeModelsEnabled()`, own-boolean validation |
| `tests/codex-integration/unlisted-native-admission.test.ts` | NEW, registered in layout.json + test-layout-expected.json |
| `structure/config.md`, `structure/catalog.md`, `docs-site/.../reference/configuration/providers.md` | MODIFY |

## Field chain (PLAN-FIELD-CHAIN-01)

creation: config.json / PUT /api/settings passthrough → schema `.catch(false)` → consumer `admitUnlistedNativeModelsEnabled(config)` in retained-sync; serialization N/A (not written by code); no GUI control (out of scope).

## Activation scenarios

- Flag off: store may hold rows, catalog emits none (test).
- Flag on + roster row `gpt-future-x` with full shape: bare row listed (test).
- Retired `gpt-5.4`, hidden row, row without `base_instructions`, `supported_in_api:false`: refused (test).

## Limits

`/v1/models` and dashboard rows are unchanged in this phase; the Codex picker is the target surface.
