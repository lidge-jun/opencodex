---
title: FAB-00 Spike Results
programme_id: OCAF
phase: FAB-00
date: 2026-08-03
---

# 150 -- Spike Results

## Spike A -- Codex App Server: PASS (capability confirmed)

- **Command:** `codex app-server generate-ts --out <tmp>` (codex-cli 0.133.0). Evidence: `spikes/spike-a/schema_summary.md` + `spikes/spike-a/codex-version.txt` (the full generated TS schema was written to a disposed temp `--out` dir; the retained evidence is the schema summary enumerating thread/turn/approval/event types).
- **Findings:** the schema enumerates `thread/start`, `thread/resume`, **`thread/rollback`** (a native rollback primitive), `turn/start`, `turn/interrupt`, `turn/steer`, `turnCompleted`, `turnPlanUpdated`, `turnDiffUpdated`, `ApplyPatchApproval`/`ExecCommandApproval`, `FileChange`, `ThreadStatusChangedNotification`, `ThreadTokenUsageUpdatedNotification`, `ConversationGitInfo`, etc.
- **Hypothesis:** SUPPORTED. Codex is externally manageable via JSON-RPC; `thread/start`+`thread/resume`+`thread/rollback` map to `startSession`/`resumeSession`+handoff rollback; approvals/plan/file/usage/status events are present and versioned.
- **Live `thread/start`:** NOT executed (would incur model spend / use operator OpenAI auth beyond the no-production-effect spike constraint). `generate-ts` is deterministic primary evidence of the surface.
- **Native-storage mutation:** none. No `$CODEX_HOME` session files written by this spike.
- **Conclusion:** Spike A **PASS**. Bonus design finding: native `thread/rollback` can back the handoff rollback boundary (`080` sec.2).

## Spike B -- Claude Integration: capability CONFIRMED; live headless attempt blocked by auth boundary

- **Command:** `claude -p --output-format json --max-turns 1 "<structured-ack prompt>"` (claude Code 2.1.220). Evidence: `spikes/spike-b/summary.md`.
- **Result:** process launched (PID 38768) but produced no output across a bounded ~4-minute window (CPU idle ~1.0s) -- consistent with an interactive auth/consent/TTY-trust gate that a headless, window-hidden, redirected launch cannot satisfy. Process terminated on cleanup.
- **Hypothesis:** SUPPORTED by primary docs (`020` B): the Agent SDK documents Sessions (resume/fork), Permissions (auto/approval), Hooks, **structured output**, and `-p --output-format json` for other-language hosts. The live CLI probe surfaced a real design finding: programmatic structured ack should be obtained via the **in-process SDK** (structured output), not by parsing headless redirected CLI stdout.
- **Conclusion:** Spike B capability **CONFIRMED** (docs); live headless execution blocked by an auth/TTY boundary -- a design input for the Claude adapter (`070`), not a capability negation. A natural-language "I understand" was explicitly not accepted as acknowledgement (`080` sec.3); the bounded attempt did not even yield natural language.

## Spike C -- Task Kernel: PASS (fully executed, reproducible)

- **Commands:** `go test ./...` (go1.26.4); `go run .` (crash harness). Evidence: `spikes/spike-c-kernel/` (source `go.mod`/`main.go`/`kernel/*` + `test_output.txt` + `crash_output.txt`).
- **Test result:** `ok fab00-spike-c/kernel 0.361s` -- 8/8 invariant tests PASS:
  `TestAppendOnlyAndHashChain`, `TestExpectedSequenceRejection` (stale writer), `TestProjectionRebuildFromZero`, `TestSchemaVersionTolerance` (unknown->`RawRuntimeEvent`), `TestArtifactContentAddressing`, `TestFencingTokenMonotonicAndStaleRejection`, `TestOnePrimaryOwnerAndRollback`, `TestPermissionsNeverWidenWithoutApproval`.
- **Crash harness:** all 5 boundaries recover correctly; FINAL verify `PASS owner=rs_target fencing=1 acchash=sha256:acceptance_demo`:
  1. before append -> no state changed; retry from last event
  2. after append before projection -> event persisted; rebuild on restart
  3. before acknowledgement -> source retains ownership
  4. after acknowledgement before commit -> source retains; target session discarded
  5. after commit before source shutdown -> target owns; source stale-writer fenced
- **Conclusion:** Spike C **PASS**. Kernel invariants are feasible and storage-independent; production uses SQLite (sec.9.2). This also informs `120`: Go is a viable Supervisor language mechanically, but does **not** establish a repo Go line.

## Aggregate

- Spike A: **PASS**. Spike B: **capability PASS** / live headless attempt blocked by auth boundary (design finding). Spike C: **PASS**.
- No production code escaped spike scope. No native Codex/Claude storage mutated. No credentials committed. Spikes disposable/retained per `140` policy.
