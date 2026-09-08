# wp4 — publication

Both channels are published and verified.

| Channel | Version | Source SHA | npm gitHead |
|---|---|---|---|
| `preview` | 2.48.0-preview.20260908 | `c71474e83c92be1f39e9d8c1fe0743307ce93387` | matches |
| `latest` | 2.48.0 | `9a27e86992d7a014e0aa92c046199b9fac148201` | matches |

`npm view @bitkyc08/opencodex dist-tags` reports `{"latest":"2.48.0","preview":"2.48.0-preview.20260908"}`. GitHub releases `v2.48.0` and `v2.48.0-preview.20260908` exist at exactly those commits. Both publishes carry a signed provenance statement from GitHub Actions.

Tarball integrity was checked independently: downloading `bitkyc08-opencodex-2.48.0.tgz` from the registry and hashing it locally yields `sha512-f2GmrBpUJYZ+bOT62VL1MWhNwIBkFz5JUVGrNPG+SAaWJheshmMsnHDoMyRIpyd5v50sK9uI0Ll4XZwI4PVjhA==`, identical to the `dist.integrity` npm reports and to the `integrity:` line in the publish log. The unpacked package declares version 2.48.0 and its `bin/ocx.mjs` launcher runs and correctly reports the Bun runtime requirement in an isolated `OPENCODEX_HOME`.

## The dev-version gate

The first stable dispatch failed at "Require dev to be ready for this release": `origin/dev` still carried 2.48.0, which does not outrank the version being released. That gate exists so `tests/ci-workflows/release-version-line.test.ts` does not go red on `dev` and on every pull request against it the moment a release ships.

The repair was [#4019](https://github.com/lidge-jun/opencodex/pull/4019), a one-line `package.json` change moving `dev` to 2.49.0, with the version decided by `scripts/bump-dev-version.ts` rather than chosen by hand. It merged as `0372c43e663b25387a0a00b03b6a9ca9d4bf9048` with full CI green, after which the stable dispatch succeeded on the unchanged `main` SHA.

## Registry propagation

Both publishes reported "Your package is being processed" and the workflow's bounded six-attempt registry smoke ended `verification=pending` in each case. Neither was republished. Preview appeared in the registry roughly twelve minutes after acceptance, stable roughly seven; both were then verified by direct registry reads and by the independent tarball hash above.

## Final branch state

`dev` 2.49.0, `main` 2.48.0, `preview` 2.48.0-preview.20260908. `dev` remains ahead of both release channels.


## Verification commands

```
npm view @bitkyc08/opencodex dist-tags --json
npm view @bitkyc08/opencodex@2.48.0 dist.integrity dist.tarball --json
gh release view v2.48.0 --json tagName,targetCommitish
```
