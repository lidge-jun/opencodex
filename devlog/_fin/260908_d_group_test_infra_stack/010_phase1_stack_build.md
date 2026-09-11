# Phase 1 — Build the stack locally

Base: fetched `origin/dev`. Both source commits live in the `luvs01` remote
(`https://github.com/luvs01/opencodex.git`), already configured in this checkout.

## Commands

```sh
git fetch origin dev
git fetch luvs01 e24163231edeaa09a30a99ca1746e3b573af78ae 141077f7270e2f2a0564fb036d091f0cf793b784

# Layer 1 — PR #3924
git switch -c codex/260908-d-group-l1-test-runner-output origin/dev
git cherry-pick -x e24163231edeaa09a30a99ca1746e3b573af78ae

# Layer 2 — PR #3930, tip
git switch -c codex/260908-d-group-l2-cursor-watchdog
git cherry-pick -x 141077f7270e2f2a0564fb036d091f0cf793b784
```

`cherry-pick -x` keeps the original author identity
(`luvs01 <27862058+luvs01@users.noreply.github.com`>) and appends the
`(cherry picked from commit ...)` provenance line. No `Co-authored-by` trailer is
needed on the commits themselves because authorship is not being reassigned. The
trailer goes in the tip pull-request description for hygiene acceptance; phase 3
separately supplies and verifies the trailer on the landed squash commit, which is
the only thing GitHub reads for contributor credit.

## Expected change map

| Layer | File | Change |
|---|---|---|
| 1 | `scripts/test.ts` | +81 −8 — incremental capture, retained output on timeout, bounded drain, incomplete-capture exit policy |
| 1 | `tests/ci-workflows/test-runner.test.ts` | +147 −1 — regressions for timeout/failure/success output, split UTF-8, open pipes, read failure |
| 1 | `docs-site/src/content/docs/contributing.md` | +6 — documents the timeout and incomplete-capture behavior |
| 2 | `tests/providers/cursor/cursor-stream-health.test.ts` | +59 −26 — one scaled silence budget S, 2S heartbeat-only, ≥3S observed progress after first received text |

Cumulative tip versus `origin/dev`: exactly those four files.

## Conflict expectation

None. The two file sets are disjoint, and the Cursor test file plus its
`tests/helpers/ci-watchdog.ts` import carry identical blob SHAs at `dev` and at
#3924's head (`dc7b572bf1` and `f8adcfe3d9`), so layer 2's preimage is unchanged by
layer 1.

## Acceptance

- `git log --format='%an <%ae>'` on both new commits reports `luvs01`.
- `git diff --name-only origin/dev..tip` lists exactly the four files above.
- `git diff --stat` matches the per-file counts in the table.
- Each cherry-picked tree is byte-identical to the source PR head's version of its files.

Local suite: NOT RUN (owner instruction).
