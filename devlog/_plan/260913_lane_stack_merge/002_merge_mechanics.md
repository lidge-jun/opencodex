# Merge mechanics settled in flight

Two mechanics changed after the audio lane landed, and a third was clarified.
They apply to every remaining lane.

## Merge commit, not squash, for a lane tip

A squash merge collapses the branch into one new commit, so the ancestry of the
links beneath the tip is discarded. GitHub then has no way to see that #4346's
head is already in `dev`, and those pull requests stay open to be closed by
hand, reported as closed rather than merged.

A merge commit keeps the ancestry. Because each lane is cumulative — every link
merged its parent's commit — the tip's history contains every link's head. Once
that history reaches `dev`, GitHub marks each of those pull requests `MERGED`
on its own. One merge closes the whole lane with the correct status.

The repository already carries merge commits on `dev`, so this is not a new
shape in the history.

## The ancestry invariant

The auto-close only works while the tip is a descendant of every link's current
remote head. Re-merging a lower link after the chain was built breaks it: the
link gets a new head that the tip has never seen.

That is not hypothetical. A live check found the responses, singles and
providers lanes intact, while accounts and trio-remote had every link missing
because both lanes re-merged their lower branches to absorb the audio landing
and never propagated upward.

Verify per link before merging a tip:

```
git merge-base --is-ancestor origin/<link-branch> <tip-commit>
```

A non-zero exit means that link will not auto-close. The repair is to propagate
upward — merge the refreshed lower link into the one above it, and carry that
result up to the tip.

## Screenshot gate

`enforce-target` fails with `missing UI screenshot` when a pull request
mentions gui, which every cumulative tip carrying GUI work does. The owner's
decision is to satisfy it properly rather than bypass it: capture the UI change
and put the image in the tip's description.

A temporary Vite build is allowed for this — `bun run build:gui` or a build
inside `gui`, served locally for capture. Local full test suites remain
forbidden, so this permission is narrow: it covers building and viewing the
dashboard, not running `bun run test`.

Images need a hosted URL to render in a description, so the PNGs are committed
into the lane's devlog unit under `screenshots/` and referenced by raw link.
`devlog/_plan/260912_audio_apis_stack/screenshots/` is the existing precedent.
The screenshot commit rides along with the tip's final `origin/dev` re-merge so
the lane pays for one CI run rather than one per commit.

Where a lane's GUI diff has no visual delta — logic, types or hooks only — the
lane reports that instead, and the maintainer applies the repository's own
`gui-screenshot-waived` label with the reason recorded. That label is the
designed escape hatch and is applied by a maintainer, not by a lane.

## Consequence for the roadmap

`010_wave1.md` and `020_wave2.md` describe `--squash` for lane merges. Read
that as `--merge` for a lane tip whose ancestry invariant holds, and as
`--squash` only for a pull request being landed alone.

