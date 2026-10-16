# 260923 P5 — CI and release scope gaps

## Objective

Remove the CI and release waste and blind spots found after the 2.61.0 and 2.63.0 releases
without widening routine pull-request CI. One branch, `codex/260923-p5-ci-release-gaps`, cut from
`origin/dev`, ordered commits, one pull request to `dev`.

## Evidence that shaped the plan

### Release version conflict (run 35783865160)

| Event | Time (UTC, 2026-09-22) |
| --- | --- |
| Preview release run 35781975066 created | 20:42:00 |
| Stable release run 35783865160 (2.62.0, main) created | 21:00:02 |
| `v2.63.0-preview.20260923` GitHub release published by the preview run | 21:06:11 |
| Preview run finished | 21:06:14 |
| Stable run's first job (`validate-dispatch`) started | 21:06:35 |
| Stable run's `publish` failed at "Refuse a release the current tag set already outranks" | 21:25:36 |

The stable run did not start work until the preview run released the workflow-level
`concurrency: { group: release, cancel-in-progress: false }` slot. The runs were already
serialised. The conflicting tag existed before the stable run's first job, and the ordering gate
that rejects it ran only in `publish`, after about nineteen minutes of packaging and
verification. The waste is check placement, not a missing lock. The fix is a cheap
`preflight` job that runs first, while the `publish` copy stays as the final authority because
tags, releases and npm state can still move while a run packages (a manual tag push, a first
local publish). No new coordination is added; the existing shared group is pinned by a test so
it cannot silently become per-ref, which is what would let a stable and a preview run overlap.

### Registry confirmation

`Post-publish registry smoke` retries `npm view <pkg>@<version> version` six times, warns
"Registry lookup not confirmed", records `verification=pending`, and the run continues to the
GitHub release. `npm dist-tag ls` is printed to the log only. A green run therefore reads the
same whether or not the registry and the dist-tag were ever read back.

### Shard imbalance (run 35816902207, four Linux shards)

Per-file durations were measured from the timestamps of Bun's per-file `##[group]` and
`##[endgroup]` lines in the hosted job logs (1,558 files, 1,261 s of test time). Sorted
round-robin by count gives 364 / 394 / 248 / 254 s of test time per shard. Greedy
longest-first assignment to the least-loaded shard gives 315 / 315 / 315 / 315 s. With equal
weights the same greedy pass over path-sorted files reproduces round-robin exactly, which
makes "unknown duration" a deterministic, backwards-compatible fallback.

Duration-balanced shards change which files share a twelve-file process. The simulated largest
batch rises from 74 s to 89 s against the 120 s Linux process timeout. Closing a batch once its
predicted duration would pass half the process timeout brings the largest batch back to 70 s
(one file that is already about 70 s on its own) at a cost of one or two extra processes per
shard.

### Scope gaps

The `changes` job's `ci` filter omits `.github/actions/**` and `native/**`. A pull request
that touches only `.github/actions/setup-project-bun/action.yml` or only
`native/remote-workspace-helper/**` runs no job that exercises what it changed, and the
aggregate `ci` check reports success over skips.

## Constraints

- Security boundary (AGENTS.md, MAINTAINERS.md): no new workflow or job permission beyond
  `contents: read` for new jobs, no secret in a log, only SHA-pinned actions that the repository
  already uses, no `pull_request_target` surface.
- Ordinary PR CI time must not grow; test shard count stays 4 / 2 / 1 / 9; fresh-process
  isolation and every time ceiling stay.
- `scripts/ci/run-bun-test-batches.sh` changes stay inside the selection and batching loops so
  they stay separable from open PR #5456 (timeout probe and Bun invocation lines).
- The `devlog/**` privacy gap belongs to open PR #5469 and is not touched.
- Lane rule: no local suite, focused test, typecheck, build, install, proxy or service run.
  Evidence is static reading plus hosted CI on the exact pull-request head.

## Work-phase map (dependency order)

