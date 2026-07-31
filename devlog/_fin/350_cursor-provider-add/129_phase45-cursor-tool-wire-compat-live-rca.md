# Phase 45 — Cursor Responses Tool Wire Compatibility RCA

## Live symptom

User live retry through `cursor/claude-opus-4-7` failed before any tool executed:

```text
Cursor transport failed before completion (Cursor Connect error internal: parse binary:
illegal tag: field no 13 wire type 7). No Cursor native file, shell, MCP, fetch,
screen, or computer-use command was executed.
```

## Root cause

Phase 42 mirrored Responses client tool definitions into the initial
`AgentRunRequest.mcp_tools` payload while also advertising them through native exec
`RequestContext.tools`.

Unit decoding with the locally generated schema passed, but the live Cursor Connect parser rejected
the initial request. This proves the top-level `AgentRunRequest.mcp_tools` mirror is not
wire-compatible for this client path. Existing Cursor native MCP advertisement already uses
`RequestContext.tools`, and that path remains the safer compatibility boundary.

## Decision

- Do not send Responses client tools in top-level `AgentRunRequest.mcp_tools`.
- Continue advertising Responses client tools through native exec `requestContextArgs` as
  `RequestContext.tools`.
- Keep synthetic Responses tools isolated with provider identifier `opencodex-responses`.
- Keep synthetic tools fail-closed if Cursor asks for them through native `mcpArgs`.

## Patch

- `src/adapters/cursor/protobuf-request.ts`
  - remove top-level `McpToolsSchema` import and `mcpTools` assignment.
- `tests/cursor-blob.test.ts`
  - assert tool-bearing Cursor run requests leave top-level `mcpTools` unset.
  - `tests/cursor-native-exec.test.ts` continues to assert advertisement via
    `RequestContext.tools`.

## Verification

Focused suite after patch:

```text
bun test tests/cursor-blob.test.ts tests/cursor-native-exec.test.ts \
  tests/cursor-request-builder.test.ts tests/cursor-tool-definitions.test.ts \
  tests/cursor-tool-choice.test.ts tests/cursor-tool-arg-decoding.test.ts \
  tests/cursor-protobuf-events.test.ts tests/responses-stream-tool-events.test.ts

32 pass / 0 fail
```

Full verification still required after staging this RCA patch:

- `bun x tsc --noEmit`
- `bun test`
