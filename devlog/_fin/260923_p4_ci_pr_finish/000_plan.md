# 000 — Finish three contributor CI pull requests in place

## Objective

Land three open contributor pull requests on their own branches instead of replacing them:
#5469 (privacy scan on devlog-only changes, issue #5468), #5456 (Bun test batches without GNU
`timeout`) and #5471 (latest-dev readiness wording, issue #4443). Each branch receives
maintainer-edit commits, is brought onto current `dev` by merge, and is judged by the full
required CI at its exact head. No new pull request is opened; merge, labels that attest a
maintainer review, and issue closure stay with a maintainer.

## Constraints

- Local checks are not run (no suite, focused test, typecheck, build or install). Evidence is
  the diff read statically plus hosted CI at the exact head SHA.
- A hosted failure is fixed at its cause, never by weakening the assertion.
- `.github/workflows/ci.yml` is a security boundary: no new permissions, no secrets in logs,
  no mutable action refs, no new `pull_request_target` surface.
- Test files at a size cap get a sibling file registered in `scripts/test-layout/layout.json`
  and `tests/fixtures/test-layout-expected.json`. Counts and constants are derived, not restated.

## Starting state (dev at e9643875f0)

| PR | Head | Conflicts with dev | Hosted state |
|---|---|---|---|
| #5469 | f32b7cafca | `ci.yml`, `ci-structure-gate.test.ts` | `hygiene` and `enforce-target`: `unsponsored_surface`; Cross-platform CI awaiting approval |
| #5456 | ec95a6029b | `run-bun-test-batches.sh`, `ci-crash-disposition.test.ts` | review open: the fallback drops the batch deadline |
| #5471 | a5810630eb | `pr-quality.cjs`, `pr-quality.test.cjs` | review open: the #4443 overlap wording is a maintainer call |

Both #5469 failures are one rule: a `.github/workflows/` change without the
`maintainer-sponsored` label. That label records a maintainer security review, so it is
reported for a maintainer decision rather than applied by this lane.

## Work-phase map

The three pull requests share no file, so after this roadmap they are independent.

| Doc | Work-phase | Verifiable close |
|---|---|---|
| [010](010_pr5469_privacy_gate.md) | #5469 privacy gate onto dev | Cross-platform CI at the new head, including `ci-privacy-gate`, `ci-review-lanes`, `ci-scope-reduction` and the test-layout guards |
| [020](020_pr5456_batch_deadline.md) | #5456 portable batch deadline onto dev | Cross-platform CI at the new head, including the executed `ci-crash-disposition` runner cases |
| [030](030_pr5471_latest_dev_wording.md) | #5471 derived latest-dev wording onto dev | Cross-platform CI at the new head, including the `.github/scripts` node suites and the enforce-pr-target harness tests |

## Delivery per pull request

1. Local branch from the contributor head, merge `origin/dev`, resolve, commit the fix.
2. `git push --no-verify` to the contributor branch (maintainer edits are allowed on all three).
3. Approve the awaiting Cross-platform CI run for that exact run id, then read every job.
4. Leave a short English comment on the pull request stating what was pushed and why, and
   which workflow security checks were made where applicable.
