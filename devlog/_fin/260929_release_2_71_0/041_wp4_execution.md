# 041 wp4 execution: release 2.71.0

Previous D (wp3): #6224 merged, dev d161c0e83e; final CI green including windows 1-9. Direction
unchanged: release that candidate exactly as 040 (same shape as 2.70.0: #6211/#6212/#6213).

Revalidated at wp4 P: dev d161c0e83e (package 2.71.0), preview aa3a8dda16 (2.70.0-preview.20260929),
main 53834ff47b (2.70.0); npm latest=2.70.0, preview=2.70.0-preview.20260929. Candidate C =
d161c0e83ea8a88027b2cef28c125ff3c1f29f8a.

## Order and parallelism

1. Pre-move dispatch (runs on GitHub, ~1 min):
   `gh workflow run dev-version-bump.yml -R lidge-jun/opencodex --ref main -f intended-version=2.71.0 -f mode=pre-move`
   -> PR `codex/dev-version-2.72.0`. Accept only if its files are exactly the four version sources and
   each reads 2.72.0. Its PR CI runs while steps 2-3 proceed; merge it (`--admin --squash
   --match-head-commit`, as #6213) once its Cross-platform CI and gates are green. It is merged
   before any release dispatch; the stable dispatch strictly requires it (release-preflight.sh
   assert-ahead), and doing it first for both keeps one order.
2. Preview branch (managed worktree, clean tree):
   ```sh
   git switch -c codex/promote-preview-2.71.0 d161c0e83ea8a88027b2cef28c125ff3c1f29f8a
   git merge -s ours refs/remotes/canon/preview -m "Merge preview into 2.71.0-preview.20260929 promotion"
   bun scripts/release-version-sources.ts sync 2.71.0-preview.20260929
   git commit -am "chore(release): 2.71.0-preview.20260929"
   git diff --name-only d161c0e83e HEAD   # must list exactly the four version sources
   bun scripts/release-version-sources.ts # check mode: all sources 2.71.0-preview.20260929
   ```
   Push, PR to preview titled "release: 2.71.0-preview.20260929", body as #6211 (plus the two
   pr-assets screenshots because the union touches gui/), merge with `--admin --merge
   --match-head-commit`.
3. Main branch:
   ```sh
   git switch -c codex/promote-main-2.71.0 d161c0e83ea8a88027b2cef28c125ff3c1f29f8a
   git merge -s ours refs/remotes/canon/main -m "Merge main into 2.71.0 promotion"
   git diff --quiet d161c0e83e HEAD      # tree equals the candidate
   ```
   Push, PR to main titled "release: 2.71.0", body as #6212 plus screenshots, merge the same way.
4. Gate per promotion SHA (the merge commits on preview and main): push-event Cross-platform CI and
   Service lifecycle both `success` (release.yml checks both). A red run is diagnosed; a flake with
   evidence may be rerun once; a real defect is fixed on dev and re-promoted.
5. Dispatch, preview first:
   `gh workflow run release.yml -R lidge-jun/opencodex --ref preview -f version=2.71.0-preview.20260929 -f tag=preview -f dry-run=false -f expected-sha=<preview merge sha>`
   then after it succeeds:
   `gh workflow run release.yml -R lidge-jun/opencodex --ref main -f version=2.71.0 -f tag=latest -f dry-run=false -f expected-sha=<main merge sha>`
   On a failure after npm acknowledged publication: same inputs plus `-f resume-after-npm-publish=true`.
6. Verify: `npm view @bitkyc08/opencodex dist-tags --json` (latest=2.71.0, preview=2.71.0-preview.20260929),
   `npm view @bitkyc08/opencodex@2.71.0 gitHead` = main merge sha, `gh release view v2.71.0` (not
   prerelease, asset count as v2.70.0 = 25), `gh release view v2.71.0-preview.20260929` (prerelease),
   latest.json from the v2.71.0 release reports 2.71.0 with signed platforms.
7. Outcome: 090_outcome.md, move the unit to devlog/_fin/260929_release_2_71_0, docs PR to dev from
   a branch on the pre-moved dev tip; merge after its gates.

Merging promotion PRs is owner-authorized in this session ("배포까지 완료"). enforce-target flags
promotion PRs as wrong base by design (2.70.0 precedent); that check is not required for preview/main.

D11 (architect, wp4, ALIGNED): release.yml:847-867 accepts only a push-event ci.yml run on the exact
SHA (a PR run does not count); package.json is in both ci.yml push paths (:51) and
service-lifecycle.yml push paths (:19), so both gating runs fire on each promotion merge commit;
release-preflight.sh enforces dev strictly ahead, so the pre-move PR merges first.
