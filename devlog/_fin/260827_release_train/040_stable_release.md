# 040 — publish the stable release

## Target

`2.34.0`, dist-tag `latest`.

## How — revised after the promotion

There is no release commit to make. `main` is `80fff9a7f` and already carries `2.34.0`,
because `030` had to resolve the promotion conflict to dev's side to satisfy
`tests/release-version-line.test.ts`. `release.ts:568` would skip the bump for exactly this
reason, so `80fff9a7f` **is** the release commit and the workflow tags it directly.

That removes the only step the hand route existed to perform, so `040` is a pure dispatch:

```
# wait for the push-event ci.yml AND service-lifecycle runs at 80fff9a7f
gh workflow run release.yml --ref main \
  -f version=2.34.0 -f tag=latest \
  -f expected-sha=80fff9a7f47332a4445df2b26ea175053fa55b0b -f dry-run=true
# inspect the packed file list, then re-dispatch with dry-run=false
```

The promotion push started both required runs on `main` on its own, plus
`deploy-docs.yml`, which is what `050` needs.

`release.ts` refuses a prerelease version on `main`, so the plain `2.34.0` is required
here rather than a matter of taste. The workflow enforces the same mapping server-side:
`main` must publish a non-prerelease version with dist-tag `latest`.

## Acceptance

- `npm view @bitkyc08/opencodex dist-tags` shows `latest = 2.34.0`
- `npm view @bitkyc08/opencodex@2.34.0 gitHead` equals the `main` release commit
- the `v2.34.0` git tag exists and points at that commit
- the published tarball's `package.json` version reads `2.34.0` — checked by unpacking,
  not by trusting registry metadata

## Risk

npm publish is irreversible. The dry run is not optional ceremony: it is the only
rehearsal available. Read the dry-run job log for the packed file list before publishing —
a release that ships the wrong files cannot be unshipped, only superseded.

## Outcome — shipped

`2.34.0` published from `main` at `80fff9a7f47332a4445df2b26ea175053fa55b0b`, which is the
promotion merge itself: no separate `release: v2.34.0` commit exists, and none was
possible, for the reason recorded in `030`.

| Gate | Evidence |
| --- | --- |
| push-event Cross-platform CI | run `33075147758`, success at `80fff9a7f` |
| Service lifecycle | run `33075147219`, success |
| Release dry run | run `33076185925`, success; packed `@bitkyc08/opencodex@2.34.0`, 838 files, 9.3 MB, `gui/dist/index.html` present |
| Release publish | run `33076348477`, success |

Both channels now current, and neither disturbed the other:

- `dist-tags` = `{ latest: 2.34.0, preview: 2.34.0-preview.20260827 }`
- `gitHead` of `2.34.0` = `80fff9a7f47332a4445df2b26ea175053fa55b0b`
- tag `v2.34.0` resolves to the same commit; GitHub Release exists with `prerelease=false`

Artifact proof, by unpacking rather than by registry metadata: `npm pack`ed the published
version into a `mktemp -d`, and `package/package.json` reads `2.34.0` with
`package/gui/dist/index.html` present and both `bin` entries intact. Installing it into the
same scratch directory and running the installed binary prints `opencodex 2.34.0`.

The dry-run packed size matched the preview's exactly (838 files, 9.3 MB, 19.9 MB unpacked),
which is the expected result of publishing byte-identical trees to two channels.
