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
