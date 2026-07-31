# 004 - FIX FOUND + VERIFIED: populate AgentRunRequest.mcp_tools

## Result

Browser-under-Cursor is fixable. The cause is NOT provider identity, NOT tool
naming, NOT mcp_instructions - it is that opencodex advertised client tools ONLY
through native-exec `requestContextArgs` (RequestContext.tools), which Cursor does
NOT register into the model's callable catalog. Populating the top-level
`AgentRunRequest.mcp_tools` channel (the `McpTools` wrapper) makes the injected
tools callable. VERIFIED LIVE end-to-end with pure production code (no scaffold):

- cursor/gpt-5.6-luna  -> FINAL function_call `run_probe {"note":"hi"}`
- cursor/claude-4.5-sonnet -> FINAL function_call `run_probe {"note":"hi"}`

Before the fix, every variant (bare name, mcp_-prefixed name, provider `opencode`,
`mcp_instructions` with matching serverName) produced ZERO tool calls - the model
reported the tools unavailable and used Cursor's native Shell. mcp_tools is the one
channel that worked.

## Why phase45 wrongly abandoned this channel

Phase 42 also mirrored tools into `AgentRunRequest.mcp_tools`, but the live Cursor
parser crashed: `parse binary: illegal tag: field no 13 wire type 7` (wire type 7
is invalid = a serialization defect). Phase45 concluded the channel was
"not wire-compatible" and removed it (devlog _fin/350 phase45). That was a
wrong-SHAPE assignment, not a channel rejection: encoding with the correct
`McpToolsSchema` wrapper (`create(McpToolsSchema, { mcpTools: defs })`) produces a
valid request - NO parse crash on gpt-5.6-luna OR claude-4.5-sonnet in this test.
Independent confirmation that real Cursor clients read this channel: agent-vibes
parses `AgentRunRequest.mcp_tools` (sol searcher Poincare, Tier 2).

## The fix (shipped)

`src/adapters/cursor/protobuf-request.ts` `encodeCursorRunRequest`: after
modelDetails, add
```ts
const mcpToolDefs = buildCursorToolDefinitions(request.tools, request.toolChoice);
... mcpToolDefs.length > 0 ? { mcpTools: create(McpToolsSchema, { mcpTools: mcpToolDefs }) } : {} ...
```
RequestContext.tools advertisement (native-exec requestContextArgs) is retained as
a second channel; both are populated. `tests/cursor-blob.test.ts` updated: the
phase45 assertion `run.mcpTools toBeUndefined` becomes `mcpTools.mcpTools.length
== 1` with `toolName == mcp__fs__read_file`.

## Method (how the fix was found) - all on an ISOLATED second proxy

To vary the wire shape without restarting the user's live proxy on 10100, the
experiments ran on a throwaway second proxy (port 10199, isolated
OPENCODEX_HOME/CODEX_HOME copies, tokens deleted after) driven through the real
`/v1/responses` request-builder path. Env-gated scaffolds tested each hypothesis;
all scaffolds were removed before commit. sol cxc-search subagents (Socrates,
Poincare) supplied the Tier-2 protobuf facts: `mcp_tools` = field 4 `McpTools`
wrapper; `RequestContext.mcp_instructions` field 14; the working `opencode-cursor`
bridge's shapes.

## Verification

- `bunx tsc --noEmit` exit 0.
- `bun test tests/cursor-blob.test.ts tests/cursor-request-builder.test.ts
  tests/cursor-tool-definitions.test.ts tests/cursor-native-exec.test.ts` = 44 pass.
- Live end-to-end: both model families call the injected tool (above).

## Residual risk / notes

- Verified on gpt-5.6-luna + claude-4.5-sonnet. Other model families are untested
  for the (now correctly-encoded) mcp_tools channel; the wrapper is standard
  protobuf so a crash is unlikely, but a broad live smoke across the cursor lineup
  is prudent before wide release.
- The user's LIVE proxy (10100) picks up this fix only after a restart; nothing
  changes in their running session until then.
- The tool RESULT return path is unchanged (existing client-tool bridge:
  function_call surfaced -> Codex executes -> result replayed as history next
  turn). A full multi-turn browser round-trip (node_repl -> result -> next call)
  should be smoke-tested once, but no code on the return path changed.
- Committed on branch claudecode. Scaffold fully removed (native-exec.ts /
  tool-definitions.ts restored to clean baseline; the OCX_CURSOR_PROBE_* scaffold
  that got swept into another session's commit 7f80b053 is removed here).
