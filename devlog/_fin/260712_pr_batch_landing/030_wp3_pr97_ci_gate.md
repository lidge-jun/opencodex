# WP3 — Land #97 as-is (gate returns enhanced in #99) — AMENDED at WP3-P

Base: fork branch `codex/strengthen-ci-release` (tip `c6af7f90`, contains #96 commits below).
After #96 merges, this PR's effective diff = c6af7f90 only.

## AMENDMENT (WP3-P discovery)

Stack inspection shows `e8794d22` (#99) RE-ADDS the gate STRONGER — separate "GUI lint" +
"GUI build" steps at the same location (verified:
`git diff wibias/codex/strengthen-ci-release wibias/codex/gui-lint-remediation -- .github/workflows/ci.yml`).
The #97 deletion is a stack-internal transition, not a permanent regression. Restoring the old
step on #97 would only create an extra ci.yml conflict at WP5's already-manual merge.

Decision: merge #97 AS-IS. The gate gap on main is bounded to this controlled landing window
(only this batch lands between #97 and #99; both merges happen in this session). Final main
state carries the ENHANCED gate. Reviewer's High blocker is satisfied at batch end; disposition
recorded here + in the ledger. Guard against future silent gate removal moves to WP6: add an
assertion to `tests/ci-workflows.test.ts` (owned by #101's branch) that ci.yml contains the
GUI lint + GUI build steps.

## Steps

1. Wait main CI green for the #96 merge (rollback policy).
2. `gh pr ready 97` → `gh pr merge 97 --merge` (branch is MERGEABLE/CLEAN, no local edits).

## Accept criteria

- c4 (final-state, verified at WP5 close + WP6): ci.yml on main contains GUI lint+build steps;
  ci-workflows test asserts their presence (added at WP6).
- #97 MERGED; checks green. Expected repository diff this WP: none (merge-only).
