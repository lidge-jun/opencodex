# 260718 — dev CI stabilization + second PR absorb round

## Objective

User-approved (push pre-approved): stabilize Cross-platform CI on dev, absorb
the new community PRs (#149 docs, #148 Combos GUI), request changes on #144,
evaluate our draft #138, pushing dev after each landed phase.

## Phase map

| Phase | Doc | Scope |
|-------|-----|-------|
| 010 | `010_ci_windows_fix.md` | Fix 4 windows-latest test failures on dev; push; green run evidence |
| 020 | `020_pr149_docs_reconcile.md` | #149 vs landed 9a6e20e6; absorb additive or close superseded |
| 030 | `030_pr148_combos_gui.md` | Combos GUI workspace adapted to landed combo runtime; Wibias authorship |
| 040 | `040_pr144_138_closeout.md` | #144 request-changes comment; #138 evaluation; final push + CI green |

## CI failure inventory (run 29599494055, windows-latest, dev)

- `doctor-gui-if-changed > DRY_RUN prints the run/skip decision` — exit 1 vs 0
- `doctor-gui-if-changed > degrades gracefully when doctor engine unavailable` — exit 1 vs 0
- `OpenAI provider-option integration spine > keeps Pool, Direct, and API ownership stable` — toEqual mismatch
- `two-lock xAI refresh > replacement between stale inspections survives`

Suspected: `new URL(...).pathname` produces `/D:/...` on Windows breaking
`Bun.spawnSync(["bun", script])`; provider-spine/xai-lock failures need
per-test diagnosis (possibly path or file-lock semantics on win32).

## Boundaries

- dev only; pushes to origin dev pre-approved; preserve user dirty files
  (README.zh-CN.md edits, deleted tests/codex-multi-state.test.ts).
- #148 backend src/ files are NOT absorbed (our 020/030/040 stack supersedes);
  GUI surface only, adapted to landed API.
- #144 stays open (request changes; not superseded by our work).
