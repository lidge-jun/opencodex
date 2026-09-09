# 260901 — v2.39.0 release train: audit, promote, publish

Snapshot taken 2026-09-01T01:35Z. This unit carries `dev` to `preview` and `main` and
publishes 2.39.0 to npm. It is a delivery unit, not a bug-fix unit: no product code is
written here unless the regression audit produces a blocker.

## Measured state

| Ref | SHA | `package.json` |
|-----|-----|-----------------|
| `origin/dev` | `9af3a7bebb5eb6e9bb9aab51274586897eaaba03` | `2.39.0` |
| `origin/main` | `ebb4d552e` | `2.38.0` |
| `origin/preview` | `93704b4f8` | `2.38.0-preview.20260831` |

Promotion delta `origin/main...origin/dev`: 43 commits, 252 files, +18668/-513.
Neither `main` nor `preview` is an ancestor of `dev` — both carry their own release
commits, which is the normal shape here. Every promotion in this repository is a merge
of `dev` into a promotion branch, then a PR into the target.

### Gate evidence at the `dev` head

Cross-platform CI run `33457563882` on `9af3a7beb`: **success**. Every job passed —
four test shards, `macos`, `gates`, `storage policy`, `api usage`, keyring on all three
OSes, `npm-global` on all three OSes. The Windows shard matrix is `skipped`, which is its
normal push-event state; `platform-windows` is `workflow_dispatch`-only.

No Service lifecycle run exists for `9af3a7beb` — that workflow's push trigger is
path-filtered and the head commit touched none of its paths.

## The preview channel is two cycles stale, and that is not an accident

npm currently advertises `latest=2.38.0` and `preview=2.36.0-preview.20260830`.

The cause is recorded in CI, not in npm. `origin/preview` tip `93704b4f8` carries
`2.38.0-preview.20260831`, but its push-event Cross-platform CI run `33386559501`
**failed**: jobs `macos` and `test 1/4` failed while every other job passed.
`release.yml` requires a *successful* `push`-event `ci.yml` run for the exact SHA on
the release branch, and deliberately refuses a green pull-request run for the same SHA.
So the v2.38.0 preview publish was never dispatchable. The stable publish was unaffected
because `main`'s own promotion run `33385192526` passed.

PR #3073's description already documents an intermittent macOS failure in
`tests/shutdown-launcher.test.ts` that does not reproduce on Linux. Lane E confirms
whether run `33386559501` is that same flake or a real defect before we treat the
preview promotion as routine.

## What the release workflow actually demands

From `.github/workflows/release.yml`, a dispatch must satisfy all of:

1. `expected-sha` — required, full 40 characters, and it must still be the branch tip.
   The guard checks out `.github/scripts/release-dispatch-guard.cjs` from the default
   branch, so the validation code is `main`'s, not the dispatched ref's.
2. Branch/version/dist-tag coupling. From `main`: stable semver only, dist-tag `latest`.
   From `preview`: the version must contain `-preview.`, dist-tag `preview`. Any other
   ref is refused outright.
3. A successful `ci.yml` run for the exact SHA, on that branch, from a `push` event.
4. The service gate, when armed. It diffs the previous *merged* release tag against
   `HEAD` and, if any of `src/service.ts`, `src/cli.ts`, `src/cli/index.ts`,
   `src/lib/bun-runtime.ts`, `package.json`, `bun.lock`,
   `.github/workflows/service-lifecycle.yml` changed, demands a successful
   Service lifecycle run for the same SHA.

**The service gate will be armed for this release.** Measured against the delta:
`package.json`, `src/cli/index.ts` and `src/service.ts` are all present. Both promotion
commits therefore need a green Service lifecycle run of their own, and the push trigger
will supply it because those same paths are in the merge.

Publication is tokenless via Trusted Publishing (OIDC); there is no `NPM_TOKEN` to check.

## Work phases

One phase, one full PABCD cycle.

- **wp0** — this roadmap. Docs only.
- **wp1** — regression audit of the promotion delta, five parallel `gpt-5.6-sol`/high
  lanes, plus a gate determination. → `010`
- **wp2** — promote `dev` onto `preview`, publish nothing yet. → `020`
- **wp3** — promote `dev` onto `main`. → `030`
- **wp4** — dispatch `release.yml` twice and prove the publish. → `040`

## Success criteria

- c-1 — every audit lane returns a verdict with file/line citations, and no blocker survives.
- c-2 — the gates `release.yml` requires are green on each promotion SHA.
- c-3 — `origin/preview` tip is the preview promotion SHA and its push CI is green.
- c-4 — `origin/main` tip is the stable promotion SHA and its push CI is green.
- c-5 — npm shows `latest=2.39.0` and `preview=2.39.0-preview.20260901`, each
  `gitHead` matching its promotion SHA.

## Out of scope

Merging any of the 20 open feature/fix PRs. Rewriting `dev` history. Touching product
code absent a confirmed blocker. Running the full local suite — hosted exact-SHA CI is
the primary evidence surface for this unit.
