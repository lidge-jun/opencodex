# 030 — PR #307: Preserve custom model display names across catalog syncs

- Author: diegocantarero · base `dev` · +168/−1, 3 files, CI green (CodeRabbit pass;
  cross-platform checks green at last run).
- Scope: `src/codex/catalog.ts` + docs + tests. No GUI paths.

## What it does

- Adds `displayName?` to `CatalogModel` and threads `config.customModels[].displayName`
  through `gatherRoutedModels` → `applyCatalogModelMetadata` → catalog `display_name`.
- Display-only: routing slug, alias collision order, provider, and native marketing names
  untouched. Empty/whitespace names fall back to slug.

## Review findings

- The input boundaries already exist on dev: CLI `--display-name` (`src/cli/models.ts:114`)
  and management API POST/PUT (`management-api.ts:933-975`) both trim and reject `/`.
  This PR is the missing propagation half — before it, a saved displayName was persisted in
  config but silently dropped at catalog build. Coherent fix, matches Jun's provider-UX rule
  (persistent picker IDs, display-only labels).
- Idempotence proven: test drives two `mergeCatalogEntriesForSync` rounds and asserts no drift
  back to bare slug — exactly the historical regression class in this file.
- Native-name precedence test (`gpt-5.6-sol` → "GPT-5.6-Sol") confirms customModels can never
  overwrite pinned upstream names (natives carry no CatalogModel).
- Docs section in codex-integration.md is accurate against the code.

## Verdict: **MERGE-READY** — small, surgical, well-tested, closes a real config→catalog gap.
