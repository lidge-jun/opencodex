# 260719 — Community PR #152–#159 absorb onto dev

## Objective

User decision (2026-07-19): review and absorb the seven open Wibias community PRs
(#152, #153, #154, #156, #157, #158, #159 — all base `main`) onto `dev` via
sequential PABCD cycles, one PR-group per work-phase, with Sol
(`gpt-5.6-sol`, priority tier) subagent reviewers at every A-gate. No push / no
GitHub write without separate approval (DEV-GIT-PUSH-01).

Base anchor: every PR head has merge-base `6f854541` (= `origin/main`). Local
`dev` moved to `eb1c39e5` (qwen3.8 prewire — touches `src/providers/registry.ts`
and two test files, overlapping phase 060's registry hunk) during planning;
merge-tree re-verified clean for all seven PRs against `eb1c39e5`.
**Per-cycle stale check (mandatory at each implementation P):**

```bash
git merge-tree --write-tree dev <source-branch>      # conflict re-check vs current tip
git diff dev...<source-branch> --stat                # re-derive the change set
git log --oneline <last-recorded-dev-tip>..dev -- <files-in-phase>  # adjacency drift
```

Record the observed dev tip in the phase doc before building.

## Source refs (immutable snapshots — never rewritten)

| PR | Title | Local source branch | Head | Size |
|----|-------|---------------------|------|------|
| #152 | keep configured port after update restart | `codex/source-pr152-e91da081` | `e91da081` | 10 files +180/−22 |
| #153 | GitHub Copilot device-flow login | `codex/source-pr153-1034be9c` | `1034be9c` | 12 files +735/−13 |
| #154 | GUI dialog overlay + focus ring | `codex/source-pr154-5e8f1aa1` | `5e8f1aa1` | 2 files +26/−2 |
| #156 | Kimi multi-account via JWT user_id | `codex/source-pr156-a6d824ee` | `a6d824ee` | 3 files +188/−4 |
| #157 | Windows icacls ACL soft-fail | `codex/source-pr157-e19f38be` | `e19f38be` | 2 files +113/−31 |
| #158 | web-search client aborts → 499 | `codex/source-pr158-67b660bc` | `67b660bc` | 4 files +158/−18 |
| #159 | Cursor totals + Kimi usage quota | `codex/source-pr159-90eca76e` | `90eca76e` | 2 files +223/−59 |

## Diff-level convention for absorb units

This is an absorb unit: for every phase the executable base diff IS the
immutable source branch — `git diff dev...codex/source-prN-<sha>` is the exact
NEW/MODIFY/DELETE map and before/after content, reproducible at any time from
the pinned refs above. Decade docs therefore do not duplicate those hunks; they
specify (a) the pick/commit map over the source commits, and (b) maintainer
repairs at function-level precision (named functions, decided semantics,
activation-test mechanics). Rollback per phase = `git revert` of that phase's
landed commits (each phase lands as its own contiguous commit group).

## Attribution contract

Same as `260718_pr145_147_dev_absorb/000_plan.md`: source-faithful contributor
work → author `Wibias <37517432+Wibias@users.noreply.github.com>` with maintainer
committer; maintainer repairs/redesign → maintainer author +
`Co-authored-by: Wibias <37517432+Wibias@users.noreply.github.com>`. Commit
bodies name the source PR + exact source head. Immutable `codex/source-*` refs
are never rewritten.

## Phase map (dependency-ordered)

| Phase | Doc | PR | Scope | Depends |
|-------|-----|----|----|---------|
| 010 | `010_pr152_port_stickiness.md` | #152 | update-restart port pinning, Windows console hide, usage-debug test shrink | — |
| 020 | `020_pr157_acl_softfail.md` | #157 | windows-secret-acl spawnSync/retry/lock + soft-fail | — (isolated file; after 010 for serial order only) |
| 030 | `030_pr156_kimi_identity.md` | #156 | Kimi JWT identity → multi-account append/upsert | — (oauth/store adjacency before #153) |
| 040 | `040_pr158_abort_499.md` | #158 | errors.ts + request-log 499/client_cancel classification | — |
| 050 | `050_pr159_quota_accuracy.md` | #159 | quota.ts Cursor totals + Kimi limits[] mapping | — |
| 060 | `060_pr153_copilot_oauth.md` | #153 | C4 security surface: new oauth module + transport + registry flip | file-adjacency only: 030 (store.ts), 040 (responses.ts/errors.ts), dev registry drift — stale-check, not semantic dependency |
| 070 | `070_pr154_gui_overlay.md` | #154 | GUI dialog/focus fix | — (independent) |
| 080 | `080_integration_closeout.md` | all | integration closeout: full typecheck/test/privacy-scan/gui build; owns cross-PR breakage repair | all prior |

Ordering rationale (A-gate amendment 2026-07-19): the seven PRs are mutually
independent units — no semantic build-order dependency exists between them, so
PHASE-SPLIT-01 dependency ordering reduces to minimizing stale-check surface:
phases sharing files (030/060 on `store.ts`; 040/060 on
`responses.ts`/`errors.ts`) run so the later phase re-verifies against the
earlier phase's landed tree once. 060 runs late because its stale-check set is
the largest (registry.ts also drifted on dev), not because it is "big". 080 is
the integration closeout that owns cross-PR breakage repair, so no per-PR phase
carries an unrelated global gate.

Excluded from this unit: #150 (maintainer's own draft rollback safety net),
#144 (Frontier guide page — separate feature decision, not in the user's list).

## Review evidence (A-gate, Sol priority reviewers 2026-07-19)

Four parallel Sol `gpt-5.6-sol` high-effort reviewers dispatched at roadmap P:
lane A = #152+#157, lane B = #156+#158, lane C = #159+#154, lane D = #153
(security-focused, C4). Verdicts and folded blockers are recorded per decade doc
under "Sol review verdict".

## Verification contract per implementation cycle

- `bun run typecheck` exit 0 (root `tsc` covers `src/` only — GUI compilation is
  owned by `gui/` scripts; GUI phases add `cd gui && bun run build`).
- Focused `bun test` for the touched test files.
- C-ACTIVATION-GROUNDING: each conditional path added (soft-fail branch, 499
  remap, JWT fallback, retry loop) must be shown firing by a test.
- 080 runs full gates: `bun run typecheck`, full `bun test`,
  `bun run privacy:scan`, `cd gui && bun run build`.
- GUI change (070): render-grounding observation of the dialog overlay,
  driving pointer-close and keyboard-close separately (no ring vs visible ring).
