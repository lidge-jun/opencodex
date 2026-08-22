# 040 — Release plan

## Baseline

- Published latest: `v2.14.2`, npm `@bitkyc08/opencodex@2.14.2`, dist-tags
  `latest=2.14.2`, `preview=2.14.0-preview.20260813`.
- `origin/main` at `02b861adf release: v2.14.2`; `origin/dev` at `040f6db5b`.
- `package.json` on `dev` still reads `2.13.0`; the version bump is performed by
  the release script on the release branch, not carried on `dev`.

## Release authority

`scripts/release.ts` is the only release path. Its contract, read from the script
rather than assumed:

- It refuses to run anywhere except `main` or `preview`. `main` releases must use
  dist-tag `latest` and a non-prerelease version; `preview` requires a
  `-preview.` version and the `preview` tag.
- Preflight is clean tree, dependency audit, typecheck, tests, privacy scan.
- It bumps `package.json`, commits, pushes the branch, waits for Cross-platform
  CI, then dispatches `release.yml` with an `expected-sha` gate.
- Publishing is **dry-run unless `--publish` is passed**. Publishing is tokenless
  via Trusted Publishing (OIDC).
- Before dispatch it re-resolves the live remote head and aborts if the branch
  moved. That is the anti-race gate and it must not be worked around.

Two operational details the audit caught, both load-bearing:

- It waits for **Service lifecycle CI** as well as Cross-platform CI
  (`scripts/release.ts:325-329`). Both must be green.
- **"Dry-run" means no npm publish, not no mutation.** A run without `--publish`
  still bumps `package.json`, commits, and pushes `main`
  (`scripts/release.ts:310-319`). There is no rehearsal mode that leaves the
  remote untouched, so the command is issued once, deliberately, with `--publish`.

## Sequence

1. Land the WP4 merges on `dev` and prove `dev` green locally
   (`bun run typecheck`, `bun run test`).
2. Land the Gemini 3.7 Flash support on `dev` (WP3), with its own tests.
3. Promote `dev` → `main` by merge commit, the same shape as the existing
   `Merge dev into main` commits.
4. Run `bun scripts/release.ts <version> --tag latest --publish` from `main`.
5. Verify: `gh release view v<version>`, `npm view @bitkyc08/opencodex version`,
   and confirm the release tag SHA equals the `main` head that CI passed on.

### Pre-promotion gates (added after audit)

Before `dev` → `main`, all of these must pass locally, because the release
workflow's package build protects the npm artifact but the docs deploy is a
separate post-`main` workflow that does not protect published documentation from
drift:

- `bun run typecheck` and `bun run test`
- `bun run privacy:scan`
- `bun run build:gui`
- model-metadata regeneration + byte-sync test, if the snapshot changed
- price-parity tests
- docs-site build and a locale-drift read of any changed page

## Version

`2.15.0`, conditional on the model surface actually being complete. A minor bump
is the honest signal for a new routed model; `2.14.3` would understate it. The
audit's caveat holds: if the Gemini work ships only as picker visibility without
context window, modalities, and pricing, then it is not a model surface and the
release is a patch, not a minor.

## Authorization boundary

The user authorized the release explicitly ("배포까지 완료해"). That covers the
push to `main`, the tag, and the npm publish for this release. It does not extend
to force-pushing any branch, rewriting `main` history, or publishing anything the
release script's own gates reject. If CI is red on `main`, the release stops and
is reported rather than forced through.

## Failure handling

- Preflight failure → fix on `dev`, re-promote; never bypass the preflight.
- CI red on `main` → stop, report, do not dispatch.
- `expected-sha` mismatch → the branch moved; re-verify rather than re-dispatch
  blindly.
- Publish failure after tag creation → the tag exists but npm does not; report
  the exact state instead of retrying into a partial release.
