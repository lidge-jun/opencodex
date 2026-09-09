# Post-release repairs — the automation that never ran

Two follow-ups from `070_outcome.md`, both landed on `dev`.

## 1. The dev-version bump never fired (#3129)

`070` recorded that the v2.39.0 bump was opened by hand. The reason turned out to be
worse than a missed run: `.github/workflows/dev-version-bump.yml` had **never executed**.
`gh api repos/lidge-jun/opencodex/actions/workflows/346296606/runs` returned
`total_count: 0` — zero runs across v2.37.0, v2.38.0 and v2.39.0, while #3045, #3076 and
#3127 were all opened by hand.

### Cause

`release.yml` creates the GitHub release with `GH_TOKEN: ${{ github.token }}`
(`release.yml:350`), and GitHub does not start workflow runs from events raised by the
default `GITHUB_TOKEN`. A `release: published` listener therefore cannot observe a
release this repository publishes itself, on any branch.

The workflow's own header blamed something else — the default-branch resolution trap for
`release` events. That trap is real, and #3013 correctly moved the file to `main` to
satisfy it, but satisfying it armed nothing. Two plausible explanations for the same
silence, and the repository acted on the wrong one for three releases.

The tag push is not an escape hatch either: `release.yml` pushes `refs/tags/vX.Y.Z` with
the same token, and no run exists for those pushes. Confirmed by querying push-event runs
with a `v2.*` head branch — empty.

### Fix

`release.yml` now **calls** the bump workflow after a successful publish, so the run is a
child of the release run instead of a reaction to an undelivered event. The bump workflow
becomes `on: workflow_call` with a `released-version` input.

No new credential: no PAT, no app token, no `contents: write` added to the release job.
The called workflow keeps its write scopes on its own job, and `Protect dev` still means
a human merges the PR. Only the ignition changed.

### One thing the tests taught

`bump-dev-version` is declared **first** in `release.yml`, ahead of the jobs it depends
on. `tests/ci-workflows.test.ts:735` splits the workflow on `- name:` and reads each
`run:` block to the start of the next one, checking that dispatch inputs never
interpolate into shell source. A job declared after the last step falls inside that
window and reads as shell — the test failed on two placements before this one, correctly
both times. Job order carries no execution meaning (`needs` does), so the placement is
free and the injection check stays strict rather than being relaxed to accommodate us.

A comment written during this work claimed a preview publish would move `dev` to the
preview's stable core. Checking it against the script instead of trusting it showed
`changed=false` — `dev` is normally already at that core when the preview publishes. The
comment was corrected before commit.

### Activation delay, stated rather than discovered later

A `workflow_call` body resolves from the **caller's** ref, and `release.yml` only runs on
`main` or `preview`. This takes effect after an ordinary `dev` → `main` promotion carries
it there; the next release is the first real exercise. Same shape of delay #3013 had, for
a different reason.

## 2. The server-auth websocket flake (#3128)

`926a8d8c4` cherry-picked out of #3109 onto its own branch, authorship preserved. The
commit is a two-line test change — pin `codexAccountNamespaces` and route both turns
through `ws-refresh/gpt-test` — and had no relationship to that PR's combo-compact-failover
subject. Analysis of the race is in `070`.

## Result

`dev` at `6f415baef`, carrying 2.40.0:

```
6f415baef fix(release): call the dev version bump instead of listening for an event that never fires (#3129)
33d32b6a3 test(auth): pin the websocket refresh account to stop a cross-platform flake (#3128)
9c8bbbf66 docs(devlog): record the v2.39.0 release train (#3126)
3e0f99a19 chore(release): move dev to 2.40.0 after the v2.39.0 release (#3127)
```

`#3127` should be the last hand-opened bump. Whether it is gets settled by the next
release, not by this note.
