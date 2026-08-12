---
title: FAB-00 Protocol Boundaries
programme_id: OCAF
phase: FAB-00
date: 2026-08-03
---

# 110 -- Protocol Boundaries

| Boundary | Role in Fabric | Phase |
|---|---|---|
| `codex app-server` (JSON-RPC, stdio/unix socket) | Managed Codex execution: `thread/start`, `thread/resume`, approvals, events, versioned schema | FAB-03+ |
| Claude Agent SDK (TS, in-process; `-p --output-format json` for other langs) | Managed Claude execution: sessions resume/fork, permissions, hooks, structured ack | FAB-04+ |
| ACP / A2A (now converged under Linux Foundation; JSON-RPC, SSE, opaque) | **Deferred** -- remote agent delegation only; A2A does **not** define durable ownership transfer/fencing -> the Fabric's atomic handoff is its own layer | FAB-08 |
| AG-UI (event-based agent?user) | Dashboard/mobile event projection (cancel/resume/shared state) | FAB-07 |
| MCP (already a runtime dep) | Tools + external context; already integrated in opencodex | ongoing |
| OpenCodex Task Core (this programme) | Internal source of truth -- the only durable task + ownership + loss ledger | FAB-01+ |

## Sequencing decision (sec.14)

Do **not** begin with A2A or AG-UI. Internal task semantics must work locally first (FAB-01->FAB-04). A2A/AG-UI are projections/remotes layered on a working local Task Core.

## Key finding (grounded in `020`)

ACP merged into A2A. The plan's "ACP adapter" framing (sec.13/sec.14) is **stale**; the maintained generic-harness integration path is now A2A-aligned and is **remote/opaque**, not a local managed-execution surface. Local managed execution for Codex and Claude uses their native SDKs (app-server, Agent SDK), **not** ACP/A2A. This sharpens, not weakens, the design: the Task Core is the local source of truth, and A2A is purely the FAB-08 remote boundary.
