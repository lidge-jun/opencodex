# A-gate audit round 2 — full reviewer verdict

The independent explorer auditor returned VERDICT: FAIL with eleven numbered findings.
Findings 1-4 reproduce the plan's headline claims exactly and confirm four lane
assignments. Findings 5-11 are corrections. All are accepted; 5, 6, 7 and 8 were
already folded into 005 before the verdict arrived. The remaining four are here.

## Finding 6 — the CI mechanism in 001 was wrong

001 said the full matrix "only appears on maintainer-authored PRs in this round
(#2672, #2674)." False:

```
$ gh pr view 2639 --json author,statusCheckRollup
bet4it checks=27
```

#2639 carries all 27 checks and `bet4it` is not in `MAINTAINERS.md`.
`.github/workflows/ci.yml` is `pull_request: {}` with no draft gating, so authorship
is NOT the discriminator. The conclusion stands — #2694's five checks never compile
anything — but the stated mechanism was invented. What actually distinguishes the
two sets is not established here, and should not be guessed at again.

## Finding 9 — #2690's fix is NOT separable from its refactor

020 planned to "take the xAI root-schema normalization and leave the
`openai-chat.ts` extraction." The auditor showed that is incoherent: the fix lives in
`src/adapters/openai-responses.ts`, which imports `isXaiSchemaTarget`,
`normalizeXaiToolParameters` and `XaiToolSchemaCompatibilityError` from the new
`./xai-tool-schema` module — the extraction IS the module the fix depends on.

Confirmed on dev: `src/adapters/openai-chat.ts:956` still defines its own
`isXaiSchemaTarget`, used at line 1509. Taking the fix without the extraction leaves
two divergent copies of the xAI schema logic.

So #2690 is not an L3 cherry-pick of "fix minus refactor". Either it lands whole
(now conflicting with the already-merged #2684 and needing a rebase), or the fix is
reimplemented against the existing `openai-chat.ts` helper. That is an L4 decision,
not an L3 one.

## Finding 10 — #2671's blocker was understated

010 said the review wants one added test. Two reviewers raise a second issue: the
added comment claims the capability was "probed 2026-08-26" while the PR carries no
probe evidence, and `registry.ts` already documents a convention against adding ids
on family resemblance — because a route that silently strips an image returns 200 and
answers about an image it never saw.

Status: #2671 was merged in wp2 with the requested regression test added
(commit 4a4df12f2, proven load-bearing: 6 fail without the registry line, 6 pass with
it). The probe-evidence question is NOT resolved by that test. It is recorded here as
an open provenance question on a merged change, to be answered by a live probe against
Zen Go rather than by another code reading.

## Finding 11 — core.ts is a five-way serialization constraint

`src/server/responses/core.ts` is touched by #2694, #2690, #2663, #2638 and #2497.
Every merge into it invalidates the compile and test evidence gathered for the other
four. 006 listed the contention; this makes the consequence explicit: after ANY of
those five lands, the merged-tree gate must be re-run for each remaining one before it
is treated as clear. Evidence for these five expires on every merge.
