# 000 — Second `_plan` archive sweep, under the landed-on-dev rule

Unit: `devlog/_fin/260816_devlog_fin_sweep/`
Executed: 2026-08-16 · Branch target: `dev` · Base: `b81314cd2`

## What changed about the rule

The first sweep (`devlog/_fin/260805_devlog_fin_sweep/`) archived a unit only
when the unit's **own record** stated a past-tense outcome. Landed code was
explicitly not enough: that standard is what kept nine units open whose
implementation was visibly on `dev` but whose phase docs still read as plans.

The repository owner overrode that standard for this sweep. The rule applied
here is:

> A unit is COMPLETE if its work has landed on `dev`.

No closeout doc, checked acceptance box, or past-tense rewrite is required. A
unit whose implementation is on `dev` while its own record still reads like a
plan is COMPLETE. Ambiguity resolves toward COMPLETE.

A unit stays OPEN only on positive evidence of unlanded work: an unmerged PR the
unit waits on, a named file or symbol demonstrably absent from the tree, or a
roadmap phase that was never implemented.

## Method

55 units in `_plan/`, adjudicated by eight read-only agents in batches of seven,
each verifying claims rather than reading them:

- `git merge-base --is-ancestor <sha> origin/dev` for every cited commit
- `gh pr view` / `gh issue view` for every cited PR and issue
- `rg` against `src/`, `gui/`, `tests/`, `scripts/`, `.github/` for every named
  symbol, file, and test

## Result

**48 COMPLETE, 7 OPEN.** `_plan/` 55 -> 7 units, 430 -> 99 tracked files;
`_fin/` 1884 -> 2215 tracked files. 331 files moved, none lost.

### The 7 that stay open

| Unit | Why it is not landed |
|---|---|
| `260801_monorepo_git_blobless_strategy` | No `blob:none` / blobless guidance exists in `CONTRIBUTING.md`, `README.md`, or any workflow. The proposed text lives only inside the unit. |
| `260802_codex_set_prompt_composer` | Only WP1 landed (`src/codex/prompt-layers.ts`). WP2-WP7 are absent: no `/api/codex-prompt` route, no `tests/codex-prompt-route.test.ts`, none of the three planned GUI tests. |
| `260806_disposition_sweep` | WP4 is unlanded. PR #1008 is CLOSED unmerged; `8e657f2a1`, `49cb22c3d`, `8d1eec899` are not ancestors of `origin/dev`; `src/usage/rollup.ts` does not exist. |
| `260814_bug_resolution_campaign` | Wave 6 requires #1302 and #1059 resolved — both still OPEN — plus bounded WebSocket buffering whose `tests/websocket-buffering-bound.test.ts` is absent. Nine campaign PRs are CLOSED unmerged. |
| `260814_usage_memory_roadmap` | Two of eight phases landed. `src/usage/segments.ts`, `src/usage/usage-index.ts`, `src/usage/projection-summary.ts`, and `src/server/supervisor-detect.ts` are all absent; `/api/usage` still reads the snapshot path. |
| `260816_codexrs_multiagent_v2_and_history_perf` | Only the C1 slice merged (#1812-#1815). Phase 2 is absent — `src/codex/history-provider.ts` still has an unguarded `updateSessionMeta`; Phase 4 is absent — `src/codex/features.ts` still carries the stale `[agents] max_threads` claim. |
| `800_agent-fabric` | Master plan is still `status: proposed`; FAB-01 is explicitly unauthorised and its database, event store, Task CLI, and Task Inspector do not exist. `src/lab/fabric/` is a Lab producer, not this platform. |

## Reference repointing

Moving a unit breaks anything that cites its path. 65 tracked files carried
`devlog/_plan/<moved-unit>` references and were repointed to `devlog/_fin/`,
including source comments (`src/routing/trace.ts`, `src/lib/lab-activation.ts`,
`src/providers/registry.ts`, `src/codex/desired-state.ts`, and eleven more),
test headers (`tests/core-lab-boundary.test.ts`,
`tests/lab-evidence-sanitization.test.ts`, and seven more), `AGENTS.md`,
`.github/CODEOWNERS`, and the `docs/superpowers/` plans. After the pass, `rg`
finds no `devlog/_plan/` path for any moved unit anywhere in the tree.

Relative `../` links were checked separately: every one resolves inside its own
unit, so no cross-unit link was invalidated.

## Gates

- `bun test tests/repo-hygiene.test.ts` — 11 pass, 0 fail. The security tripwire
  reads `_plan/` only, and its shrunken scope still asserts non-empty.
- `bun run privacy:scan` — passed.
- `bun x tsc --noEmit` — clean.
- `git ls-files -s devlog` shows one `100755`, the pre-existing
  `_fin/260731_structure_sot_refresh/004_measure.sh`; every moved file is
  `100644`.
