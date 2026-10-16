# 040 — Fix B: token preamble floor (branch codex/cursor-gap-2)

Research: sol lane Hume (REPORT_DONE). Root cause: bare requests omit the
top-level protobuf mcp_tools field (protobuf-request.ts:979
`mcpToolDefs.length > 0 ? { mcpTools } : {}`), so Cursor upstream
injects its default native tool catalog (~11.6K tokens). With caller
tools present, mcp_tools replaces the default (in=272). Chain:
parser.ts:726/:749 -> tool-definitions.ts:493 -> request-builder.ts:77/:454
-> protobuf-request.ts:979. Locked by tests/cursor-blob.test.ts:1065.

## Diff plan

1. EDIT src/adapters/cursor/types.ts — add
   `suppressDefaultCursorToolCatalog?: boolean` to CursorRunRequest.
2. EDIT request-builder.ts createCursorRequest — set it when
   `budget.tools.length === 0 && !cursorClientThreadOwner(parsed)`
   (bare API caller, no Codex thread identity).
3. EDIT protobuf-request.ts:979 — advertise when
   `mcpToolDefs.length > 0 || request.suppressDefaultCursorToolCatalog`
   (empty McpTools wrapper suppresses upstream default catalog).

Codex-native sessions (thread owner present) keep today's absent-field
behavior — they rely on the native catalog.

## Accept criteria

- Bare no-tool request emits explicit empty mcp_tools {} (blob test).
- Thread-identified no-tool request leaves field absent (unchanged).
- Caller-tool requests unchanged. Focused tests + typecheck green.
- Tests: cursor-request-builder (flag matrix), cursor-blob (wire shape).
