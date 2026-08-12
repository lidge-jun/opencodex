---
title: FAB-00 Alternatives and Decisions
programme_id: OCAF
phase: FAB-00
date: 2026-08-03
---

# 030 -- Alternatives and Decisions

## 1. Alternatives reconsidered (vs master plan sec.4)

| Alternative | Decision (FAB-00) | Rationale grounded in evidence |
|---|---|---|
| Transcript converter (sec.4.1) | **Retained as degraded fallback only** | Codex app-server + Claude Agent SDK both expose structured/resumable state, so a transcript converter materially underperforms (cannot transfer ownership, approvals, or native continuation). Confirmed. |
| Central task runtime + native adapters (sec.4.2) | **Selected** | app-server (Codex) and Agent SDK (Claude) both support managed start/resume + events + permissions -> adapters are feasible (`150`). Complexity accepted; guarded by leases/fencing (`090`) and threat model (`100`). |
| Universal public protocol first (sec.4.3) | **Rejected** | Collapses to weakest subset; A2A/AG-UI/MCP/codex-app-server boundaries already exist (`020`). |
| Issue-driven autonomous scheduler (sec.4.4) | **Deferred** as a task-source adapter (not canonical) | Useful later; not the task abstraction. |

## 2. Direction mismatch (new finding, see `010` sec.6)

OpenCodex currently is a **DOWNSTREAM** provider proxy (Codex -> opencodex -> provider). The Fabric requires OpenCodex to **also** act as an **UPSTREAM** controller of Codex/Claude sessions (Fabric -> codex app-server / claude SDK). This is a new role, not an extension of the existing provider-routing seam.

**Decision (maintainer-confirmed 2026-08-03):** the Fabric is a **new opencodex subsystem** (not a sibling project). It has its own process boundary (Supervisor), IPC, auth, and persistence. It interacts with the existing opencodex proxy only through (a) shared model/provider/account-pool config for capability evidence and (b) an optional read-only usage-correlation feed. The Supervisor does **not** reuse the `/v1/responses` data plane. This keeps the data-plane latency invariant intact ("a hung agent runtime must not block model routing", sec.6.1).

## 3. Stack decisions grounded in evidence

- **Codex adapter (sec.12):** via `codex app-server` JSON-RPC (stdio or unix socket). **No native-storage mutation.** Evidence (`020` A): `thread/start`, `thread/resume`, approvals, events, versioned schema (`generate-ts`). Feasible -- `150` Spike A.
- **Claude adapter (sec.13):** via Claude Agent SDK (TS, in-process) for structured control; native resume where available, else semantic continuation. Evidence (`020` B): SDK sessions resume/fork, permissions, hooks, structured output. Feasible -- `150` Spike B.
- **Contracts (sec.060):** **protobuf** for the cross-language event envelope + schema (repo already depends on `@bufbuild/protobuf`); JSON Schema generated for fixtures. Protobuf preserves unknown fields by default -> forward-compatible. Decision: protobuf envelope with generated TS + Go bindings.
- **Workspaces (sec.090):** git worktree per role; read-only reviewer enforcement via OS/process sandbox (git has no per-worktree perms -- `020` D).
- **Persistence (sec.090):** SQLite (WAL) for Fabric task state **only**; never shared with native Codex storage (sec.9.2).
- **Leases/fencing (sec.090):** monotonic fencing token per task; one write lease per worktree; stale-writer rejection -- `150` Spike C.

## 4. Decisions not yet finalised (correction required)

- **Language authority (sec.120):** cannot be `GO_FIRST_AUTHORISED` -- no Go line exists in the repo. Decision recorded as `IMPLEMENTATION_BLOCKED_PENDING_GO_AUTHORITY` with a recommended correction. See `120`.
