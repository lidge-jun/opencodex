# 000 — Codex journal must never revert config.toml changes made after injection

Lane: `fix/codex-journal-overwrite`, base `origin/dev` 61bc4428b7. Class C4 (persisted user state, restore of a user-owned file).

## Objective

Every OpenCodex path that writes `$CODEX_HOME/config.toml` back toward native — `ocx stop`/`restore`/disconnect, start/update/client journal recovery, and sync re-injection — keeps every change made after injection (by the user, by Codex, or by the Codex app) and removes or restores only the keys OpenCodex wrote. An app rewrite of the injected keys is detected, healed at key level, reported once, and can never make a later restore replay stale content.

## Findings (C1, temp-home probes on 61bc4428b7)

Probe harness: `.tmp/probe/` (not committed). Every run used fresh `CODEX_HOME`, `OPENCODEX_HOME` and `HOME` under `/tmp`. Codex-style edits: root key added before the first table, `[hooks.state."plugin:…"].trusted_hash` modified and added, `[projects."…"]` trust added, `[plugins."…"].enabled` flipped, all written by atomic rename like Codex's `write_atomically`.

| Path | Entry | Later edits | Routing removed | Defect |
|---|---|---|---|---|
| stop/restore sync | `restoreNativeCodex` (`src/codex/inject/restore.ts:818`) | kept | yes | journal retained unbound with stale `originalConfig` (`restore.ts:477`) |
| stop/restore async | `restoreNativeCodexAsync` (`restore.ts:579`) | kept | yes | same |
| start crash recovery | `reconcileJournal` (`src/codex/journal.ts:566`, restore at `:614`) | kept | **no** | refuses as "incomplete" (`journal.ts:403-409`, `:619-621`), dead loopback URL and catalog stay |
| mismatched client | `reconcileJournal` (`journal.ts:581`) | kept | **no** | same |
| disconnect recovery | `restoreJournalState({preserveConfigEdits, recoverConfigForClient})` (`src/client/connect.ts:1248`) | kept | yes | — |
| sync re-inject then stop | `injectCodexConfig` + stop | kept | yes | — |
| update handover | `reconcileJournal({adoptUpdateHandover})` (`journal.ts:605`) + stop | kept | yes | — |
| **in-place write during replay** | `restoreJournalState` read `journal.ts:381` → publish `:436` | **lost**, restore reports complete | yes | inode witness only (`src/codex/config-write-lock.ts:133-147`) |
| atomic rename during replay | same | kept, restore refused | — | — |
| in-place write during strip | `removeCodexConfig` decision `src/codex/inject/remove.ts:225` → publish `:263` | lost (same window) | — | same |
| app writes back an EARLIER injection's values | sync (`src/codex/inject.ts:375-383`) | kept | **no** | our old URL/realtime/catalog are classified user-owned, journaled into `originalConfig`, routing stays on the dead port, restore keeps it |
| app drops `model_catalog_json` only | `codexConfigDrift` (`src/codex/config-drift-heal.ts:51-80`) | — | — | never detected |
| app drops injected URL keys | drift heal → sync | kept | yes | healed silently every tick, no report |

