# 260909 post-2.49 scope cleanup + interview

## Context

v2.49.0 shipped 2026-09-09T12:53Z (main `2f3f73629`, dev reopened at 2.50.0 via #4115).
Before choosing the next bug/improvement round, the user asked for a full
reconciliation pass and then an interview to settle scope.

## Work items

1. Reconcile devlog/_plan units (~150) against public git history; move
   terminal+landed units to _fin. Evidence: parallel read-only recon lanes
   (dispatched as separate Codex tasks, model xai/grok-4.6).
2. Reconcile branches (local + origin) and worktrees against live PR state;
   remove only provably-merged/clean ones; ambiguous ones go to a review list.
3. Build the open-issue disposition table: CLEAR-FIX / LIVE-PROBE / POLICY /
   IMPROVEMENT / STALE-FIXED / DUPLICATE.
4. Interview with the user to pick this round's scope: clear bugs + minor
   UX improvements in; live-probe items deferred unless measurable via
   computer-use; policy items decided one by one.

## Known starting state (verified this session)

- CLEAR-FIX, no open PR: #4112 (non-streaming 413 bypasses overflow mapping),
  #4120 (revoked pool credential stays "ok"), #4089 (agentTaskRecovery gated
  on threadSpawn).
- CLEAR-FIX with draft PRs already open: #3926->#4068, #4083->#4084,
  #4110->#4114.
- POLICY candidates: #3846 (warmup gate registration), #3761 (passthrough
  hosted-search bridge).
- LIVE-PROBE: #3782 (Claude Desktop env), #3781 residual (TUN/Fake-IP),
  #3775 residual (YYLJ gateway/Desktop).
