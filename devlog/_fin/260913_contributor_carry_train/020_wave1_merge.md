# wp3 — Wave 1 integration

The main session performs every merge. No lane thread merges anything.

## Order

Lanes merge one at a time, smallest blast radius first, so that each later lane
re-merges a dev that already contains the earlier ones:

X, I1, I2, L, B, C, R. Lane S does not merge here.

X is first because it is a single-file registry correction. R is last because its
four links all rewrite src/server/responses/core.ts, which is the file every other
lane is most likely to have touched indirectly through
structure/transports/responses.md.

## The wave-1 hold

Lane S (#4447) prepares in wave 1 and is deliberately excluded from this merge
order. It touches CORS and the management provider routes, which is inside the
MAINTAINERS.md security-review boundary, so it merges in wp5 after review or is
recorded as deferred. Lane B's tip is #4460; if a merge attempt on lane B would
carry #4447, the lane was assembled wrong and is fixed before merging rather than
merged and reverted.

## Per-lane merge procedure

1. git fetch origin dev and re-read the head. dev moves during this batch.
2. Read the lane tip current head SHA with gh pr view <tip> --json headRefOid.
3. Confirm the hosted run that concluded success ran on that exact SHA. A green
   run on an earlier head is not evidence for the head being merged.
4. If the tip re-merged origin/dev after its green run, verify the resolution by
   reading it and re-run bun run typecheck, bun run structure:check and
   bun run privacy:scan before merging. This happened twice in the previous batch
   and both times the re-merge was mechanical; that is a finding to reconfirm,
   not to assume.
5. Merge the tip. A cumulative lane merges as one merge commit on the tip, which
   lands every link beneath it. A lane whose links must appear separately in
   history squash-merges bottom-up instead.
6. Verify the landing rather than trusting the merge report:
   git merge-base --is-ancestor <merge-sha> origin/dev.
7. Verify attribution in the landed commit: git log -1 --format=%B <merge-sha>
   must show the Co-authored-by trailers for every carried author. A trailer that
   lived only in the pull request body is gone after a custom squash message, and
   that is exactly the failure CREDITS.md documents.

## Merge comment

Every merge comment names three things explicitly, so the deviation stays a
recorded owner decision rather than an inferred one:

- the owner authorization for tip-only CI in this batch,
- the tip pull request and run id that covers this branch,
- the fact that this branch own ci check never ran.

## The screenshot gate

enforce-target fails with missing UI screenshot on any pull request whose title or
description merely mentions gui. No wave-1 source pull request touches gui/, so
the gate is expected to be quiet here — but it reads the text, not the diff, so a
description that mentions the dashboard trips it anyway. Where a real rendered
state exists, capture it. A control that only renders against a real expired
credential is covered by its tests, and that limitation is stated in the
description rather than faked with a fixture.

## Exit criteria

Every wave-1 lane except S reports MERGED with its own merge commit, every merge
commit is a verified ancestor of origin/dev, and every carried author trailer is
present in the landed commit. Lane S exits wp3 prepared, green and unmerged; that
is its success state here, not a failure to land.
