# 020 — Merge and closure policy for this unit

## Merge policy

Every merge in this unit is an admin squash into dev. The authority is the
single-maintainer dev integration clause in MAINTAINERS.md: a maintainer with
GitHub maintain or admin access may integrate through a pull request without a
second approval, including their own, provided the decision and the exact-head CI
evidence are recorded. That clause covers dev only. main and preview are
untouched here, and no direct push to a protected branch happens at any point —
the bypass is pull-request-only, which --no-verify does not change.

Squash is the merge method for the whole unit. What gets verified is the round's
final tip after the squash, not each intermediate branch state, because a squash
collapses the branch into one commit on dev and the only thing dev ever sees is
that commit.

Before any squash the lane's diff is re-read at the head about to be merged, and
the check rollup is read at that same SHA. A green run on an older head is
evidence about the older head.

## What a lane must deliver

1. One branch, one pull request against dev, filled to the repository pull
   request template (Summary, Verification, Checklist).
2. Closes #N lines for every issue the lane resolves. GitHub will not auto-close
   them because these target dev rather than main, so the sweep closes them by
   hand with the merge reference.
3. A Co-authored-by trailer in a branch commit for every carried contributor pull
   request, so it survives the squash and reaches the contributor graph. Prose
   naming the author is not equivalent; CREDITS.md exists because that mistake
   was made 27 times.
4. Verification stated honestly: hosted CI at the exact head. Local suite runs
   are labelled NOT RUN because they were not run.

## Closure policy

An issue closes when a merged commit on dev resolves it, and the closing comment
names that commit. An issue also closes when it is superseded, and then the
comment names what superseded it and why the original ask is satisfied.

A pull request closes one of three ways in this unit:

- **Merged.** The ordinary case for the contributor merge queue.
- **Superseded.** A lane landed the same behavior; the closing comment names the
  merge commit and the carried attribution, so the author can see where their
  work went.
- **Abandoned against current dev.** The branch conflicts, the approach no longer
  matches the subsystem it targets, and reviving it would cost more than
  reimplementing. The comment says that plainly and leaves the door open.

No pull request is closed merely for being old, and none is closed silently.
