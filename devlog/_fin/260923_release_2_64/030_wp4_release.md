# 030 — wp4: release

Order is fixed by `scripts/version-line.ts` `assertReleasable`: a candidate must strictly
outrank every existing tag, so the preview of core 2.64.0 is published before the stable
2.64.0. This is a gate, not a convention: once `v2.64.0` exists, `2.64.0-preview.20260923`
no longer outranks the tag set and its publish job refuses. Both channels ship the wp3
candidate tree.

The candidate is the `dev` SHA verified in wp3, taken before the pre-move below. Its four
version sources already read 2.64.0, so the `main` promotion tree is byte-identical to the
verified tree and needs no metadata commit (precedent: candidate `a077087b74` was taken
before the 2.63.0 pre-move #5601).

## 1. Dev pre-move

`release.yml` refuses to publish unless `origin/dev` outranks the release version
(`version-line.ts assert-ahead`). Move `dev` to 2.65.0 first:

```bash
gh workflow run dev-version-bump.yml --ref main -f intended-version=2.64.0 -f mode=pre-move
```

The workflow opens a PR changing only the four version sources to 2.65.0. It is dispatched
as soon as wp3 binds the candidate, so its checks run alongside the candidate run. Confirm
the diff is exactly `package.json`, `desktop/src-tauri/tauri.conf.json`,
`desktop/src-tauri/Cargo.toml` and the `opencodex-desktop` entry of
`desktop/src-tauri/Cargo.lock`, wait until every requested check at its exact head has
succeeded, then admin squash merge it with `--match-head-commit`.

## 2. Promotion PRs

Both promotions start at the candidate and merge the branch tip with the `ours` strategy,
so the promoted tree is exactly the candidate (precedent #5603 and #5602).

```bash
git switch -c codex/260923-release-preview-2.64.0 "$CAND"
git merge -s ours --no-edit origin/preview -m "release: promote the verified 2.64.0 preview tree to preview"
# the only writer of the four version sources (scripts/release-version-sources.ts):
#   package.json                       "version"
#   desktop/src-tauri/tauri.conf.json  "version"
#   desktop/src-tauri/Cargo.toml       [package] version
#   desktop/src-tauri/Cargo.lock       [[package]] opencodex-desktop version
bun scripts/release-version-sources.ts sync 2.64.0-preview.20260923
git commit -am "release: prepare 2.64.0-preview.20260923 version metadata"
bun scripts/release-version-sources.ts check 2.64.0-preview.20260923

git switch -c codex/260923-release-main-2.64.0 "$CAND"
git merge -s ours --no-edit origin/main -m "release: promote the verified 2.64.0 tree to main"
bun scripts/release-version-sources.ts check 2.64.0
```

Checks before opening: `git diff --stat $CAND codex/260923-release-main-2.64.0` is empty,
and the preview branch differs from `CAND` only in the four version lines. Push with
`--no-verify`, open PRs to `preview` and `main` from the template, and merge each with
`gh pr merge --merge --admin --match-head-commit <head>` (a merge commit, never squash,
so the candidate stays an ancestor of both release branches).

Owner steering for this round: merge these two promotion PRs immediately after confirming
their head and base, while their PR checks are pending. This was done for #5670 and #5671.
Their release-branch push CI and Service lifecycle runs still gate publication below.

## 3. Release-branch CI

`release.yml` requires, for the exact release SHA:

- a successful `ci.yml` run with event `push` on that branch (a PR run does not qualify);
- a successful Service lifecycle run, because `package.json` and `desktop/**` changed
  since the previous tag.

Read each run's jobs at the merge SHA. Failures follow wp3's rerun and defect rules.

## 4. Dispatch

```bash
gh workflow run release.yml --ref preview -f version=2.64.0-preview.20260923 -f tag=preview \
  -f expected-sha=<preview merge SHA> -f dry-run=false
# after the preview release run succeeds:
gh workflow run release.yml --ref main -f version=2.64.0 -f tag=latest \
  -f expected-sha=<main merge SHA> -f dry-run=false
```

The release preflight fails fast on a version-source mismatch, an existing tag or release,
an npm version already present, or a tag-ordering violation. A job that fails after npm
acknowledged publication is completed by re-dispatching with the same version and
expected SHA plus `resume-after-npm-publish=true`; the version is never republished.
Other failed jobs are rerun individually.

Push-event CI on `main` and `preview` does not run the Windows shards; the wp3 lane=all
run is the Windows evidence for this tree, which is why both promotions carry the
candidate tree unchanged apart from the preview version line.

## 5. Verification

```bash
curl -s https://registry.npmjs.org/@bitkyc08%2fopencodex   # dist-tags.latest / .preview
gh release view v2.64.0 --json assets,isPrerelease,targetCommitish
gh release view v2.64.0-preview.20260923 --json assets,isPrerelease,targetCommitish
curl -sL https://github.com/lidge-jun/opencodex/releases/latest/download/latest.json
```

Acceptance: `latest` = 2.64.0 and `preview` = 2.64.0-preview.20260923 on npm; both GitHub
releases exist with the same asset count as v2.63.0 (25); `latest.json` reports 2.64.0
with a signature for every platform entry. Registry propagation lag is waited out, not
worked around.

A green release run can still end with registry verification `pending` (the post-publish
smoke retries six times and then reports pending rather than failing). The release-outcomes
rows of each run and a direct registry read, not the run conclusion alone, decide the
channel state.

## 6. Close-out

- Close #5525 with a note that `main` now carries `tauri-plugin-shell` 2.2.1 through the
  2.64.0 promotion.
- Record residual medium alerts (`serde_with`, `time`, `glib`) for a dependency round.
- D summary in `050_done.md`.
