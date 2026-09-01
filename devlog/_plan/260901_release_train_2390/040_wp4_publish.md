# wp4 — Dispatch `release.yml` and prove the publish

## Order

Preview first, then stable. `release.yml` declares `concurrency: group: release` with
`cancel-in-progress: false`, so a second dispatch queues behind the first rather than
cancelling it — but serializing them by hand keeps the evidence unambiguous about which
run published what.

## Dispatches

```sh
gh workflow run release.yml --ref preview \
  -f version=2.39.0-preview.20260901 \
  -f tag=preview \
  -f dry-run=false \
  -f expected-sha=<preview promotion SHA, full 40 chars>

gh workflow run release.yml --ref main \
  -f version=2.39.0 \
  -f tag=latest \
  -f dry-run=false \
  -f expected-sha=<main promotion SHA, full 40 chars>
```

`dry-run` defaults to `true`; it must be passed explicitly as `false` or the workflow
builds and packs without publishing. `expected-sha` is required and must be the current
branch tip — if anything lands on the branch between promotion and dispatch, the guard
fails the run rather than publishing a different tree than the one audited. That is the
intended behavior, not an obstacle to work around.

## Proof of publish

Merged source is not a deployed package. Required evidence:

```sh
npm view @bitkyc08/opencodex dist-tags --json          # latest=2.39.0, preview=2.39.0-preview.20260901
npm view @bitkyc08/opencodex@2.39.0 gitHead            # == main promotion SHA
npm view @bitkyc08/opencodex@2.39.0-preview.20260901 gitHead
gh release list --limit 5                              # v2.39.0 tagged
gh run view <release run id> --json conclusion
```

A `gitHead` that does not match the promotion SHA means something other than the audited
tree was published, and is a stop-everything condition.

## Known non-blocker

`preview=2.36.0-preview.20260830` on npm today is two cycles stale because v2.38.0's
preview CI failed (unit `000`). Publishing `2.39.0-preview.20260901` moves the tag
forward and closes that gap; 2.38.0-preview is skipped rather than backfilled, which
matches how the previous-tag baseline in `release.yml` already computes its range.

## Executed

Preview dispatch: run `33464064409`, success, `expected-sha=75f3895c1…`.
Stable dispatch: run `33464579658`, success, `expected-sha=af6113a03…`.

```
npm view @bitkyc08/opencodex dist-tags --json
{ "latest": "2.39.0", "preview": "2.39.0-preview.20260901" }
```

`gitHead` for `2.39.0` is `af6113a0381d6fff2e4dce587652825c7eeb6423`; for
`2.39.0-preview.20260901` it is `75f3895c14965205be694e8ebb8e93f472630539`. Both match
their promotion SHAs exactly, which is the check that distinguishes a published package
from a merged branch. GitHub releases `v2.39.0` and `v2.39.0-preview.20260901` exist.

The stale preview channel is closed: it moved from `2.36.0-preview.20260830` to
`2.39.0-preview.20260901` in one step.
