# wp4 — Main release (`latest` dist-tag) and ancestry proof

## Sequence

0. Run the same four blocking checks as wp3 step 0 against `2.41.0`, re-run
   from scratch because the preview publish happened in between: the exact
   version unpublished on npm, no `v2.41.0` tag, no GitHub release, and the
   version moving the `latest` dist-tag FORWARD under semver. Each must fail
   the step, not merely print. The channel-forward check matters as much here
   as on preview: `release.yml` compares only for exact-version duplication,
   so nothing in CI would stop `latest` being moved backwards.
1. Open a promotion PR from a branch **pinned to the reviewed SHA** into
   `main`; `main` is protected the same way `preview` is. Merge with admin,
   recording the `enforce-target` bypass.
2. **No bump is needed.** `dev` already carries `2.41.0` (`package.json:3`), so
   the promotion brings the stable version with it. The original draft of this
   doc prescribed a bump PR; audit round 1 established it would be a no-op that
   `npm version` rejects as "Version not changed".
3. Wait for exact-SHA `ci.yml` and `service-lifecycle.yml` success on the
   `main` head, as **push-event** runs (`release.yml:222`), then re-read
   `git ls-remote origin main` immediately before dispatch.
4. `gh workflow run release.yml --ref main -f version=2.41.0 -f tag=latest
   -f expected-sha=<full-40-char-sha> -f dry-run=false`.

## Proof required before claiming DONE

- `npm view @bitkyc08/opencodex dist-tags --json` shows `latest` at the
  published stable version.
- The published version carries npm provenance and a `gitHead` matching the
  release SHA. Publication is tokenless OIDC Trusted Publishing
  (`release.yml:119`, `:153`, `:285`); provenance is the artifact-side proof
  that the tarball came from this workflow on this repository.
- `gh release view v2.41.0` exists and its tag resolves to the release SHA.
- `git fetch origin main` FIRST, then
  `git merge-base --is-ancestor <reviewed-dev-sha> FETCH_HEAD` exits 0, with
  `FETCH_HEAD` confirmed equal to the `expected-sha` that was dispatched.
  This is the check that distinguishes "main moved" from "main carries the work
  that was reviewed" — a green release run proves neither by itself. The fetch
  is not optional: `git ls-remote` reads the remote without updating
  `origin/main`, so an ancestry test against the un-refreshed remote-tracking
  ref can pass or fail on history that is minutes stale.
- The Meta work is actually in the published artifact, not merely in the tag.
  Download the tarball and confirm all three: the `meta-model` provider entry,
  the `meta-muse` provider entry, and `meta.svg` in the packaged GUI assets.
  Checking only one of them lets a release pass with a missing alias or a
  missing asset. A tag pointing at the right SHA and a tarball built from it
  are separate facts.

## After publish

`dev-version-bump.yml` (called by `release.yml`'s `bump-dev-version` job)
opens a PR moving `dev` to `2.42.0`. Merge it so `dev` does not sit on an
already-published version — that stale state is what #3265 had to repair after
v2.40.0.
