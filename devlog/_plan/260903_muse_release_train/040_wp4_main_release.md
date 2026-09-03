# wp4 — Main release (`latest` dist-tag) and ancestry proof

## Sequence

0. Prove `2.41.0` is still unused on npm and carries no tag or GitHub release
   (same check as wp3 step 0, re-run because the preview publish happened in
   between).
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
- `git merge-base --is-ancestor <reviewed-dev-sha> origin/main` exits 0. This
  is the check that distinguishes "main moved" from "main carries the work
  that was reviewed" — a green release run proves neither by itself.
- The Muse code is actually in the published artifact, not merely in the tag:
  the tarball must contain the `meta-muse` provider entry. A tag pointing at
  the right SHA and a tarball built from it are separate facts.

## After publish

`dev-version-bump.yml` (called by `release.yml`'s `bump-dev-version` job)
opens a PR moving `dev` to `2.42.0`. Merge it so `dev` does not sit on an
already-published version — that stale state is what #3265 had to repair after
v2.40.0.
