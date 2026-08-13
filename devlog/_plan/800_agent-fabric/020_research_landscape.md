---
title: FAB-00 Research Landscape
programme_id: OCAF
phase: FAB-00
date: 2026-08-03
---

# 020 -- Research Landscape

Each entry: Source | Date accessed | Relevant fact | Assumption impact (supports / weakens / invalidates). Primary sources preferred.

## A. Codex execution surface

| Source | Date | Fact | Impact |
|---|---|---|---|
| openai/codex `codex-rs/app-server/README.md` (raw, main) | 2026-08-03 | `codex app-server` is JSON-RPC 2.0 bidirectional (like MCP). Primitives: **Thread -> Turn -> Item**. `thread/start` starts a fresh thread; `thread/resume` continues a stored session by `thread.id` (response shape matches `thread/start`). Params include `cwd`, `approvalPolicy`, `sandbox`, `permissions` (e.g. `:workspace`), `runtimeWorkspaceRoots`, `personality`, `serviceName`, `sessionStartSource`. `thread/started` notification exists. Transports: stdio (default), unix socket (`$CODEX_HOME/app-server-control/app-server-control.sock`), websocket (experimental/unsupported). Schema version-pinned via `codex app-server generate-ts --out DIR` and `generate-json-schema --out DIR`. Bounded-queue backpressure (JSON-RPC `-32001`, retryable). Sections: Events, Approvals, Skills, Apps, Auth, Experimental API. | **Supports** Spike A and sec.12: Codex IS externally manageable; start/resume + workspace/permission control + versioned schema exist. |
| openai/codex `codex-rs/utils/home-dir/src/lib.rs` (via docs/codex-path-investigation) | 2026-08-03 | `CODEX_HOME` resolves all durable Codex state; defaults `~/.codex`; rejects missing/non-dir. | Supports sec.12 path canonicalization; OpenCodex already follows this. |
| OpenAI Codex developer docs (developers.openai.com/codex) | 2026-08-03 | `CODEX_HOME` used by CLI, IDE ext, app-server, installers. `--profile` overlays `~/.codex/<name>.config.toml`. | Supports; no managed-execution handoff concept in public Codex docs. |

## B. Claude execution surface

| Source | Date | Fact | Impact |
|---|---|---|---|
| docs.claude.com Agent SDK overview | 2026-08-03 | Agent SDK = same tools/agent-loop/context as Claude Code, programmable in Python & TS (runs in your process). Capabilities: built-in tools, **Hooks** (lifecycle intercept), Subagents, MCP, **Permissions** (auto vs approval), **Sessions** ("maintain context, resume or fork later"), Skills/commands/memory, Plugins, **structured output**, OpenTelemetry. Other languages: run CLI as subprocess with `-p` and `--output-format json`. Branding restricts third-party "Claude Code" naming. | **Supports** Spike B: managed session, working dir, permission events, structured output, resume/fork all available. |
| Claude Code CLI (`claude --version`) | 2026-08-03 | `2.1.220 (Claude Code)` installed locally; `-p --output-format json` usable. | Supports live Spike B execution. |

## C. Protocol landscape

