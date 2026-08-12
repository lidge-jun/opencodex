---
title: FAB-00 TypeScript/Go Runtime Authority
programme_id: OCAF
phase: FAB-00
date: 2026-08-03
---

# 120 -- TypeScript/Go Runtime Authority

## 1. Decision (maintainer-confirmed 2026-08-03)

**`TS_NATIVE_SUPERVISOR`** -- the maintainer has chosen option (A): the Fabric Supervisor is **TypeScript/Bun**, matching the existing opencodex repo and its `@bufbuild/protobuf` / MCP / zod stack. No Go migration line is introduced. This supersedes the earlier `IMPLEMENTATION_BLOCKED_PENDING_GO_AUTHORITY` fallback and the plan's `GO_FIRST_AUTHORISED` (which was not valid against current repo state). Contracts + fixtures + spike kernel + all FAB-00 documents stand; production implementation proceeds in TS.

## 2. Why not `GO_FIRST_AUTHORISED`

The master plan sec.7 asserts "a parallel Go migration line ... applicable behaviour must eventually exist in the Go runtime." FAB-00 evidence (`010` sec.8) **invalidates** this premise:

- No `go.mod`, no `*.go` in the repo. OpenCodex is 100% TypeScript/Bun.
- OpenAI Codex itself is Rust (`codex-rs`), not Go. There is no upstream Go line to inherit.
- System-wide Go (`go1.26.4`) is installed but the project does not use it.

So `GO_FIRST_AUTHORISED` is not a valid decision against current repo state -- there is no Go runtime to be "first" in, and no migration line to defer TypeScript behind.

## 3. Why not `PROGRAMME_REJECTED`

The programme direction (durable cross-harness task continuity) is **sound** (`030`/`150`): Codex and Claude are both externally manageable; the task kernel is feasible; the continuity layer is a real gap. Only the *means* (language) is wrong, not the *end*. Rejection is disproportionate.

## 4. Decision (maintainer-confirmed 2026-08-03)

The maintainer has chosen **(A) TS-native Supervisor**. Product placement: the Fabric is a **new opencodex subsystem** (not a sibling project), per `030` sec.2. This decision is RECORDED, not pending:

- **(A) selected:** the Supervisor is TypeScript/Bun. Contracts (protobuf envelope + JSON Schema fixtures) are language-neutral and shared. `GO_FIRST_AUTHORISED` and a Go migration line are not pursued.

A full TypeScript kernel "ported later to Go" is **not** a passing decision without explicit maintainer override and recorded cost (sec.7 rejected option).

## 5. Duplicate-kernel prevention (regardless of A or B)

- Contracts (protobuf envelope + JSON Schema fixtures) are language-neutral and shared.
- Conformance fixtures are cross-language; both a TS and a Go implementation must pass the same fixtures.
- One Supervisor process boundary; adapters may be in-process TS (Claude SDK) or RPC (Codex app-server) regardless of the Supervisor's language.
- No second event-store, lease, workspace, or handoff kernel.

## 6. Required maintainer/branch approvals

- For (A): maintainer ACK that the Fabric is a new opencodex subsystem in TS; branch off `dev` (not `main`).
- For (B): maintainer ACK of a Go migration plan + branch policy before any production code.

## 7. Evidence locations

`010` sec.8 (no Go), `010` sec.11 (go1.26.4 installed), `150` Spike C (disposable Go kernel demonstrates Go feasibility but does not establish a repo Go line), `020` F (invalidated assumption).
