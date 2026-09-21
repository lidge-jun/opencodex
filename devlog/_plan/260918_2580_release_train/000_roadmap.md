# 2.58.0 release train

Open. This unit carries the 2.58.0 release from the current `dev` tip through promotion and
publication, and records the evidence each step actually produced.

## Why this unit exists

The 2.58.0 line accumulated in one day: a stabilization round that closed send-budget accounting,
third-party Responses compatibility, Cursor tool-marker and overflow handling, safe teardown and
configuration reporting, model discovery and capacity reporting, and a dependency-audit bump, plus
the native control stack landing behind default-off flags. That is more surface than a patch
release, and the promotion path is the same one 2.57.0 used, so the sequence is written down before
it runs rather than reconstructed afterwards.

## Sequence

| Step | Gate | Evidence to record |
| --- | --- | --- |
| Land the native control stack | Each layer replayed onto the current `dev`, verified byte-identical against its pre-rebase diff, flags default-off | PR numbers, exact heads, per-layer CI |
| Freeze the candidate | `dev` tip with `package.json` at 2.58.0 | Candidate SHA, its push run |
| Full-platform regression | `ci.yml` dispatched on the candidate with `lane=all` | All nine Windows shards individually, Linux shards, macOS legs |
| Move `dev`'s version line | `dev-version-bump.yml` opens the bump to the next minor | Bump PR and merge commit |
| Promote to `main` | Promotion PR from the candidate | Merge commit, `enforce-target` red by design |
| Prove the release SHA | CI on the merge commit | Run id and conclusion |
| Publish | `release.yml` with version, `tag=latest`, `dry-run=false`, `expected-sha` | Run id, publish line, provenance, GitHub release |
| Promote to `preview` | Promotion PR, version line resolved to `main` | Merge commit, empty diff against `main` |
| Registry propagation | Registry read after publish | Whether availability was confirmed or still pending |

## Rules this train follows

No local suite, typecheck, build, install, or `ocx` invocation is used for any gate. Every claim
comes from hosted CI at an exact SHA. `scripts/release.ts` is not run locally for the same reason:
its preflight runs the suite. The workflow it would dispatch is dispatched directly instead, with
the same inputs, so the published artifact is produced by the same job.

A cancelled job is not a failure and not a pass: it produced no result. Re-running it is recovery.
Nothing is merged or published on a red gate that describes a real defect, and no budget is widened,
retry added, or platform skipped to make a gate green.

## Known open items carried into this release

The contributor readiness gate holds two fork pull requests that are otherwise verified; their
authors have the evidence and the remaining step is theirs. #4800 is not merged: the lane proved the
provider retry policy it edits is unreachable from the Responses passthrough lane, and #4893 records
the real defect. The native stack ships with both feature flags default-off, so an installation that
does not opt in sees no behaviour change from it.

