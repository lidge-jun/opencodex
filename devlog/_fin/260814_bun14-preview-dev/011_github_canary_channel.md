# 011 — GitHub canary channel (supersedes the npm-only assumption in 020)

## Why this doc exists

`020_bundle_canary.md` assumed the canary arrives as an npm dependency
(`"bun": "1.4.0-canary.1"`). That assumption is wrong and it stalled the whole
train: npm has no 1.4 line at all.

```console
$ npm view bun dist-tags --json
{ "latest": "1.3.14", "canary": "1.3.13-canary.20260425.1" }
```

GitHub does have it. `oven-sh/bun` publishes a rolling `canary` release tag
carrying 34 platform assets, and it is already 1.4:

```console
$ gh release download canary --repo oven-sh/bun --pattern 'bun-darwin-aarch64.zip'
$ ./bun-darwin-aarch64/bun --version
1.4.0
$ ./bun-darwin-aarch64/bun --revision
1.4.0-canary.1+032b8dbf1
```

So the correct sequencing is: **qualify against the GitHub canary now, switch to
the npm dependency at stable release.** The npm path is the destination, not the
prerequisite.

## What does NOT change

`package.json` stays `"bun": "1.3.14"`. The npm dependency is the *shipped*
runtime for users; it moves once on stable day (`020`). Pointing it at a
nonexistent npm version would break every install.

## Runtime selection — already built

No new mechanism is needed. `bin/ocx.mjs:374` and `src/lib/bun-runtime.ts:22`
already implement `OPENCODEX_BUN_PATH`, and `resolveBun()` gives a valid
override precedence over the bundled dependency, reporting `source: "override"`.

```text
OPENCODEX_BUN_PATH=<canary binary>  →  source=override   (qualification runs)
unset                               →  source=bundled    (npm 1.3.14, users)
```

That is exactly the A/B shape §4 of the task spec asks for: same checkout, same
`node_modules`, two binaries.

## NEW: scripts/runtime/fetch-canary-bun.ts

Downloads the GitHub canary for the host platform into a gitignored cache and
prints the resolved binary path, version, and revision as JSON.

- Resolve asset name from `process.platform` + `process.arch`
  (`bun-darwin-aarch64`, `bun-linux-x64`, `bun-windows-x64`, musl/baseline variants).
- Download via the GitHub releases API.
- Compute the SHA-256 of what we actually received and RECORD it.
- Cache under `.tmp/bun-canary/<revision>/` and reuse when present.
- Emit `{ path, version, revision, assetName, sha256, shasumsMatch }`.

### Do NOT gate on SHASUMS256.txt (audit finding)

The first draft of this doc said "verify against `SHASUMS256.txt`". Measured on
2026-08-14, that check FAILS on a correct download:

```console
$ shasum -a 256 bun-darwin-aarch64.zip
f153e5eca706db593416cce00e9d02858d76da57794cf30bb7411290b8c8130f
$ grep bun-darwin-aarch64.zip SHASUMS256.txt
e5fab4d53d070cdb4f3c19ba795e23aa95d5288ba595c6d3517d55138990ec36
```

The asset was re-uploaded at `2026-08-14T11:52:50Z` while `SHASUMS256.txt` still
dates from `2026-08-13T14:30:31Z`. On a rolling tag the checksum manifest lags
the binaries it describes, so a hard SHA gate would have failed every run — the
script would have been dead on arrival.

Two independent downloads minutes apart returned the identical SHA
(`f153e5e…`) and the identical revision, so the asset itself is stable at any
given moment; the stale artifact is the manifest.

Therefore: **`Bun.revision` is the pin, not the SHA.** Record `shasumsMatch`
as an advisory boolean and warn on mismatch, but never fail the run on it. What
makes a build trustworthy here is that CI executed the suite against that exact
revision — the qualification, not a manifest line.

## NEW: scripts/runtime/qualified-bun.json

Supersedes the shape drafted in `030`, now with a real revision:

```json
{
  "candidate": {
    "channel": "github-canary",
    "version": "1.4.0",
    "revision": "1.4.0-canary.1+032b8dbf1",
    "sourceCommit": "032b8dbf137807a7c340f9a5d1894ab6ccd2663d"
  },
  "control": { "version": "1.3.14", "channel": "npm-bundled" },
  "qualifiedRevisions": []
}
```

`qualifiedRevisions` stays EMPTY until CI proves a revision. Downloading a
binary is not qualification; `050` and `080` read this list, so writing a
revision in here on faith is the exact failure the revision gate exists to stop.

## MODIFY: .github/actions/setup-project-bun/action.yml

Add an optional `channel` input, defaulting to `package`:

```yaml
inputs:
  channel:
    description: package | github-canary
    default: package
```

With `github-canary`, the action downloads the canary asset and exports
`OPENCODEX_BUN_PATH` plus `OCX_QUALIFIED_BUN_REVISION` instead of calling
`oven-sh/setup-bun`. The `package` path is untouched, so every existing job
keeps its current behavior.

## MODIFY: .github/workflows/ci.yml

Add a `bun-canary-qualify` job, `preview-dev` push only, `continue-on-error: true`.
It runs typecheck + the full suite under the canary and uploads the revision as an
artifact. Non-blocking on purpose: a rolling upstream tag must not be able to
red the branch's own CI.

## Verification

```bash
bun scripts/runtime/fetch-canary-bun.ts --json     # exit 0, prints revision
OPENCODEX_BUN_PATH=<path> bun run typecheck        # exit 0
OPENCODEX_BUN_PATH=<path> bun test                 # record pass/fail per file
```

## Exit condition

This doc is done when CI can run the suite under the GitHub canary and report a
revision. Promoting that revision into `qualifiedRevisions` is `030`'s job, and
only after the run is green.