| Source | Date | Fact | Impact |
|---|---|---|---|
| agentcommunicationprotocol.dev | 2026-08-03 | **ACP is now part of A2A under the Linux Foundation** (migration guide published). ACP is REST-based (not JSON-RPC), async-first, stateful+stateless, offline discovery. | **Weakens** the plan's "ACP adapter" framing (sec.13/sec.14): ACP?A2A converged; the maintained adapter path is now A2A-aligned. |
| a2a-protocol.org/latest | 2026-08-03 | A2A v1.0 (Linux Foundation, Apache 2.0, 2026). Primitives: Agent Card, Task, Message, Part, Artifact. JSON-RPC. SSE streaming. Agent-to-agent and **opaque** (no shared internal memory/tools). "Not a sub-agent/tool protocol; complementary to MCP." Originally Google. | **Supports** sec.110: A2A is for FAB-08 remote delegation only. A2A delegates sub-tasks/shares results but does **not** define durable ownership transfer or fencing -> the Fabric's atomic handoff is its own layer, not A2A's. Opaqueness aligns with "native state remains native." |
| docs.ag-ui.com | 2026-08-03 | AG-UI = event-based agent?user protocol; streaming chat with **cancel and resume**, multimodality, shared state, interrupts. Born from CopilotKit + LangGraph/CrewAI. Supports A2A middleware. | Supports sec.21/sec.110: AG-UI is the later dashboard/mobile event projection (FAB-07), not the task core. |
| modelcontextprotocol.io (via structure/03, deps) | 2026-08-03 | MCP already a runtime dependency (`@modelcontextprotocol/sdk`); OpenCodex exposes MCP namespaces. | Supports: MCP is the tool/context boundary, already integrated. |

## D. Reference architectures & gateways

| Source | Date | Fact | Impact |
|---|---|---|---|
| github.com/openai/openai-agents-python | 2026-08-03 | OpenAI Agents SDK: lightweight multi-agent framework, provider-agnostic (Responses + Chat + 100 LLMs), sandboxing via `GitRepo` manifests, realtime/voice agents. MIT. **No distinct "OpenAI Symphony" product found** in public primary sources; this SDK is the closest OpenAI agentic framework. | Supports sec.2.2/sec.030: no OpenAI framework provides cross-harness durable task continuity. "Symphony" reference in the plan is unverified/stale. |
| docs.all-hands.dev (root) | 2026-08-03 | OpenHands: community AI-dev platform -- Agent Canvas (browser+backend), Cloud, Enterprise, a Python "Software Agent SDK" (the agentic engine), legacy CLI/GUI (Docker). MIT (enterprise dir excepted). Event/action stream referenced in SDK. | Reference only (event-stream agent loop); not a Fabric dependency. Deep event page (`/usage/architecture/events`) returned 404; overview-level inspection recorded. |
| docs.litellm.ai | 2026-08-03 | LiteLLM: 100+ LLMs via OpenAI I/O format; router retry/fallback, load balancing, budgets, virtual keys, proxy server, observability callbacks. Python. **No durable task/session continuity or handoff.** | Supports sec.2.2 (gateway commodity thesis); confirms gap (sec.2.3). |
| tensorzero.com | 2026-08-03 | TensorZero: "remains available on GitHub but is no longer maintained." | Supports sec.2.2: gateway attrition; a data point, not viable. |
| git-scm.com/docs/git-worktree (v2.54, 2026-04-20) | 2026-08-03 | `git worktree add/list/remove/lock/prune/repair`; linked worktrees on separate branches; `--lock --reason`. **No built-in per-worktree read-only/permission enforcement**; submodule support incomplete. | **Weakens** sec.17 literal "reviewer worktrees are read-only": must be enforced via OS/FS/process, not git. |

## E. Foundations (standards, not re-fetched)

Event sourcing (append-only + hash chain + snapshots), fencing tokens/leases (monotonic, reject stale writes), SQLite durability (WAL, fsync, atomic rename), process supervision (restart, crash recovery), local IPC (unix socket / Windows named pipe, loopback TLS for dev). These are mature, well-distributed CS practice; treated as supporting background for `080`/`090`/`100`. No assumption invalidated.

## F. Summary of assumption impact

- **Supported**: Codex externally manageable (sec.12); Claude manageable + structured ack (sec.13); MCP already integrated; continuity layer is a real gap (sec.2.3).
- **Weakened/stale**: "ACP adapter" framing (ACP->A2A convergence); "OpenAI Symphony" (no such product found); git-enforced read-only worktrees (must be OS-enforced).
- **Invalidated**: "parallel Go migration line" (sec.7) -- no Go in repo; OpenCodex is TS/Bun. See `120`.
