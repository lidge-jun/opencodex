# wp4 — the release decision, and then the release

## Decision: GO, on the post-fix candidate

The audit did not clear 2702911708. It cleared the tree that carries the two fixes it produced, so
the release candidate moved: whatever commit lands #4690 on `dev` is what gets promoted, and
2702911708 is now only the commit the audit started from. The promotion opened earlier from
2702911708 (#4687) is stale for the same reason and has to be re-cut.

What the decision rests on, and what it does not:

- Twelve god-file decompositions audited and clean, each with a mechanical argument rather than an
  impression — declaration parity counts, single-owner state inventories, restore-completeness
  enumerations, and four traced end-to-end paths. Two independent models were run 1:1 on the
  highest-risk slices and agreed.
- Two real regressions found, fixed, guarded and reviewed. Both were in the #4546 work; neither was
  in a split.
- Six risks recorded and accepted in writing, none of them a regression in this range.
- The residual that no amount of source reading discharges: whether the candidate typechecks,
  builds, and behaves under real streaming, cancellation, replay and concurrency. That is carried
  by hosted CI at the exact release SHA, and it is the reason no step below accepts a green from a
  different commit.

## Sequence

1. Land #4690 on `dev` with Cross-platform CI green at its exact head. That merge commit is the
   release candidate.
2. Merge the `dev` version pre-move (#4686) so `dev` outranks 2.56.0 — `release.yml` refuses to
   publish otherwise, and doing this after publication is what left `dev` and every open pull
   request carrying a version-line failure ten times before.
3. Re-cut the promotion branch from the new candidate and open it against `main`. Its
   `enforce-target` check fails with "wrong base (main)"; every promotion carries that mark.
4. Require Cross-platform CI success for the `main` release commit, and Service lifecycle for it
   too — `package.json` always changes across a release, so that gate always applies here.
5. Dispatch `release.yml` with `version: 2.56.0`, `tag: latest`, `dry-run: false`, and
   `expected-sha` equal to the `main` release commit. The workflow refuses any dispatch whose
   `GITHUB_SHA` differs, so nothing may move between step 4 and here.
6. Promote the released tree to `preview`, which currently carries `2.55.0-preview.20260914`.
7. Verify the publish from the workflow's own conclusion. Registry metadata can lag a successful
   publish; a lagging read is not a reason to publish twice.

## Evidence

Recorded as each step completes.

- #4690 head `0026b14e83`, the post-fix candidate.

## What actually happened

- Candidate: `386303af1c` on `dev` — the squash of #4690, which carried the two regression fixes.
  Its pre-merge head `26b3ff244434846149b560e28f7441afae529564` passed Cross-platform CI as run
  `34945255301`.
- `dev` moved to 2.57.0 through #4686 before any promotion, so `assert-ahead` could pass.
- `main`: #4694 merged as `e4a8539b957b7ae7cd278666f0364eb0f82d4ac3`, carrying 2.56.0. Its push
  runs at that exact SHA: Cross-platform CI `34947608073` success, Service lifecycle `34947608122`
  success. #4687, cut from the pre-fix `2702911708`, was closed as superseded.
- `preview`: #4698 merged as `b552b1db59`. The head was an `ours`-strategy merge, so its tree is
  byte-identical to the candidate and to what `main` received; the merge exists to record the old
  preview tip as a parent, which is the shape every earlier promotion onto that branch used.
- Release: `release.yml` run `34951392978`, dispatched from `main` with
  `expected-sha=e4a8539b95…`, `version=2.56.0`, `tag=latest`, `dry-run=false`. Both jobs succeeded.
  The publish step reported `+ @bitkyc08/opencodex@2.56.0` with a provenance statement written to
  the sigstore transparency log, and tag `v2.56.0` plus the GitHub release exist.
- Registry metadata still read 2.55.0 immediately afterwards. The workflow says so itself and
  instructs against republishing; a lagging read is not a failed publish.

## What shipped that the audit did not clear

Nothing. The two regressions it found were fixed before promotion, and the fix itself went through
three review rounds: the first only released in the `catch`, the second confirmed before a rebuild
that can fail without sending, and only the third confirms at the two points that reach the wire.
The accepted risks are listed in `020_regression_audit.md` and are unchanged by this release.
