---
title: FAB-00 Spike Plan
programme_id: OCAF
phase: FAB-00
date: 2026-08-03
---

# 140 -- Spike Plan

Written **before** any spike executes. Each spike is bounded and disposable unless explicitly retained (justified in the handoff). No spike mutates native Codex/Claude storage outside supported APIs; no spike widens sandbox/shell/network/elevation beyond its own stated requirement; no spike touches production code paths under `src/`.

## Spike A -- Codex App Server

- **Question:** Can `codex app-server` be driven externally to start/resume a managed thread, observe approvals/plan/file-change events, and reconnect, with stable versioned identities -- without native-storage mutation?
- **Hypothesis:** `thread/start` + `thread/resume` + versioned schema (`generate-ts`) provide a stable, machine-readable managed-execution surface.
- **Scope:** spawn `codex app-server` (stdio JSON-RPC) in an isolated temp worktree; run `generate-ts`; send `thread/start` with a throwaway `cwd`; subscribe to events; attempt `thread/resume` of the returned `thread.id`; observe approval/plan/file events if reachable.
- **Allowed files:** temp worktree + `devlog/_plan/800_agent-fabric/spikes/spike-a/` (evidence only). **Prohibited files:** `$CODEX_HOME` session SQLite/rollout files (read-only observation only); any `src/` path.
- **Environment:** `codex` 0.133.0; `CODEX_HOME` unset (defaults to `~/.codex`); Windows. Isolated temp `cwd`.
- **Commands:** `codex app-server generate-ts --out <tmp>`; a minimal JSON-RPC client over stdio sending `thread/start`/`thread/resume` (PowerShell or `node` one-shot).
- **Expected evidence:** `generate-ts` output file listing event/method types; captured JSON-RPC `thread/start` response with `thread.id`; `thread/resume` response.
- **Success:** machine-readable `thread.id` returned; `generate-ts` produces a versioned schema; resume returns the same thread identity; no native-storage write observed outside app-server-managed files.
- **Failure:** app-server requires interactive auth we cannot satisfy; events are unstable/unversioned; resume is impossible; or native storage is mutated.
- **Cleanup:** kill app-server process; delete temp worktree + temp `cwd`; keep only `generate-ts` schema + captured messages as evidence.
- **Disposable vs retained:** schema + message captures **retained** as Spike A evidence; temp worktree **disposed**.
- **Max production effect:** none (no `src/` changes; no native Codex storage writes).

## Spike B -- Claude Integration

- **Question:** Can a Claude managed session start in an assigned worktree, emit permission/file events, be cancelled, and return a **machine-readable** structured acknowledgement (not natural language) carrying task/workspace/checkpoint/acceptance-hash/loss-ledger-hash?
- **Hypothesis:** Claude Agent SDK / `claude -p --output-format json` supports structured output + permission hooks + working directory + cancellation.
- **Scope:** run `claude -p --output-format json` in an isolated temp worktree with a prompt that requests a strict JSON acknowledgement object; observe structured output; verify the JSON carries the required hashes.
- **Allowed files:** temp worktree + `devlog/_plan/800_agent-fabric/spikes/spike-b/` (evidence only). **Prohibited files:** `src/` paths; no persisted Claude session state mutated outside the SDK.
- **Environment:** `claude` 2.1.220; isolated temp `cwd`; Windows.
- **Commands:** `claude -p --output-format json --add-dir <tmp> "<prompt requesting JSON ack>"`.
- **Expected evidence:** captured JSON output containing `task_id`, `workspace_id`, `acceptance_criteria_hash`, `loss_ledger_hash`, adapter/harness versions (provided in prompt).
- **Success:** output is valid JSON (parseable), contains the required fields with correct hash echo; a natural-language-only response counts as failure.
- **Failure:** output is natural language only; structured output unsupported; auth unavailable; required fields missing.
- **Cleanup:** delete temp worktree; retain captured JSON as evidence.
- **Disposable vs retained:** captured JSON **retained**; temp worktree **disposed**.
- **Max production effect:** none.

## Spike C -- Task Kernel

- **Question:** Can the smallest isolated kernel demonstrate append-only events with expected-sequence concurrency, hash chain, deterministic projection rebuild, event schema versions, content-addressed artifact hashes, a primary lease with monotonic fencing token, stale-writer rejection, and recovery at every crash boundary?
- **Hypothesis:** A disposable Go program using only the standard library can demonstrate all invariants; production uses SQLite (sec.9.2), but the *protocol invariants* are storage-independent.
- **Scope:** build `spikes/spike-c-kernel/` (Go, stdlib only): an append-only JSONL event log with `sequence`/`event_id`/`previous_event_hash`/`event_hash`; expected-sequence append rejection; projection rebuild from zero; schema-versioned events; content-addressed artifacts (sha256 files); a leases file with a monotonic fencing token; stale-writer rejection; a crash harness that simulates the 5 boundaries in `090` sec.3.
- **Allowed files:** `devlog/_plan/800_agent-fabric/spikes/spike-c-kernel/` only (source + `go.mod` + test output). **Prohibited files:** `src/`; production config; native Codex/Claude storage. No external Go modules (stdlib only) to keep the spike self-contained and avoid network/module-proxy dependence.
- **Environment:** `go` 1.26.4 windows/amd64; Windows.
- **Commands:** `go test ./...` and a `go run` crash-harness entrypoint emitting per-boundary recovery results.
- **Expected evidence:** test output (pass/fail per invariant) + crash-harness output documenting recovery result for each of: before append; after append before projection; before acknowledgement; after acknowledgement before ownership commit; after ownership commit before source shutdown.
- **Success:** every invariant holds (sequence monotonic; one owner; fencing token never decreases; completed handoff ? one target owner; rollback ? ownership unchanged; permissions never widen without approval event; stale writer rejected); every crash boundary recovers correctly with no two-writer state.
- **Failure:** any invariant violated; any crash boundary leaves two writers or corrupts the hash chain.
- **Cleanup:** none required (source retained as evidence; no binaries committed -- add `spikes/spike-c-kernel/.gitignore` for `*.exe`/build cache).
- **Disposable vs retained:** source + test/crash output **retained** as the primary Spike C evidence (it also informs `120`: it proves the kernel mechanics are feasible in Go, while not establishing a repo Go line).
- **Max production effect:** none.

## Execution order

1. Spike C first (self-contained, no external auth) -- validates the task-kernel invariants that A/B depend on.
2. Spike A (Codex app-server) -- schema generation is free/deterministic; live `thread/start` may require auth.
3. Spike B (Claude) -- structured output; may require the user's Claude auth.

## Disposable/retained policy

Only Spike C source + test output, Spike A `generate-ts` schema + message captures, and Spike B captured JSON are retained, under `spikes/`. All temp worktrees and build binaries are disposed. This is justified in the handoff because the spike evidence is the basis for the verdict (`160`).
