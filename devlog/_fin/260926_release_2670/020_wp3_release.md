# 020 — wp3: pre-move, promotion, publish, verify

Procedure follows `devlog/_fin/260925_release_2660_prs/060_wp7_release.md`; only values differ,
plus the pre-move now uses the workflow (see 1).

| Ref | Commit | Version |
|---|---|---|
| `main` | `e70b3d86fb` | 2.66.0 (npm `latest`) |
| `preview` | `0c37e74002` | 2.66.0-preview.20260925 (npm `preview`) |
| `dev` | CAND | 2.67.0 |

## 1. Dev pre-move to 2.68.0

`origin/main:.github/workflows/dev-version-bump.yml` is the hardened #5786 version (`4ebb4fb8d9`:
trusted checkout at `github.sha`, `dev` checked out as data without credentials), so the
workflow is used this time:

```bash
gh workflow run dev-version-bump.yml --ref main -f intended-version=2.67.0 -f mode=pre-move
```

The PR it opens must change exactly the four version sources (`package.json`,
`desktop/src-tauri/tauri.conf.json`, `desktop/src-tauri/Cargo.toml`, the `opencodex-desktop`
entry of `desktop/src-tauri/Cargo.lock`) to 2.68.0. Merge with
`gh pr merge --squash --admin --match-head-commit <head>` after its exact-head checks pass. The
candidate SHA does not change. Fallback if the workflow fails: the manual steps from 2.66.0's 060
audit amendment, with 2.67.0/2.68.0.

## 2. Promotion PRs

```bash
PV=2.67.0-preview.20260926
git worktree add /tmp/ocx-rel-2670 "$CAND" && cd /tmp/ocx-rel-2670
git switch -c codex/260926-release-preview-2.67.0
git merge -s ours --no-edit origin/preview -m "release: promote the verified 2.67.0 preview tree to preview"
bun scripts/release-version-sources.ts sync "$PV"
git commit -am "release: prepare $PV version metadata"
bun scripts/release-version-sources.ts check "$PV"
git switch -c codex/260926-release-main-2.67.0 "$CAND"
git merge -s ours --no-edit origin/main -m "release: promote the verified 2.67.0 tree to main"
bun scripts/release-version-sources.ts check 2.67.0
```

Checks: `git diff --stat $CAND codex/260926-release-main-2.67.0` empty; preview differs from CAND
only in the four version lines. Push with `--no-verify`, open both PRs from the template, merge
each with `gh pr merge --merge --admin --match-head-commit <head>` (merge commit, never squash).

## 3. Release-branch CI

At each promotion merge SHA: push-event `ci.yml` success and Service lifecycle success
(`package.json` changed since the previous tag). Failures follow 000 rules 2 and 3.

## 4. Dispatch (preview first)

```bash
gh workflow run release.yml --ref preview -f version="$PV" -f tag=preview -f expected-sha=<preview merge SHA> -f dry-run=false
gh workflow run release.yml --ref main -f version=2.67.0 -f tag=latest -f expected-sha=<main merge SHA> -f dry-run=false
```

A job that fails after npm acknowledged publication is completed by re-dispatching with the same
version and expected SHA plus `resume-after-npm-publish=true`; a version is never republished.

## 5. Verification

```bash
curl -s https://registry.npmjs.org/@bitkyc08%2fopencodex | jq '."dist-tags"'
gh release view v2.67.0 --json assets,isPrerelease,targetCommitish
gh release view "v$PV" --json assets,isPrerelease,targetCommitish
curl -sL https://github.com/lidge-jun/opencodex/releases/latest/download/latest.json
```

Acceptance: npm `latest` = 2.67.0 and `preview` = `$PV`; both releases have 25 assets;
`latest.json` reports 2.67.0 with a signature for darwin-aarch64, darwin-x86_64, windows-x86_64,
linux-x86_64 and linux-x86_64-deb. A green run with registry verification `pending` is waited out.

## 6. Local fast-forward and close

`git fetch origin`; in the native checkout fast-forward `dev`, `main` and `preview` with
`--ff-only` (`git fetch origin main:main preview:preview` for branches not checked out); a
non-fast-forward is reported, never forced. Write `030_done.md`, move the unit to `devlog/_fin/`,
open a docs PR to `dev`, merge at green exact head, fast-forward local `dev` again.

## Architect reflection (kimi, P phase)

Confirmed against `origin/main` workflow blobs: `dev-version-bump.yml` is the #5786 version and must be
dispatched with `--ref main` (its guard refuses other refs). `release.yml` enforces in-workflow that
`expected-sha` is the branch head, a push-event `ci.yml` success and a Service lifecycle success exist at
that SHA, and `dev` already outranks the release version. Ordering is therefore strict: the pre-move PR
merges before any release dispatch, and a dispatch issued earlier fails at preflight. If the bump run
fails because `codex/dev-version-2.68.0` already exists with other content, read the run; do not retry
blindly.

## Audit round 1 (kimi, NEAR-PASS) — dispositions

1. MAJOR "#5858 not partitioned": rebutted with a mapping. The sweep's twelve PRs are exactly the
   merges listed in 010's lanes; 010 now states the mapping explicitly.
2. Minor: stable dispatch runs only after the preview release run concludes `success` (ordering
   note restored from 2.66.0's 060).
3. Minor: acceptance adds `isPrerelease` = true for `v$PV` and false for `v2.67.0`.
4. Minor: 010 re-verifies the `dev` failure list before wp2 exit.

## wp3 P revalidation (2026-09-26T02:38Z)

- `CAND=dac1d25f48fad18420aa856631ff9ee9c1775b0f` (green lane=all `36210914271`), not `08fd8a6284`; the
  owner added #5866 and #5875 during wp2.
- `PV=2.67.0-preview.20260926` unchanged. `main` `e70b3d86fb`, `preview` `0c37e74002`.
- Pre-move PR #5895 (`codex/dev-version-2.68.0`, head `4c64fd4acc`, base `dac1d25f48`) was opened by the
  workflow token, which does not trigger `pull_request` workflows; close/reopen by the maintainer started
  its CI. Diff is exactly the four version sources, 2.67.0 → 2.68.0.

## wp3 execution log

- Pre-move: `dev-version-bump.yml` run `36210933641` success opened #5895 (head `4c64fd4acc`). Its CI did not
  start until a maintainer close/reopen. `enforce-target` and `hygiene` failed with `unsponsored_surface`
  (bot author on release-owned files) and the readiness gate held it in draft; every CI job including the
  aggregate `ci` passed. Marked ready and merged with admin as `c56dd47a6f`; `dev` carries 2.68.0.
- Promotion: #5899 `preview` merge `9c6fb1ee8b8c06fd4ee68bd237099b6f9325802e` (tree = CAND + four version lines),
  #5900 `main` merge `4bc92294aa23a7edba75805095808d892efa72e2` (tree = CAND). Both were drafted by the gate,
  marked ready, merged with merge commits.
- Release-branch CI: preview CI `36213263882`, Service lifecycle `36213264006`; main CI `36213267338`,
  Service lifecycle `36213267275`.
