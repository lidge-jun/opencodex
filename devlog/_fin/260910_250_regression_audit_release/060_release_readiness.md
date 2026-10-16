# Release-readiness decision (wp3)

wp3 was scoped to triage and remediate release-blocking findings. **The audit produced
none**, so there is nothing to remediate and this cycle is a decision record instead.

## The decision

Promote and publish freeze SHA `12c248f52bed88ea13be5b284c79a238feb592d1` as 2.50.0.

## What the decision rests on

| Evidence | Detail |
| --- | --- |
| Six independent lanes | All returned `NO-BLOCKER` against the eight clauses, 23-41 files read each, covering all 94 changed product paths |
| Candidate-tree CI | Run `34457689927`, `ci.yml` with `lane=all` on `12c248f52`, attempt 2 conclusion **success** |
| Focused local suites | 84 pass / 0 fail across the web-search bridge, Lab/core boundary, privacy masking, `skills/ocx` surface, body-size limit, live service-manager guard, and context-overflow |
| Main-session re-derivation | Seven invariants re-checked directly rather than accepted from a lane |
| Independent decision audit | Reviewer round 4 returned **GO** and confirmed the release sequence has no defects |
| Freeze tree | `git rev-parse 12c248f52^{tree}` = `d8f5a7143bcd6cb86185c4e8d4c6a6c4ad0fa822`, the value the promotion merge must reproduce |

## The CI flake, and why it is not being fixed first

Attempt 1 of run `34457689927` failed one job. One test —
`CodeRabbit Log Guard reclaim regressions > classifies continuous progress stopped by
MAX_ITERATIONS as bounded work` — exceeded the suite-wide `--timeout 60000` after taking
112,853.92 ms on Windows shard 5/6. Everything else passed: 4058 pass, 15 skip, 1 fail.

Every file on that failure path is byte-identical to the released 2.49.0 tree:

| File | Blob at `2f3f73629` and at `origin/dev` |
| --- | --- |
| `src/codex/log-guard/maintenance.ts` | `81b3a465b5dbddc11c7431b99fec52012b61cf65` |
| `tests/codex-integration/codex-log-guard-maintenance-coderabbit.test.ts` | `54e83bba2a62b9fffd39f88839f3c339e1c26080` |
| `tests/helpers/remove-tree.ts` | `53e36a584c627b75a3c3b58a28e2bd17d7636b8b` |

`tests/preload.ts` is the one file on that path the delta does touch, and the change is
a comment block only — no statement changed. The round-4 reviewer caught that the first
version of this proof enumerated three blobs and called it "every file on the failure
path"; the diff is recorded here so the claim is complete rather than merely true.

Rerunning the failed job produced attempt 2 with conclusion `success`, which also
demonstrates the mechanic the release gate depends on: `release.yml` searches
`gh run list --workflow ci.yml --commit "$GITHUB_SHA" --event push` and reads the run's
conclusion, and a rerun updates that conclusion in place.

Hardening the timeout would move the freeze SHA, void this audit, and reopen every gate
for a test that 2.49.0 already shipped with the same bytes and the same limit. The
mitigation is the rerun, applied again on the promotion merge if it recurs.

## Recorded limits of the audit

The round-4 reviewer named three, and they are recorded rather than argued away.

1. **Every lane was a static reader.** `NO-BLOCKER` means no clause matched a read, not
   that the new SSE bridge cannot hang at runtime. The 84 focused tests and the full
   `lane=all` CI run are what cover the dynamic half; the lane verdicts alone are not.
2. **The re-derivation table checks invariants, not the packet questions.** It confirms
   masking, the body limit, the Lab boundary, `startServer`, gitlinks, i18n keys, and the
   bridge opt-in. It does not independently re-answer the inbound `developer` remap, the
   90-second WS prelude, or `freeOnlyInForce`; those rest on the lane read plus CI.
3. **Treating an unresolved `RUNTIME-CHECK` as a `BLOCK` creates pressure to under-report
   it.** Exactly one finding carried that label and it was resolved by tracing consumers.
   A lane that quietly downgrades rather than raising the label would not be visible here.
