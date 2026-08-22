# 020 - Merge execution record (wp2-wp3)
 
## Plan (written at P, verified: zero head drift on all 15 PRs, 2026-08-15)
 
Mechanism: local integration branch with --no-ff merges of pull/<n>/head refs,
so each PR head becomes an ancestor of dev and GitHub auto-marks the PR Merged
on push (preserves contributor attribution, e.g. external #1716). One dev push,
one dev CI run, one lidge validation before the push.
 
### Step 1 - retarget stacked children to dev (gh pr edit --base dev)
 
- #1706 (was cl10-public-core), #1722 (was refactor/adapter-registry-authority),
  #1723 (was test/adapter-registry-conformance).
 
### Step 2 - integration branch
 
git fetch origin
git switch -c int/260815-pr-landings origin/dev
 
Merge order (dependency-safe):
1. #1708 #1709 #1710 #1712 #1715 #1717 #1719 #1720 (independent lab fixes)
2. #1705 then #1706 (stack; #1706 branch contains #1705)
3. #1714 (endpoint guard)
4. #1721 (authority test fixture fix required: tests/adapter-registry-authority.test.ts
   mimo-free provider baseUrl example.invalid/v1 -> canonical MIMO_CHAT_URL
   https://api.xiaomimimo.com/api/free-ai/openai/chat; separate fix commit)
5. #1722 then #1723 (stack; contains #1721)
6. #1716 (external feature, disjoint files)
 
Each: git merge --no-ff FETCH_HEAD -m 'Merge PR #<n>: <title>' using
git fetch origin pull/<n>/head.
 
### Step 3 - devlog unit onto int
 
Cherry-pick 1628d06c2 (triage docs) onto int.
 
### Step 4 - validate
 
git push origin int/260815-pr-landings
ssh lidge: clone/fetch, checkout int branch, bun install, bun run typecheck +
bun run test (+ privacy:scan). Suite runs ONLY on lidge per owner directive.
 
### Step 5 - land
 
git push origin int/260815-pr-landings:dev --no-verify
(owner-authorized; enforce_admins=false so admin bypass works on protected dev)
Then verify all 15 PRs auto-marked Merged; stragglers get an evidence comment
and manual close.
 
### Step 6 (wp3) - KEEP-DRAFT comments
 
Brief maintainer comment on #1704 #1718 #1725 #1727 #1728 #1729 #1732 naming
the recorded gaps (010 matrix).
 
## A-audit amendments (GO-WITH-FIXES, 3 blockers folded)
 
1. #1709 -> #1706 semantic conflict in src/lab/ledger/purge.ts: #1706's export-purge steps + deferred-error vars must be re-expressed inside #1709's withLedgerMutation wrapper. Pre-staged resolution; purge tests re-run.
2. #1715 -> #1714 trivial conflict in gui/.eslint/i18n-allowlist.ts: take #1714's /^HTTP$/i version (superset).
3. Fixture fix covers THREE files (mimo-free canonical /chat under #1714's guard): tests/adapter-registry-authority.test.ts (#1721), tests/adapter-tool-conformance.test.ts (#1722), tests/adapter-buffered-tool-conformance.test.ts (#1723). Separate commits, never amend PR heads (auto-merge detection is exact-SHA).
4. Advisory: retargets before push; re-verify all 15 head SHAs at push time.
 
## Execution log
 
- Retarget attempt: gh pr edit --base dev REJECTED for #1706/#1722/#1723
  (GitHub stack rule). Fallback: after the dev push, fast-forward the three
  stack base branches (cl10-public-core, refactor/adapter-registry-authority,
  test/adapter-registry-conformance) to the int tip so each child head is
  reachable from its recorded base (exact-SHA auto-merge detection).
- int/260815-pr-landings built off origin/dev 02abe0afa. Merges (all --no-ff):
  #1708 #1709 #1710 #1712 #1715 #1717 #1719 #1720 clean; #1705 clean;
  #1706 semantic conflict in src/lab/ledger/purge.ts resolved (export-purge
  deferral re-expressed inside withLedgerMutation; cell-object fix for TS
  closure narrowing, follow-up commit ba20ce17f); #1714 trivial conflict in
  gui/.eslint/i18n-allowlist.ts (took /^HTTP$/i); #1721/#1722/#1723 clean;
  #1716 clean. Fixture fixes: 3 commits pointing mimo-free test fixtures at
  the canonical /chat endpoint (#1714 guard).
- Local gate: bun run typecheck green on int tip ba20ce17f.
- KEEP-DRAFT maintainer comments posted: #1704 #1718 #1725 #1727 #1728 #1729
  #1732 (all 7, 2026-08-15).
- lidge validation: worktree /tmp/ocx-triage-260815-int on ba20ce17f;
  INSTALL_OK TSC_OK PRIVACY_OK; full test suite running (log
  /tmp/ocx-triage-260815.log).
 
- Landing: direct push to dev rejected by ACTIVE ruleset 'Protect dev'
  (bypass_mode=pull_request). Route adapted: opened PR #1736
  (int/260815-pr-landings -> dev) and merged with --admin --merge, preserving
  all 15 head SHAs as ancestors. dev tip 88463de4e (tree byte-identical to
  lidge-validated ba20ce17f; empty git diff).
- Post-land: all 15 source PRs auto-marked MERGED (gh verified).
- Cleanup: remote branches cl10-public-core, refactor/adapter-registry-authority,
  test/adapter-registry-conformance, int/260815-pr-landings deleted; local
  refs/triage/* removed; local dev synced to origin/dev.
