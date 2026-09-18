---
title: Which protocol is "ACP" here
unit: 260910_cursor_acp_bridge
phase: 1 of 4
date: 2026-09-10
---

# 010 -- Protocol identity

This phase exists because this repository already got it wrong once, and the
wrong answer is still sitting in a planning document.

## The correction

`devlog/_plan/800_agent-fabric/110_protocol_boundaries.md` records ACP in its
boundary table as:

> `ACP / A2A (now converged under Linux Foundation; JSON-RPC, SSE, opaque)` --
> **Deferred** -- remote agent delegation only [...] | FAB-08

and states as a key finding:

> ACP merged into A2A. The plan's "ACP adapter" framing (sec.13/sec.14) is
> **stale** [...] the maintained generic-harness integration path is now
> A2A-aligned and is **remote/opaque**, not a local managed-execution surface.

That paragraph is about a **different protocol** than the one Cursor speaks. Two
unrelated specifications use the acronym ACP.

## The two ACPs

| | Zed **Agent Client Protocol** | IBM/BeeAI **Agent Communication Protocol** |
|---|---|---|
| Peers | code editor / client <-> coding agent | agent <-> agent |
| Transport | JSON-RPC 2.0, NDJSON over stdio | HTTP/REST, SSE |
| Status | independent, stable at v1 | merged into A2A, Linux Foundation |
| Primary source | agentclientprotocol.com | research.ibm.com |
| Date proof | Zed blog, 2025-08-27 | IBM Think article 2025-06-13; LF merge 2025-08-29 |

Sources opened 2026-09-10.

