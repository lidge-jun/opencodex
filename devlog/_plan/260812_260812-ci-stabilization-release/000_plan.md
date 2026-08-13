# 000 — dev CI stabilization and v2.13.0 release plan

## Objective

Ship the current `dev` tree only after the exact selected commit has repeatable
Cross-platform CI and Service lifecycle evidence. Promote that immutable source
independently into `preview` and `main`, publish
`2.13.0-preview.20260812` and `2.13.0`, and verify every public artifact.

Observed evidence at plan time:

- Cross-platform CI failed deterministically at `d66736752` because the GUI
  `gates` job reported 25 async React assertions; the same GUI suite passed on
  local macOS and on a clean Linux host.
- The current remote `dev` head `fd59bd270` has a complete successful push run,
  GitHub Actions run `31570185184`: 771 GUI tests, 0 failures; all Linux shards,
  macOS, keyring, npm-global, storage policy, API usage, and aggregate `ci`
  succeeded.
- Audit found that `fd59bd270` obtained that green run after replacing the
  repository-wide `bun x tsc --noEmit` gate with a narrow doctor-contract
  tsconfig. The full typecheck still passes locally, but the workflow no longer
  proves it. This is a release blocker until CI runs both checks.
- Cross-platform CI attempt 2 on the same SHA failed the same 25 GUI tests.
  Reproduction on the clean Linux host under `CI=true` proved the boundary:
  `bun test tests` is order-sensitive, while `bun test --isolate tests` passes
  all 771 tests. The gates job must isolate GUI test files so module globals,
  fetch stubs, timers, DOM, and pending React work cannot leak across files.
- Service-trigger files changed since `v2.12.0`, so Service lifecycle evidence
  is required for the selected RC even when the latest ordinary push did not
  trigger that workflow.

## Loop spec

- Work class: C4, because branch promotion and npm publication are release
  surfaces.
- Loop archetype: verifier-defined; success is exact-SHA CI/release evidence.
- Write scope: release-plan records, the three integration branches, package
  version metadata produced by `scripts/release.ts`, git tags, GitHub Releases,
  and npm dist-tags.
- Out of scope: open PRs, issue closure, contributor branches, unrelated code,
  and security findings not already public.
- Bound: one stabilization/release work phase. Any exact-SHA gate failure returns
  to diagnosis before promotion or publication.

## Work-phase map

| WP | Doc | Slice | Depends on |
|----|-----|-------|------------|
| wp1 | `010_phase1.md` | patch CI → security review → push → freeze RC → repeat gates → sibling promote → preview/stable publish → dev convergence | none |

## Acceptance criteria

1. The selected RC has two successful Cross-platform CI runs, including
   successful `gates` and `macos` jobs.
   The `gates` job must retain the repository-wide typecheck and add the narrow
   doctor-contract typecheck rather than substituting it.
   The GUI suite must run with `--isolate` and pass all files.
2. The selected RC has a successful Service lifecycle run.
3. Independent audit and explicit security review report no release blocker in
   the CI workflow diff, RC evidence, promotion topology, version choice, or
   recovery procedure.
4. `preview` and `main` each contain the exact RC as an ancestor; preview is not
   merged into main.
5. Preview and stable version commits each pass Cross-platform CI and Service
   lifecycle on their exact SHA before `release.yml` publishes them.
6. npm dist-tags, git tags, GitHub Releases, and remote branch tips match the
   intended versions and SHAs.
7. `dev` converges to the stable package version and its final push CI is checked.

## Bypass and rollback record

- Tier: E6/E7 operational gate.
- Executing surfaces: GitHub Actions, `scripts/release.ts`, maintainer CLI.
- Known bypass: a maintainer can use `--no-verify` or manually dispatch a
  workflow. `release.yml` still checks an exact expected SHA and CI evidence.
- Residual risk: repository administrators can alter workflows or public
  metadata; this is a release gate, not an unbypassable security boundary.
- Before publication, revert a bad promotion with an ordinary commit; never
  rewrite shared branch history.
- After publication, npm versions are immutable. Roll forward with a new patch
  release and update dist-tags; do not unpublish.
