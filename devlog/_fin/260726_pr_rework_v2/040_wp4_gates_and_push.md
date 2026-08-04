# 040 — WP4: full gates, push, and PR close-out

No source change of its own. This phase proves the three landed PRs hold together
and communicates the outcome back to each contributor.

## Gates

| # | Command | Expected |
|---|---------|----------|
| 1 | `bun run typecheck` | exit 0 |
| 2 | `bun run test` | zero failures, count at or above baseline plus the landed PRs' new cases |
| 3 | `gui: bun run test` | zero failures (baseline 218) |
| 4 | `bun run lint:gui` | eslint clean |
| 5 | `bun run privacy:scan` | passes — load-bearing because WP2 adds a log line |
| 6 | `bun run build:gui` | succeeds |

Baseline for comparison, measured earlier this session on `1c33fb52`: root 4461
pass across 340 files, GUI 218 pass across 55 files.

## Push

`git push origin dev`, then confirm `git rev-parse HEAD` equals
`git ls-remote origin refs/heads/dev`. If the push is rejected because origin
moved, rebase — never force — and RE-RUN the gates on the new base before
retrying, since a clean rebase does not prove the result still passes.

## PR close-out

For each landed PR (#489, #464, #483), post a comment naming the integration
commit and the fact that authorship was preserved, then verify GitHub's own
state rather than assuming: pushing the author's commits can flip a PR to
`MERGED` automatically, as happened with #403 earlier in this session.

For the held PRs, no state change. The classification in `000_plan.md` records
why; posting review verdicts on eight security-boundary PRs is its own unit and
is not smuggled into this phase.

## Terminal outcome

Report per work-phase: WP0 roadmap lock, WP1–WP3 per-PR DONE/NOOP, WP4 DONE with
the gate evidence.