Not reproduced on dev: a systematic whole-file replay reverting later settings. `restoreJournalState` replays `originalConfig` only when the file is byte-identical to the first injected bytes (`journal.ts:147-150`, the #4005 hash gate); then `originalConfig` is exactly the current file minus injection, so the replay is lossless. The losses that do reproduce are the race above and the stale-content class from app rewrites.

## Prior art (research subagent, Morph DeepSeek, verified against git)

- #477 `32c38855`: `writeJournal` froze the first snapshot; fixed by deciding nativeness from bytes and refreshing the snapshot (`journal.ts:191-223`). Whole replay stays.
- #1230 `d3015cb9` (PR #1269): journal recovery ran before the live-owner check; moved below it.
- #4005 `d0382dbe` (PR #4049): a hashless journal counted as unchanged; `compareJournalState` + `unverified` (`journal.ts:133-154`).
- #7425 `e9df82cb` (PR #7659): sync rewrote edited managed defaults; `injectedSubagentDefaults` value evidence.
- #7827 `7a1565bb` (PR #7851): a missed owner probe allowed recovery under a live owner; lease + recheck (`src/cli/start-owner-fence.ts`).
- #2948: no fixing commit exists; only referenced as out of scope by the #4005 notes.
- Codex itself edits `config.toml` with `toml_edit::DocumentMut` applying only queued edits to the current bytes and `write_atomically` (https://github.com/openai/codex/blob/main/codex-rs/core/src/config/edit.rs). Conda removes exactly its marker block (`conda init --reverse`, https://docs.conda.io/projects/conda/en/latest/commands/init.html). VS Code updates one key through `WorkspaceConfiguration.update` (https://code.visualstudio.com/api/references/vscode-api). Common rule: edit the current document at key level; never write back a remembered whole document.

## Design

1. Compare-and-swap on every restore write of `config.toml`: the bytes on disk immediately before rename must equal the bytes the decision was computed from, else refuse retryably without writing. Failure compensation reverts `config.toml` only when this lock section published it and the file still holds that publication.
2. Journal recovery (start, mismatched client) takes the key-level three-way restore already used by disconnect (`restoreJournalConfigFields`) instead of refusing; whole-file replay keeps its hash gate.
3. The journal remembers every root routing value injections under it wrote (`injectedRootHistory`, capped, optional field, `version` stays 1). Sync, strip and three-way restore treat those values as OpenCodex's own, so an app rewrite with stale values is neither adopted as user-owned nor replayed.
4. Drift detection covers `model_catalog_json`; the first heal per process warns once.

## Work-phase map

| Phase | Doc | Content | Depends |
|---|---|---|---|
| wp1 | this unit | roadmap (docs only) | — |
| wp2 | `010_phase1_failing_tests.md` | behavior-neutral seam + failing tests for every defect | wp1 |
| wp3 | `020_phase2_key_level_restore.md` | fix + structure docs | wp2 |
| wp4 | `030_phase3_verify_and_pr.md` | gates, PR, ci:full, report | wp3 |

## Constraints

Temporary homes only; never the real `~/.codex`/`~/.opencodex`; no config values printed. `src/codex/inject.ts` sits at its file-size cap (987) so its change is net ≤ 0 lines. `structure/codex-home.md` is at the 600-line doc budget, so its update edits existing paragraphs. New test files register in `scripts/test-layout/layout.json` and `tests/fixtures/test-layout-expected.json`.

## Status (wp4)

- PR: https://github.com/lidge-jun/opencodex/pull/8878 (base `dev`, label `ci:full`).
- Fail-first: 11/18 new tests failed at `cc48be64d9` (tests + seam), each for the recorded reason; 19/19 pass after the fix.
- Local gates at `514b258e33`: typecheck 0; 546/546 focused; structure:check and privacy:scan pass; test:changed 37,999 pass with 5 load timeouts that pass on their own.
- Residual: a native `codex` child's publication digest is a post-rename re-read; the strip-path rename race leaves the generated profile removed until a retry.
- Subagents: research, plan audit r2, wp2 audit r2 and diff review r2 ran on codex / `morph/morph-dsv41flash-1017`. Plan audit r1, wp2 audit r1 and diff review r1 stalled or returned no verdict and were cancelled or retried.
- CI on `d08070fa3a`: gates, structure gate, api usage, docker smoke, npm-global, storage policy, catalog async contracts, CodeRabbit and test shards 1, 3, 4 and 5 passed. Shard 2 failed in `tests/ci-workflows/file-size-ratchet.test.ts`: registering the two tests in `scripts/test-layout/layout.json` took it to 2,000 lines (`NEW_OVERSIZED`). They moved to the new shard `scripts/test-layout/layout-codex-journal.json`, which leaves `layout.json` at its `dev` length of 1,999.
