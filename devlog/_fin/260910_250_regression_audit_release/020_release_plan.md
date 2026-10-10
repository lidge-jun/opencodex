# 2.50.0 release plan

Derived from `.github/workflows/release.yml` as it exists on `dev`, not from precedent.
The gates below are what the workflow actually enforces.

## What release.yml requires

| Gate | Line | Requirement |
| --- | --- | --- |
| Branch | `release.yml:153-170` | Must run from `refs/heads/main` or `refs/heads/preview`. `main` refuses any version containing `-`; `preview` refuses any version that is not `*-preview.*`. |
| dist-tag | `release.yml:174-177` | `main` -> `latest`, `preview` -> `preview`. |
| CI | `release.yml:179-197` | A **successful `ci.yml` run with `--event push` on the release branch for `$GITHUB_SHA`**. A pull-request run is explicitly rejected, and a `workflow_dispatch` run on `dev` does not qualify. |
| Service lifecycle | `release.yml:225-237` | If any of `src/service.ts`, `src/cli.ts`, `src/cli/index.ts`, `src/lib/bun-runtime.ts`, `package.json`, `bun.lock`, `service-lifecycle.yml`, `release.yml` changed since the previous tag, a successful `service-lifecycle.yml` run for `$GITHUB_SHA` is required. This delta changes `src/cli/index.ts` and `package.json`, so the gate is armed. |
| dev ahead | `release.yml:242-249` | `bun scripts/version-line.ts assert-ahead <dev version> <release version>`. `dev` is currently `2.50.0`, so publishing 2.50.0 fails until `dev` is pre-moved. |
| Publish | `release.yml:22-26` | `dry-run` defaults to **true**. A real publish needs `dry-run=false`. `expected-sha` is required and must equal the branch head at dispatch. |

`$GITHUB_SHA` on `main` is the **promotion merge commit**, not the frozen `dev` SHA.
2.49.0 published from merge `2f3f73629`, not from its promoted tree commit `62849dfa6`.
Both `ci.yml` (`push: branches: [main, preview, dev]`, `paths: src/**, gui/**, ...`) and
`service-lifecycle.yml` (`push`, paths including `package.json` and `src/cli/index.ts`)
fire automatically on that merge, so the required runs appear without a dispatch — but
they must be waited for on that exact SHA.

## Order

1. **Freeze the candidate.** Record the exact `dev` SHA. A `workflow_dispatch` `lane=all`
   run on `dev` is audit evidence for the tree, not the release gate; it tells us whether
   the tree is green before we spend a promotion on it.
2. **Land blockers first.** Any wp3 fix goes to `dev` through a pull request, which moves
   the candidate. Re-freeze and re-verify on the new SHA; old-head green is not evidence.
3. **Pre-move `dev`.** Dispatch `dev-version-bump.yml` with `intended-version=2.50.0`,
   `mode=pre-move`. It is `on: workflow_dispatch`, but `dev-version-bump.yml:79` refuses
   a non-default ref, so dispatch it with `--ref main`. It opens a pull request and does
   **not** push to `dev`, because the `Protect dev` ruleset requires review. Merge that PR
   so `dev` reads 2.51.0 before the publish reaches `assert-ahead`. Use the workflow rather
   than a hand-written one-file PR so its tag/npm/version-line proofs run.
4. **Promote the frozen SHA to `main`, not current `dev`.** After step 3, `origin/dev` is
   2.51.0 and is no longer the candidate. Promotion always names the recorded freeze SHA
   explicitly.

   The freeze SHA is **not** an ancestor of `main`, and `main` carries commits `dev` does
   not, so there is nothing to fast-forward. Replicate the 2.49.0 method: branch from
   `main`, merge the freeze SHA into that branch as a single
   `release: promote verified 2.50.0 product tree to main` commit, then open the PR into
   `main`. For 2.49.0 that was branch `codex/release-249-main-01a08498`, promote commit
   `62849dfa6` (parents `9a27e8699` = old `main`, `ad36c7be8` = the dev freeze), merged by
   PR #4117 as `2f3f73629`.

   The gate on this step is **tree equality**, not a green diff: after promotion,
   `git rev-parse <main merge>^{tree}` must equal `git rev-parse <freeze SHA>^{tree}`.
   For 2.49.0 all three of the promote commit, the dev freeze, and the merged `main` tip
   resolved to tree `66294fb3eb15592afd732f8b8e29d0bcc644fe9e`. Any conflict resolution
   that changes that tree means a different product shipped than the one audited.
   Record the merge SHA.
5. **Wait for the release-branch gates on the merge SHA.** Push-event `ci.yml` and
   `service-lifecycle.yml` on `main` for that exact SHA, both successful.
6. **Dry-run, then publish.** Dispatch `release.yml` with `--ref main`,
   `version=2.50.0`, `tag=latest`, `expected-sha=<merge SHA>`, first with
   `dry-run=true`, then with `dry-run=false` once the dry run is green.
7. **Verify artifacts.** `npm view @bitkyc08/opencodex dist-tags`, the `2.50.0`
   `gitHead` against the promoted `main` SHA, the git tag, the GitHub release, tarball
   integrity, and SLSA provenance. npm propagation lag returns 404 or a stale `latest`;
   poll, never republish.
8. **`preview` is a separate line and is not part of this stable train.**
   `origin/preview` is `2.49.0-preview.20260909`, and `release.yml:161-165` refuses a
   preview publish whose version is not `*-preview.*`. Promoting the plain `2.50.0` tree
   onto `preview` would break that branch's version line. If `preview` should carry this
   tree, it needs its own `2.50.0-preview.<date>` commit, decided after the stable
   release lands. A branch sync and a preview npm publication are distinct operations.

## Known failure modes to expect

- Branch-keyed CI concurrency cancels an older run when a newer commit lands. A cancelled
  aggregate is neither a product failure nor passing evidence.
- The registry-availability smoke can time out after npm already accepted the publish.
  Inspect metadata, provenance, and tarball before considering a retry.
- `dev-version-bump.yml` rejects a dispatch from a non-default ref as an early warning.