[zed.dev/blog/bring-your-own-agent-to-zed](https://zed.dev/blog/bring-your-own-agent-to-zed),
dated August 27th, 2025:

> we created the Agent Client Protocol (ACP) [...] Just as the Language Server
> Protocol unbundled language intelligence from monolithic IDEs

[research.ibm.com/projects/agent-communication-protocol](https://research.ibm.com/projects/agent-communication-protocol)
(the 2025-06-13 date belongs to a linked IBM Think article, not the project page
itself -- corrected after audit):

> **IMPORTANT UPDATE - ACP is now part of A2A under the Linux Foundation!**
> [...] **REST-Based Design**: ACP is built on REST principles, exposing
> well-defined HTTP endpoints

[lfaidata.foundation, 2025-08-29](https://lfaidata.foundation/communityblog/2025/08/29/acp-joins-forces-with-a2a-under-the-linux-foundations-lf-ai-data/):

> IBM Research launched the Agent Communication Protocol (ACP) in March 2025 to
> power its BeeAI Platform [...] ACP is officially merging with the A2A under
> the Linux Foundation

The A2A merge is real. It is simply not about the protocol `cursor-agent` speaks.

## What Cursor actually implements

[cursor.com/docs/cli/acp](https://cursor.com/docs/cli/acp), opened 2026-09-10:

> Cursor CLI supports **ACP (Agent Client Protocol)** for advanced integrations.
> You can run `agent acp` and connect a custom client over `stdio` using
> JSON-RPC. Learn more in the official
> [Agent Client Protocol docs](https://agentclientprotocol.com/).

That is a first-party link from Cursor to Zed's spec site. The same page gives
the handshake as `"protocolVersion": 1` and the flow as
`initialize` -> `session/new` or `session/load` -> `session/prompt` ->
`session/update` -> `session/request_permission` -> optional `session/cancel`.

Corroboration from the ACP registry entry
[cursor/agent.json](https://raw.githubusercontent.com/agentclientprotocol/registry/main/cursor/agent.json):
`"id": "cursor"`, `"version": "2026.09.02"`, `"cmd": "./dist-package/cursor-agent"`,
`"args": ["acp"]`, `license: proprietary`.

Independent local corroboration: `cli-jaw` spawns the binary with exactly
`['acp']` at `src/agent/runtime/acp/cursor-session.ts:40-47`, in shipped code.

## Wire model, as it bears on OpenCodex

From [protocol/v1/overview](https://agentclientprotocol.com/protocol/v1/overview)
(page dated 2026-07-24) and
[protocol/v1/transports](https://agentclientprotocol.com/protocol/v1/transports)
(2026-06-01):

> Agents are "programs that use generative AI to autonomously modify code. They
> typically run as subprocesses of the Client."

> The client launches the agent as a subprocess. [...] Messages are delimited by
> newlines (`\n`), and **MUST NOT** contain embedded newlines.

Three properties matter downstream:

1. **The agent owns the turn.** `session/prompt` stays pending for the whole
   turn and resolves with a `stopReason`; intermediate progress arrives as
   `session/update` notifications.
2. **The agent owns its tools.** Tool activity is *reported* to the client as
   `tool_call` / `tool_call_update` updates. The client may be asked for
   approval through `session/request_permission`, with outcomes
   `allow_once`, `allow_always`, `reject_once`, `reject_always`. The client
   does not supply the tool set.
3. **Client filesystem capability is optional.** `fs/*` and `terminal/*` are
   client-side capabilities the agent MAY use; an agent may route file writes
   through `fs/write_text_file` when the client offers it. Declining them does
   not by itself make the agent read-only. `cli-jaw` advertises
   `fs: { readTextFile: false, writeTextFile: false }, terminal: false`
   (`session.ts:161`) and Cursor still works -- so the capability is not
   load-bearing for basic operation. What Cursor does with mutations under that
   configuration was **not** observed here and no claim is made about it.
4. **Modes are client-selectable.** ACP v1 defines `session/set_mode` and a
   `mode` selector in session config options. Cursor exposes `agent` (full tool
   access), `plan` (read-only behavior) and `ask` (read-only behavior). This
   matters more than any other single fact in this unit; see 040.

Licensing is permissive: the spec repository is Apache-2.0, "Copyright 2025 Zed
Industries, Inc. and contributors", with official `@agentclientprotocol/sdk`
(TypeScript) and `agent-client-protocol` (Rust) libraries. A third party may
implement a client. The `cursor-agent` binary itself remains proprietary.

## Model selection over ACP is degraded

This is the finding that most directly affects the OpenCodex question, because
OpenCodex is a model router.

Cursor staff, [forum.cursor.com, 2026-07-28](https://forum.cursor.com/t/acp-qt-creator-upgrade-your-plan-to-continue-after-team-usage-limit-auto-cost-composer-unusable-via-acp-while-desktop-auto-cost-still-works/166862):
ACP "exposes only one variant per model", and Auto's *Optimize For -> Cost*
option "isn't exposed over ACP yet".

Cursor staff, [forum.cursor.com, 2026-04-24](https://forum.cursor.com/t/opus-4-6-fast-mode-not-accessible-via-acp/158943):

> ACP model selection is not exposing the full set of model parameters and
> variants [...] including fast mode / Max Mode / 1M-context variants

Cursor's changelog names ACP progress in Feb 2026 ("Session resume, real agent
modes [...] over the Agent Client Protocol") and Mar 2026 ("Model and mode
selection over the Agent Client Protocol").

## Consequence for this unit

The FAB-08 deferral does not apply to Cursor ACP and cannot be cited as a prior
rejection of it. `110_protocol_boundaries.md` should be annotated. That is a
one-line correction to another unit's document and is therefore recorded here as
a recommendation, not performed in this unit.

Separately, on model access: the vendor has repeatedly reported specific ACP
model-surface gaps (010 above), and OpenCodex's HTTP adapter carries Max Mode
metadata, effort rows and long-context pricing. No live ACP roster was collected
on this host, so "strictly dominates" is **not** established and is not claimed.
What the evidence supports is narrower: the case for ACP should rest on agent
capability rather than model reach. 040 takes that up.
