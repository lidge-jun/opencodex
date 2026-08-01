# 350.124 — Phase 41: Cursor Responses API tool bridge RCA and slice map

> Goal: `160d07c7-38b`
> Branch: `dev`
> Remote pushed before this phase: `https://github.com/lidge-jun/opencodex/tree/dev`
> Class: C4/C3 multi-phase integration. Cursor provider protocol boundary + Responses API tool contract.

## Easy explanation

Cursor currently returns zero tool calls because opencodex drops the incoming Responses API
`tools[]` before building the Cursor request, and then ignores Cursor's tool-call update
protobufs if the server emits them. Previous MCP work made local MCP execution real after
Cursor asks for an MCP tool, but it did not make Codex's ordinary client tools visible to
Cursor. This band fixes both halves: advertise Responses tools to Cursor, then translate
Cursor tool-call updates back into Responses-compatible events.

## Current evidence

Incoming Responses tools are parsed:

- `src/responses/parser.ts` builds `parsed.context.tools` from `data.tools`.
- `src/bridge.ts` already maps adapter `tool_call_*` events into Responses
  `function_call`, `custom_tool_call`, `tool_search_call`, and MCP namespace outputs.

Cursor drops them:

- `src/adapters/cursor/request-builder.ts` creates `CursorRunRequest` with only
  `modelId`, `conversationId`, `system`, and `messages`.
- `src/adapters/cursor/types.ts` has no `tools` or `toolChoice` field on `CursorRunRequest`.
- `rg "parsed.context.tools" src/adapters/cursor` returns no matches.

Cursor also ignores tool-call updates:

- `src/adapters/cursor/protobuf-events.ts` handles only `textDelta`, `thinkingDelta`,
  `tokenDelta`, and `turnEnded`.
- Generated protobuf already exposes `partialToolCall`, `toolCallDelta`,
  `toolCallStarted`, and `toolCallCompleted` under `InteractionUpdate`.

## Root cause

There are two independent missing bridges:

1. **Advertise bridge missing:** Responses API `tools[]` are not preserved in the Cursor
   request or supplied in `RequestContext.tools`, so Cursor upstream has no client tools to
   choose from. Existing `RequestContext.tools` is currently MCP-only and populated from
   configured local MCP servers, not incoming Codex tools.
2. **Return bridge missing:** Cursor's protobuf tool-call update variants are discarded,
   so even a tool call emitted by Cursor would not become adapter `tool_call_*` events.

## Slice map

| Work phase | Devlog | Outcome | Risk |
| --- | --- | --- | --- |
| 41 | 124 | RCA, scope, GPT Pro review prompt, slice map | Planning |
| 42 | 125 | Preserve Responses `tools[]`/tool choice in Cursor request and advertise them to Cursor in the native context | C4 protocol boundary |
| 43 | 126 | Map Cursor tool-call protobuf updates back to `AdapterEvent` tool calls and verify Responses output | C3 mapper boundary |
| 44 | TBD | Incorporate GPT Pro feedback, close gaps, final verification/audit | C3/C4 depending on feedback |

## Non-goals

- Do not run destructive live Cursor native exec smoke.
- Do not fake computer-use or screen recording. Those remain honest external hooks.
- Do not change generated protobuf files.
- Do not push after new local commits unless the user explicitly asks again.

## Verification strategy

- Unit tests first: prove tool definitions survive `createCursorRequest` and appear in
  `requestContextResult`.
- Unit tests for Cursor protobuf update mapping using generated schemas.
- Bridge-level test: Cursor mapped tool-call event becomes Responses API function-call item.
- Existing focused Cursor tests must stay green.
- `bun x tsc --noEmit` must pass.
- Independent audit before claiming completion.

