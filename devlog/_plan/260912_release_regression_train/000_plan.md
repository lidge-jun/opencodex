# Release regression train

dev has drifted 79 commits past its last verified state and nothing has published since
2.51.0. This unit takes dev back to a proved-green head, sweeps every commit in the
unverified window for regressions, and then promotes preview and main with real
push-event CI evidence behind each publish.

## Baseline

- `main` `c155cc7923`, version 2.51.0.
- `preview` `69207f1b08`, version 2.52.0-preview.20260911.
- `dev` `c27a4831a9`, package.json 2.52.0, no CI run recorded for this exact head.
- Last `dev` run with `conclusion=success`: `e432cf565a` (2026-09-12 03:51 UTC).
- Unverified window `e432cf565a..dev`: 79 commits, 57 non-merge, 58 `src/` files,
  +3616/-229 inside `src/` alone.
- Eleven dev push runs after that green ended `cancelled`, because `ci.yml` sets
  `concurrency: cross-platform-ci-${{ github.ref }}` with `cancel-in-progress: true`
  and the merges arrived faster than a run could finish. The twelfth, `f9815da21f` at
  08:15 UTC, was allowed to finish and concluded `failure`. dev is red, not merely
  unverified, and the current head `c27a4831a9` has no run at all.
- `release.yml` refuses to publish a SHA without a successful push-event `ci.yml`
  run on the release branch itself, so a red or unrun dev cannot reach a release.

## Why the feature backlog stays out

Twenty-seven open 60plus PRs are implemented and reviewed but unlanded. Adding them now
would enlarge an already unverified window and make any regression bisect useless.
They ship in the next cycle. Only two classes of change enter dev here: the shared
CI repair in #4390, and fixes for regressions this sweep actually finds.

## Cycles

| Work phase | Document | Outcome |
|---|---|---|
| wp1 | this file | roadmap locked, later units pre-written |
| wp2 | 010_ci_repair.md | #4390 green, merged, dev push CI success |
| wp3 | 020_regression_sweep.md | every commit in the window reviewed |
| wp4 | 030_defect_landing.md | blocking findings fixed and re-greened |
| wp5 | 040_preview_release.md | preview promoted and published |
| wp6 | 050_main_release.md | main promoted and published |

## Constraints carried from the campaign

Local product tests, builds, typecheck, and installs are not run. Verification is
remote CI only and local checks are reported as NOT RUN. Pushes use `--no-verify`.
Subagents are read-only verifiers dispatched on `xai/grok-4.6` at the user's explicit
instruction; the stored subagent role configuration is left untouched. No account,
credential, or model settings change. Already merged PRs are never recreated or
reverted.

## Stop conditions

Stop and escalate if the sweep finds a defect in authentication, credential handling,
or release automation. Stop if a policy gate outside maintainer control blocks the
same step three times. Hitting a stated resource bound is BUDGET_EXHAUSTED, not DONE.
