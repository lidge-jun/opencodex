# 020 - Execution record (wp2-wp4)
 
## wp2 worker packets (P artifact)
 
Shared mechanics for every worker (sol/medium, forked session):
 
1. git worktree add /tmp/ocx-repair-<n> -b repair/260815-pr-<n> origin/dev   (run from the main checkout)
2. cd /tmp/ocx-repair-<n>; git fetch origin pull/<n>/head; cherry-pick the PR commits (author preserved); resolve conflicts
3. Apply the named repairs only - no drive-by refactors
4. bun install at root (plus cd gui && bun install when touching gui/)
5. bun run typecheck MUST pass; run ONLY focused tests for touched/added files; NEVER the full suite (owner runs it remotely)
6. Commit with clear messages; DO NOT push; DO NOT touch the main checkout working tree
7. Report: branch, commits, files changed, test tails, rejected repairs + reasons
 
### repair/260815-pr-1664 (MiniMax Code/CLI, 3 commits)
 
Cherry-pick EXACTLY the two non-merge commits (A-audit: skip merge commit 50ac35d02, whose second-parent patch duplicates befd076f6):
  git cherry-pick befd076f601f1c77a57406b93dabe10347013edb
  git cherry-pick cd3c26a4c7a51937c4a58ced88a4cbb5a8519098
Repairs:
- Introduce ONE shared compiled-aware launcher argv helper (Bun.isStandaloneExecutable split: standalone -> spawn(process.execPath, args); source -> spawn(process.execPath, [process.argv[1], ...args])) in a shared cli module.
- Migrate ALL launcher call sites (A-audit expanded scope): PR-head src/cli/minimax.ts:261; existing src/cli/index.ts:123 (+consumers 471/518, dispatch injection 934-936), src/cli/opencode.ts:497, src/cli/claude.ts:272, src/server/management/system-restart.ts:216, src/update/index.ts (251, 301, 307, 331, 375), src/update/job.ts (1869, 1873).
- Unit tests for both modes.
 
### repair/260815-pr-1669 (modelPickerOrder, 1 commit)
 
- Runtime-normalize config value: fail-soft string-array filter before any .filter() use; malformed hand-edited values must not crash catalog sync.
- Malformed-input regression tests; fix docs contradiction in docs-site model-ordering guide.
 
### repair/260815-pr-1660 (terminal guard openai-chat, 2 commits; conflict src/types.ts)
 
- Resolve types.ts conflict against current dev.
- Add explicit-false activation test; combo-attempt and routed-compaction exclusion tests; document the provider option.
 
### repair/260815-pr-1652 (streamAborted, 1 commit)
 
- Mark streamAborted on the native Responses WebSocket finalize path and src/server/relay-eager.ts eager path (both currently omit it).
- Fix trackSseForRequestLog continuing terminal handling after cancellation.
- Drop the unrelated rate-limit test fixture mutation from the cherry-pick.
 
### repair/260815-pr-1165 (imageInput combo control, 3 commits)
 
- Preserve and regression-test the existing anti-double-expansion deletion (PR head deletes previous_response_id before child dispatch; A-audit: already correct - lock with a test, do not 'fix').
- ocx combo set must not silently reset imageInput disabled mode (round-trip test).
- Add missing Turkish + zh-TW locale keys; stored-image replay coverage.
 
### repair/260815-pr-1644 (Factory Droid docs, 1 commit)
 
- Name the droid provider id in the config example so the verification command works.
- Define the text-only accepted input schema + explicit rejection behavior for images/tool items, in BOTH English and Korean guides.
- Run the docs-site build.
 
## Execution log
 
- KEEP-DRAFT comments posted (8): #1498 #1367 #1552 #1557 #1526 #1624 #1645 #1703.
- Light six: repaired by sol/medium workers in /tmp/ocx-repair-*, independent repair
  review (1 blocker folded: 2 missed launcher sites -> fixed 2f276ebe, re-verified),
  integrated into int/260815-old-drafts, lidge gates green, landed via #1744
  (dev merge 656376fc6); 6 source PRs closed with attribution comments.
- Post-land regression: dev CI red on GUI gates (mcode inventory assertions, zh-TW
  allowlist) - fixed via #1749 (84dc86610), dev CI green (cc8e5a30).
- Heavy four: rebuilt by sol/medium workers off int/260815-old-drafts; spec audit
  (4 blockers) folded into packets mid-flight; repair review (5 blockers) folded and
  re-verified PASS x4. Integrated into int/260815-heavy in audit order
  (#1521 -> #1584 -> #1569 -> #1655); 3 conflicts resolved (import union;
  pacing slot moved inside runTurnAttempt so retries consume pacing slots).
  Lidge suite caught a #1521 regression (post-flight registry read emptied
  discovered models); fixed in-session via WeakMap capture (9a8f7351f).
  Final tree 2799fba20: lidge suite 12330 pass / 0 fail. LANDING HELD pending
  owner scope decision; status comments posted on #1521 #1584 #1569 #1655.
- Release hardening: #1753 channel-forward version guard landed (a147da455).
 
