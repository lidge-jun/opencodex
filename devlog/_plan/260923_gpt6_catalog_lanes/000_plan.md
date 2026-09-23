# 260923 GPT-6 catalog lanes — plan

## Objective

Two independent pull requests against `dev`:

- **PR 1** (`codex/upstream-catalog-resync`): re-pin `src/codex/data/upstream-models.json` to openai/codex main `6cfe29984` and add an opt-in flag that admits unknown bare native models from the authenticated ChatGPT Codex `/models` roster.
- **PR 2** (`codex/gpt6-sol-luna-astra-minor`): register `gpt-6-sol`, `gpt-6-luna` and `gpt-6-astra-minor`.

## Evidence (2026-09-23)

- openai/codex `deb0a08f2` (#47085, 2026-09-21) describes GPT-5.6-Sol as "Reliable agentic workhorse for everyday tasks." and moves its priority 6 → 4. `cf6754e68` (#47130) removes `ultrafast` from Sol. `eb7bd64ef` (#44250) removed the retired `gpt-5.4-mini` / `gpt-5.2` rows. `gpt-daybreak-blue-latest` / `gpt-daybreak-red-latest` rows now ship in the bundled catalog.
- openai/codex contains no `gpt-6-sol`, `gpt-6-luna` or `gpt-6-astra-minor` at `6cfe29984`.
- Live roster probe (`https://chatgpt.com/backend-api/codex/models`, main + 5 pool accounts): `gpt-6-sol` (priority 2) and `gpt-6-luna` (priority 3) are served as full native rows only when `client_version >= 0.155.0`; `0.154.0` returns `gpt-6-astra` only. Rows claim `minimal_client_version: "0.153.0"`. Sol is absent on 2 of 6 accounts; Luna is on all; `gpt-6-astra-minor` is on none. Installed Codex is 0.154.0; npm latest is 0.155.1.
- OpenAI announced GPT-6 Sol and Luna on 2026-09-22 (https://openai.com/index/introducing-gpt-6-sol-and-luna/, API changelog Sep 22). `gpt-6-astra-minor` appeared only in an Azure AI Playground config snapshot (pl4nty/data `2b6a2351`, 2026-09-22T04:34Z), was withdrawn by ~14:56Z and has no OpenAI doc page (404).

## Constraints

- File-size ratchet: `tests/codex-integration/codex-catalog.test.ts` is at its 7985-line cap; new cases go into sibling files registered in `scripts/test-layout/layout.json` and `tests/fixtures/test-layout-expected.json`.
- PR 1 rewrites `upstream-models.json` wholesale, so PR 2 keeps its rows in a sibling data file to stay conflict-free.
- Flagship natives are listed unconditionally (owner decision 2026-09-04, `structure/providers/openai-tiers.md`); only unconfirmed ids are account-gated.
- Per user steering on 2026-09-23: no local test runs; push with `--no-verify`; hosted CI is the verification of record. `bun run typecheck` only.

## Phase map (dependency order)

| Work-phase | Doc | Branch | Depends on |
|---|---|---|---|
| wp0 roadmap | this unit | — | — |
| wp1 snapshot re-pin | `010_phase1_upstream_repin.md` | PR 1 | wp0 |
| wp2 opt-in roster admission | `020_phase2_roster_admission.md` | PR 1 | wp1 |
| wp3 GPT-6 rows | `030_phase3_gpt6_rows.md` | PR 2 | wp0 |

## SoT sync

`structure/catalog.md` (snapshot and admission), `structure/config.md` (new flag), `structure/providers/openai-tiers.md` (flagship roster), `docs-site/src/content/docs/guides/codex-app-models.md`, `docs-site/src/content/docs/reference/configuration/providers.md`.

