---
title: FAB-00 Conformance Strategy
programme_id: OCAF
phase: FAB-00
date: 2026-08-03
---

# 130 -- Conformance Strategy

## 1. Capability manifest

Dimensions: `harness`, `harness_version`, `adapter`, `adapter_version`, `protocol`, `operating_system`, `workspace_mode`, `provider`, `model`, `reasoning_mode`, `sandbox_mode`, `capabilities`, `known_degradations`, `tested_at`, `evidence`.

Status per capability: `claimed | probed | verified | degraded | blocked | unknown`. Only `verified` and explicitly-accepted `degraded` satisfy mandatory requirements.

## 2. Required scenarios (sec.19)

- Session start/resume/fork/interrupt/cancel/close/recovery.
- Text, images, structured context, streaming, duplicate/out-of-order events.
- Serial/parallel/MCP tool calls, errors, cancellation.
- File read/edit/patch, dirty worktree, symlink path, permissions.
- Command/file approvals, decline, expiry, restart.
- Native resume, semantic continuation, reviewer fork, loss block, stale lease.
- Runtime and supervisor crashes.
- Disk full, DB busy, artifact failure, worktree failure, network loss, quota exhaustion.

Each result records exact versions, fixtures, input/output events, exit status, artifact hashes, environment, expected vs observed semantics.

## 3. Test layers (sec.24)

- **Domain:** given/when/then event tests.
- **Projection:** rebuild from zero; rebuild from snapshot; schema upgrade; unknown event; duplicate event; missing artifact; corrupt hash chain.
- **Properties:** sequence increases; one primary owner; fencing token never decreases; completed handoff has one target owner; rollback changes no ownership; permissions never widen without approval.
- **Crash matrix:** kill supervisor at each boundary in `090` sec.3; document recovery result for each.
- **Security:** prompt injection; malicious repo instructions; permission escalation; symlink escape; stale owner; forged acknowledgement; poisoned manifest; artifact tampering; multi-run malicious change; agent answering owner-only prompts.
- **Platforms:** Linux, macOS, Windows -- IPC, paths, ACLs, process trees, worktrees.

## 4. Cross-language fixtures

Fixtures are JSON/protobuf event sequences + expected projections, shared between any TS and Go implementation (`120` sec.5). A conformance run replays fixtures and asserts projections + invariants. Fixtures live under `devlog/_plan/800_agent-fabric/fixtures/` only when a spike justifies them (`140`).

## 5. Regression detection + hard constraints

Versioned manifests enable regression detection across harness/adapter versions. Before any dry-run task routing, **hard constraints** (capability verified, permissions not widened, loss tier <= 2) are evaluated; soft scoring follows only after hard constraints pass (`sec.6` ordering).
