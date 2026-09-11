# 260828 cursor ndjson + backlog train — unit plan (P artifact, docs-only cycle wp1)

Goal: (1) fix the consumer-backlog turn abort that killed a live Codex app turn
("stream disconnected before completion: consumer backlog exceeded — turn
aborted", incident 2026-08-28 ~01:55 KST during the branch-cleanup turn), and
(2) close the remaining cursor codex-exec defects from the 260826 gap campaign
with live NDJSON empiricism on macmini-cf, delivered as a stacked PR chain.

## Loop-spec header

- Archetype: spec-satisfaction repair (per-defect verifier: activation test +
  live probe closure artifact).
- Trigger: user request — cursor commit lineage + macmini-cf codex-exec NDJSON
  empiricism + stacked PRs until clean; plus RCA/fix of the backlog abort.
- Goal: backlog abort can no longer kill a healthy turn whose consumer
  detached; every open cursor adapter defect has evidence-bound disposition.
- Non-goals: releases, main/preview promotion, credential rotation, closing
  PRs outside this chain, model-class behavior fixes.
- Verifier per phase: bun test <focused file> (repo-wide suite FORBIDDEN by
  user; CI is the wide gate), macmini-cf probe transcripts + NDJSON rows,
  gh pr view. Verifier commands run in each phase doc.
- Stop: stack published, closure probe round clean, or defect dispositioned
  non-adapter-class with evidence.
- Memory artifact: this unit.
- Terminal outcomes: DONE / NOOP (all residuals non-adapter-class) /
  BLOCKED (cursor upstream refuses probes) / NEEDS_HUMAN (account actions) /
  BUDGET_EXHAUSTED (~8h wall clock).
- Escalation upward: a phase packet failing twice returns to main agent.
  Downward: subagent lanes are read-only research/review; implementation
  stays in the main session.
- HOTL bounds: writes confined to this worktree + macmini-cf ~/opencodex +
  scratch dirs; push/PR pre-approved by user (codex/ branches, target dev,
  --no-verify); sol-high subagent dispatch unlimited per user grant.

## Work-phase map (dependency-ordered; goalplan wp ids)

- wp1 (this cycle, docs-only): RCA + defect inventory + this roadmap.
  Deliverables: 000, 001, 002, 010, 020, 030, 040.
- wp2 (010): backlog-abort fix in run-turn-queue/core — detached-consumer
  classification + delta coalescing. Independent PR (stack base A).
- wp3 (020): macmini-cf live probe round — deploy dev + wp2 branch, drive
  codex exec cursor sessions, capture NDJSON; prove/deny each open defect.
- wp4 (030): cursor instrumentation + evidence-bound fixes (stack B on wp2's
  branch only if core files overlap, else parallel stack rooted at dev).
- wp5 (040): closure re-probe + devlog disposition + stack finalization.

## Evidence base

- 001: backlog-abort RCA (sol-high lane, file:line verified).
- 002: cursor open-defect inventory re-verified against origin/dev
  (sol-high lane; supersedes 090/100 follow-up lists).
- macmini-cf: proxy 2.34.0 live (pid 43321, launchd com.opencodex.proxy),
  ~/opencodex on dev (behind 34 at survey time), codex CLI present,
  usage.jsonl 10679 rows.
