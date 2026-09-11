---
title: What cli-jaw actually has
unit: 260910_cursor_acp_bridge
phase: 2 of 4
date: 2026-09-10
---

# 020 -- cli-jaw ACP inventory

Read bound: `/Users/jun/Developer/new/700_projects/cli-jaw` at `f626a0428`.
Nothing here is proposed for vendoring; the point is to establish how much of
this is protocol and how much is `cli-jaw`.

## There are two ACP stacks, not one

A reader looking for "the cli-jaw ACP client" will find two unrelated ones:

- **Native Cursor/Grok**, under `src/agent/runtime/acp/`. This is the one that
  matters for Cursor.
- **Copilot**, a separate 391-line client at `src/cli/acp-client.ts` that spawns
  `copilot --acp` (`acp-client.ts:86-102`), with its own `session/update`
  parser at `src/agent/events/acp.ts`. Despite owning the generic-sounding
  filename and the only ACP test file, it is **not** the Cursor path.

That naming trap is worth recording: `tests/acp-client.test.ts` tests Copilot
spawn args, so "the ACP tests pass" says nothing about Cursor.

## Portability classification

Portable = imports nothing but `node:*` and its sibling `./wire.js`.

| LOC | Class | File | Role |
|---:|---|---|---|
| 43 | portable | `runtime/acp/wire.ts` | JSON-RPC v1 frame decoder |
| 87 | portable | `runtime/acp/notification-queue.ts` | bounded `session/update` queue |
| 214 | portable | `runtime/acp/connection.ts` | NDJSON stdio transport |
| 261 | portable | `runtime/acp/config.ts` | select-option parse, model/effort apply |
| 355 | host | `runtime/acp/session.ts` | ACP session FSM |
| 223 | host | `runtime/acp/runtime-session.ts` | NativeRuntimeSession facade |
| 184 | host | `runtime/acp/callbacks.ts` | inbound permission RPC |
| 161 | host | `runtime/acp/replacement-turn.ts` | replacement turn + events |
| 142 | host | `runtime/acp/projection.ts` | update -> RuntimeProjection |
| 139 | host | `runtime/acp/replacement.ts` | cancel-reprompt controller |
| 137 | host | `runtime/acp/permissions.ts` | v1 permission validation |
| 102 | host | `runtime/acp/grok-session.ts` | Grok spawn/auth factory |
| 86 | host | `runtime/acp/cursor-session.ts` | Cursor spawn/auth factory |
| 59 | host | `runtime/acp/grok-options.ts` | Grok argv/auth/model |
| 56 | host | `runtime/acp/content.ts` | text extraction |
| 24 | host | `runtime/acp/grok-events.ts` | Grok `_meta.usage` |
| 3 | host | `runtime/acp/grok-control.ts` | re-export |
| 140 | host | `agent/cursor-acp-models.ts` | print-name -> ACP-name rewrite |

**605 portable / 1671 host-coupled** for the native package.

Import evidence for the portable claim. `wire.ts` has no imports at all;
`config.ts` has no `import` lines; `notification-queue.ts` imports only
`./wire.js`; and `connection.ts` imports exactly:

```ts
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { decodeFrame, type RpcFrame, type RpcId } from './wire.js';
```

Host coupling is equally explicit. `session.ts` pulls
`../../spawn/process-kill.js`, `../../spawn/exit-drain.js` and
`../requests.js`; `callbacks.ts` and `permissions.ts` both depend on
`shared/runtime-contract.js`; `cursor-session.ts` reaches into
`core/windows-launch-spec.js`, `core/cli-detect.js` and `agent/spawn-env.js`;
`content.ts` imports `events/fulltext-bound.js`.

The practical reading: the transport is genuinely reusable and small, and the
session semantics are not. Roughly 300 lines of `connection.ts` + `wire.ts` is
the honest reuse candidate, and even that is more cheaply obtained from the
official Apache-2.0 `@agentclientprotocol/sdk` than by copying.

## Methods implemented

Client -> agent, all in `session.ts`: `initialize` (`:159`),
`authenticate` (`:171`), `session/new` or `session/load` (`:178`),
`session/set_config_option` (`:196`), `session/set_model` (`:215`, Grok only --
Cursor goes through config selects), `session/prompt` (`:247`), and the
`session/cancel` notification (`:290`).

Agent -> client: `session/request_permission` is handled at `callbacks.ts:58`.
Every other inbound method is refused with `-32601 'Client method unsupported'`
(`callbacks.ts:58-60`). Admitted `session/update` kinds (`session.ts:316`) are
`agent_message_chunk`, `agent_thought_chunk`, `user_message_chunk`,
`tool_call`, `tool_call_update`, `plan`, plus `config_option_update`.

**No `fs/*` or `terminal/*` handlers exist.** Capabilities are advertised false
at `session.ts:161`, and every inbound non-permission RPC is refused. What this
establishes is bounded: a client can decline these capabilities and Cursor still
operates, so client-side filesystem support is not required for basic use.

It does **not** establish what Cursor does with mutations under that
configuration. ACP permits an agent to route writes through
`fs/write_text_file` where offered; whether Cursor instead performs process-local
IO when it is declined was not observed here, and an earlier draft that asserted
it has been corrected. 040 makes no claim resting on it.

## What is Cursor-specific

Small, and worth knowing precisely, because it is all a new implementation would
have to re-derive:

- binary `cursor-agent` (`src/cli/registry.ts:112`), argv `['acp']`
  (`cursor-session.ts:40-47`)
- `authMethodId: 'cursor_login'`, hardcoded (`cursor-session.ts:66`), which must
  appear in the `initialize` `authMethods` response (`session.ts:167-171`)
- `clientMetadata: { parameterizedModelPicker: true }` (`cursor-session.ts:64`)
- model-name rewriting via `cursorAcpModel` (`cursor-acp-models.ts:116`), hooked
  at `cursor-session.ts:71-73`
- on Darwin, `AGENT_CLI_CREDENTIAL_STORE: 'file'` (`spawn-env.ts:118-129`)

The model-rewrite hook carries a comment that is itself evidence:

> Print and ACP spell Cursor models differently, so a configuration that predates
> the transport switch needs translating before it is compared against the
> advertised set (#657).

A vendor whose model identifiers differ between its own two surfaces has already
broken this integration once.

For contrast, Grok on the same stack uses argv
`['agent', '--no-leader', '--always-approve', 'stdio']` and
`xai.api_key`/`cached_token` auth (`grok-options.ts:10-17`) -- so the
per-vendor delta is argv, auth method, and model naming, and nothing deeper.

## Unverified

- No live run. `cursor-agent` is installed at `~/.local/bin/cursor-agent` on
  this host but the macOS login keychain is locked, so advertised
  `authMethods` and the `cursor_login` id are unverified against a live process.
- `structure/agent_spawn.md` still documents the older Cursor *print* mode
  (`cursor-agent -p ...`) while ACP lives in `structure/runtime-integration.md`.
  Stale-doc drift in `cli-jaw` was not audited further; it is out of scope here.
