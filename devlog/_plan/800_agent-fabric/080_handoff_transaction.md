---
title: FAB-00 Handoff Transaction
programme_id: OCAF
phase: FAB-00
date: 2026-08-03
---

# 080 -- Handoff Transaction

## 1. Atomic stages (sec.16)

1. Validate target capability, health, provider/model availability, policy, workspace, and loss tier.
2. Acquire handoff lease.
3. Reach a source safe point (pause/interrupt to a checkpoint).
4. Freeze repository + workspace evidence (commit dirty state; record `git_state`).
5. Produce handoff package (Task Core projection + decisions + evidence refs + outstanding work + bounded brief + effective policy + capability manifest + Semantic Loss Ledger).
6. Create target worktree (`git worktree add` at base_commit / frozen commit).
7. Start target **without** ownership (`SessionStarted`, `cause = semantic_continuation` or `SessionResumed`).
8. Receive structured acknowledgement (sec.3).
9. Commit ownership transfer **atomically** (single tx: flip `current_owner`, increment fencing token, append `HandoffCommitted`, release source ownership).
10. Increment fencing token.
11. Release source ownership + downgrade source worktree to `read_only`.

Pre-commit failure -> rollback to source. Post-commit failure -> target owns; rescue/reversal path.

## 2. Rollback boundary

Ownership commit is the one-way door. **Before it:** all side effects reversible (drop target worktree, discard target session, source keeps lease). **After it:** failure is a target-runtime failure -> quarantine target worktree + rescue run, never silent.

## 3. Target acknowledgement (machine-readable, sec.15)

The target must return a structured record -- **not** natural language -- containing: `task_id`, `workspace_id`, `base_commit`, `current_checkpoint`, `acceptance_criteria_hash`, `loss_ledger_hash`, `effective_policy_hash`, `adapter` + `adapter_version`, `harness` + `harness_version`.

A natural-language "I understand the task" does **not** count (Spike B, `150`). Codex `app-server` `thread/start` returns a structured `thread.id` (machine-readable) -> used as the ack carrier for Codex; Claude uses structured-output JSON.

## 4. Semantic Loss Ledger (sec.15)

Classes: `native | normalised | reconstructed | summary_only | omitted | unavailable | unsafe`.
Tiers: **0** (all native/normalised) -> proceed; **1** (bounded recon/summary, no safety impact) -> warn; **2** (material loss) -> require approval; **3** (permission widening / ambiguous ownership / missing mandatory evidence) -> block.
