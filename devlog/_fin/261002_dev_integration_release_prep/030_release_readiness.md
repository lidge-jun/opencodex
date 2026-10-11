# 030 — wp3: dev-head verification and release readiness

After #6448 merges, on the final `dev` head H:
1. `gh workflow run ci.yml --ref dev` and `gh workflow run service-lifecycle.yml --ref dev`; confirm both runs report headSha H.
2. Wait for completion. For each failed job read the failing test and its stack. Treat it as a regression candidate first:
   check whether its code path intersects the PRs landed today (#6427, #6446, #6447, #6441, #6448). It may be called flaky only
   when all hold: the same test passed on an earlier dispatch that already contained the same owning code, the failure
   signature is environmental (timeout/EPERM/port) rather than an assertion on changed behavior, and a single rerun of the
   failed job passes. Path disjointness or a signature alone is not enough. Regressions get a fix PR, then a fresh dispatch.
3. Grep the windows shard log for "cmd waits out the npm Bun placeholder" to record #6441 activation.
4. Readiness facts (read-only): read all four version sources listed in `scripts/release-version-sources.ts` at H and require
   they are equal (2.76.0 expected); latest tags (`v2.75.0`, `v2.75.0-preview.20261001`); no `v2.76.0*` tag or GitHub release;
   `npm view @bitkyc08/opencodex dist-tags` and `npm view @bitkyc08/opencodex@2.76.0 version` show 2.76.0 unpublished.
5. Prepare up to approval: `dev-version-bump.yml` only opens a pull request (ruleset "Protect dev" needs an approving
   review to merge it) and refuses non-default refs (dev-version-bump.yml:89; default branch is main). Run
   `gh workflow run dev-version-bump.yml -R lidge-jun/opencodex --ref main -f intended-version=2.76.0 -f mode=pre-move`, wait for
   it, and record the PR it opens (expected: dev's four version sources 2.76.0 → 2.77.0). A no-op is valid if dev already outranks
   2.76.0. Leave that PR open for the user.
6. Report: H, version, run ids, included PRs since v2.75.0, the open pre-move PR, and the next steps that need the user's
   approval: merge the pre-move PR; promote dev → preview / main by PR; then the release authority
   `scripts/release.ts` run by the maintainer on the release branch (it commits the version, waits for push CI and dispatches
   `release.yml`). This loop runs none of those.

## P revalidation (wp3, 2026-10-02)

Previous D (wp2): #6448 landed as e0af52c8a2; direction unchanged.
H = e0af52c8a2 (dev log: #6446, #6447, #6444, #6441, #6448 since a300b57c81). No v2.76* tag or GitHub release; npm dist-tags
latest=2.75.0, preview=2.75.0-preview.20261001; npm view @2.76.0 → 404 (unpublished). No open codex/dev-version-* PR.
service-lifecycle.yml accepts workflow_dispatch (no inputs); ci.yml dispatch input lane defaults to all.
B order: check out H in the session source worktree (delta + static reads), dispatch ci.yml and service-lifecycle.yml on dev,
wait for both, triage per step 2, and only when both are green dispatch the pre-move (step 5). If dev moves during the wait,
H stays the evidence SHA and the report names any newer commits as not covered.
C: read the four version sources at H, re-read run conclusions and the windows shard log for the #6441 wrapper tests, and
write the readiness report into this unit (040 is not needed; the report goes in the final answer).
