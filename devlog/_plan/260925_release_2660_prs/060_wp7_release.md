# 060 — wp7: release 2.66.0

Procedure follows `devlog/_fin/260923_release_2_64/020_wp3_dev_candidate.md` and
`030_wp4_release.md`, which 2.65.0 also used (round `260925_release_2650_prs`). Only the
version values and SHAs differ. Starting state for this round:

| Ref | Commit | Version |
|---|---|---|
| `main` | `87a78e5f26` | 2.65.0 (npm `latest`, release v2.65.0, 25 assets) |
| `preview` | `d4c26e2b09` | 2.65.0-preview.20260925 (npm `preview`) |
| `dev` | moves during wp2-wp6 | 2.66.0 in all four version sources since #5785 |

## 1. Candidate

After wp6's last merge: `CAND=$(git rev-parse origin/dev)`, then
`gh workflow run ci.yml --ref dev -f lane=all` and bind the run whose `headSha == CAND`.
Acceptance: every job `success` at its latest attempt, `privacy gate` skipped by design on
`workflow_dispatch`, aggregate `ci` success. Known Windows runner-stall signatures
(`spawnSync ETIMEDOUT`, 480 s batch timeout with each file passing alone, `EPERM` on temp
cleanup) get one `gh run rerun --job`; a second identical failure, or any non-Windows
failure, is a defect: focused fix PR to `dev`, merged green, new candidate and new run.

Runners: while the candidate, promotion and release runs are active, competing queued or
in-progress runs are cancelled by hand one at a time after reading workflow, branch and event.
Never cancel runs on `main`, `preview`, the candidate run, this round's PR runs, or `Release`.

## 2. Dev pre-move to 2.67.0

```bash
gh workflow run dev-version-bump.yml --ref main -f intended-version=2.66.0 -f mode=pre-move
```

Dispatched once the candidate is bound. The PR it opens must change exactly the four version
sources (`package.json`, `desktop/src-tauri/tauri.conf.json`, `desktop/src-tauri/Cargo.toml`,
the `opencodex-desktop` entry of `desktop/src-tauri/Cargo.lock`) to 2.67.0. Merge with
`gh pr merge --squash --admin --match-head-commit <head>` after its exact-head checks and the
candidate run are both green. The candidate SHA does not change.

## 3. Promotion PRs

```bash
PV=2.66.0-preview.<YYYYMMDD of the publish day, KST>
git switch -c codex/260925-release-preview-2.66.0 "$CAND"
git merge -s ours --no-edit origin/preview -m "release: promote the verified 2.66.0 preview tree to preview"
bun scripts/release-version-sources.ts sync "$PV"
git commit -am "release: prepare $PV version metadata"
bun scripts/release-version-sources.ts check "$PV"

git switch -c codex/260925-release-main-2.66.0 "$CAND"
git merge -s ours --no-edit origin/main -m "release: promote the verified 2.66.0 tree to main"
bun scripts/release-version-sources.ts check 2.66.0
```

Checks before opening: `git diff --stat $CAND codex/260925-release-main-2.66.0` is empty and
the preview branch differs from `CAND` only in the four version lines. Push with
`--no-verify`, open both PRs from the template, merge each with
`gh pr merge --merge --admin --match-head-commit <head>` (merge commit, never squash, so the
candidate stays an ancestor of both release branches).

## 4. Release-branch CI

`release.yml` requires, at each exact release SHA, a successful push-event `ci.yml` run on that
branch and a successful Service lifecycle run (`package.json` changed since the previous tag).
Read each run's jobs at the merge SHA; failures follow section 1's rerun and defect rules.

## 5. Dispatch

```bash
gh workflow run release.yml --ref preview -f version="$PV" -f tag=preview \
  -f expected-sha=<preview merge SHA> -f dry-run=false
# after the preview release run succeeds (tag ordering: preview of a core before its stable):
gh workflow run release.yml --ref main -f version=2.66.0 -f tag=latest \
  -f expected-sha=<main merge SHA> -f dry-run=false
```

A job that fails after npm acknowledged publication is completed by re-dispatching with the same
version and expected SHA plus `resume-after-npm-publish=true`; a version is never republished.

## 6. Verification

```bash
curl -s https://registry.npmjs.org/@bitkyc08%2fopencodex        # dist-tags.latest / .preview
gh release view v2.66.0 --json assets,isPrerelease,targetCommitish
gh release view "v$PV" --json assets,isPrerelease,targetCommitish
curl -sL https://github.com/lidge-jun/opencodex/releases/latest/download/latest.json
```

Acceptance: npm `latest` = 2.66.0 and `preview` = `$PV`; both GitHub releases exist with 25
assets (same as v2.65.0); `latest.json` reports 2.66.0 with a signature for every platform. The
release-outcomes rows of each run plus a direct registry read decide the channel state; a green
run with registry verification `pending` is waited out, not worked around.


## Audit round 1 amendment — fixed preview version

At the start of wp7, compute once and record in the D summary:

```bash
PV="2.66.0-preview.$(TZ=Asia/Seoul date +%Y%m%d)"
```

Every later command (version sync, check, release dispatch, verification) uses that recorded
string, even if the publish crosses midnight KST.