| ID | Doc | Outcome |
| --- | --- | --- |
| wp0 | this unit | Roadmap locked before implementation |
| wp1 | [010](010_release_preflight.md) | `preflight` job before packaging; final check kept in `publish` |
| wp2 | [020](020_release_outcome_report.md) | GitHub release and npm version / dist-tag reported as separate outcomes |
| wp3 | [030](030_shard_balance.md) | Shards assigned by recorded duration; batches bounded by predicted time |
| wp4 | [040](040_scope_gap_checks.md) | Narrow jobs for the setup action and the remote-workspace helper |
| wp5 | [050](050_delivery.md) | Push, one PR, exact-head hosted CI |

wp1 precedes wp2 because both edit `release.yml` and the report reads the publish job's outputs.
wp3 and wp4 are independent of the release work and of each other; wp4 edits `ci.yml`, which wp3
touches only in a comment.

## Acceptance criteria (goal level)

1. Each item has a `tests/ci-workflows` test that fails on the old workflow shape and passes on
   the new one.
2. Ordinary PR CI time does not grow.
3. The release changes pass the security-boundary checklist above.
4. `structure/ops/cross-platform-ci.md` and `structure/ops/docs-and-release.md` describe the new
   order.
5. One pull request to `dev` with every template section filled; exact-head hosted CI complete.

## Verification policy

Local checks: NOT RUN (lane rule). The one exception considered is generating the committed
duration table with the repository's own refresh tool from downloaded hosted logs; it is a data
generator, not a check, and it is recorded where it happens (030).

## Architect consultation record

Proposal (read-only architect, decisions D1-D4) and main dispositions:

| ID | Proposal | Disposition |
| --- | --- | --- |
| D1 | Ordering gate as an extra step in `validate-dispatch`, run from the default-branch checkout; publish gate stays | Amended: a separate `preflight` job on the dispatched commit that also checks channel, version sources, tag, GitHub release, npm and dev readiness. `validate-dispatch` stays minimal (its permissions and shape are pinned) and the scripts that decide are the ones `publish` will run anyway. Accepted: the late gate never moves. |
| D2 | Make the registry smoke fail the run after unconfirmed reads | Rejected: the lane requires publishing behaviour to stay as it is. Adopted the underlying concern instead: the unconfirmed state becomes an explicit, separately reported outcome (020). |
| D3 | Weighted LPT in the selection loop, pure shell, equal weights reproduce round-robin, re-sort each shard by path | Accepted. Amended with a coverage guard (whole assignment must tile the general files) and a predicted-duration batch budget, both from the simulation in 030. |
| D4 | Two narrow filters and jobs mirroring `structure-gate`; PR scope only; aggregate wiring | Accepted, with the filter narrowed to `native/remote-workspace-helper/**` and, from the risk list, a validation step that fails loud on a malformed filter output. |

Reflection check and independent audit: not obtained. The lane allows one subagent model, and
every call to it after the proposal (one reflection, seven audit attempts over about an hour)
returned a provider `resource_exhausted` error. The audit was performed by the main agent against
the same checklist and is recorded below; it is not independent.

## Audit record (main agent)

Verdict: near-pass. Blocker folded: the preflight test's fixture e-mail used `example.invalid`,
which `scripts/privacy-scan.ts` rejects (allowed fixture domains are `example.com`,
`example.test` and `*.test`); changed to `example.test`. Checked without finding a defect:
generic `ci.yml` job rules (numeric `timeout-minutes`, aggregate `needs` equals every job,
checkout never persists credentials, no `@vN`/`@main` action refs); `GATED_JOBS` equals every job
but `ci`; the pinned `structure-gate widget` line and push-paths-equal-`ci` rule; publish-job
step lookups by first name and by `assert-releasable` stay inside `publish`; `attach-release`
step-order assertions; the registry smoke executed test's npm call shapes; file-size ratchet
(threshold 2,000 lines, the table is below it); root typecheck covers `src` only; bash 3.2 and Git
Bash constructs in the runner block (no associative arrays, `$'\t'`, arithmetic assignment forms,
`getline` table load that works when the table is `/dev/null`). Residual: the new jobs' real
runner behaviour (live confinement on hosted macOS/Windows, the composite action on three OSes) is
provable only by this pull request's own hosted run.
