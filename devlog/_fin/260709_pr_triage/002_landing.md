# 002 — WP2 landing plan (diff-level)

Both accepted PRs are MERGEABLE/CLEAN against their preview base.

1. #67: `gh pr merge 67 --merge` (into preview, keeps author credit + merged status). Then
   `git fetch origin pull/67/head:pr-67-head`; cherry-pick its commits onto dev (expected clean —
   git apply --check exit 0, zero intersection with 08ecd31/de12fc8). Gate: tsc + full bun test.
2. #69: `gh pr merge 69 --merge` (into preview). Cherry-pick onto dev; expected single conflict in
   tests/provider-registry-parity.test.ts (~L108 note assertions region): resolution = keep our
   >=38 / grok-4.5 / kimi-k2.7-code assertions AND take the PR's three note assertions
   (unsafeAllowNativeLocalExec, ~/.opencodex/config.json, Providers → Cursor → Edit JSON) —
   registry.ts note hunk comes with the same cherry-pick so assertions align. Gate again.
3. Push dev to origin. Landing comments on #67/#69 (merged into preview + landed on dev@sha).
4. Rollback rule: any gate failure -> git cherry-pick --abort / revert landing commit, flip verdict
   to REQUEST-CHANGES with comment. Preview merges are NOT rolled back (base-branch owner action).

Out: #70/#73/#74 (comments only, done in WP1). Verifier: per-landing tsc exit 0 + bun test 0 fail,
git push output, comment URLs.

## D summary (WP2, DONE — closes the whole unit)
- Landed: #67 -> preview merge + dev cherry-pick 46ac27f; #69 -> preview merge + dev cherry-pick
  2443382 (parity region auto-merged, both assertion sets verified). Gates after each: tsc 0,
  bun test 1658/0. dev pushed 3ec9020..2443382.
- Comments: 9 total (5 PR reviews, 2 landing notes, 2 issue replies incl. Korean #72).
- REQUEST-CHANGES outstanding: #70 (detector over-claims), #73 (rebase + cancel scope), #74
  (compile blocker + cursor + API tests) — all have actionable public comments.
- LOOP-PESSIMIST: #73 carries the fix for issue #72's resource_exhausted — promised a follow-up
  comment on #72 when it lands; #71 promised closure as works-as-intended if no routing failure
  is reported; consider widening cursor advertised effort tiers (follow-up idea from #72).
