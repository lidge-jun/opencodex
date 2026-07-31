# 002 - WP1 experiment plan: is a client tool callable under Cursor? (B-1 live probe)

## What the parallel sol cxc-search found (refines B-1)

Two sol searchers (Erdos, Anscombe) opened the wire protocol of the WORKING
public bridge `Hardcode84/opencode-cursor` plus `funny-vibes/agent-vibes`:

- `McpToolDefinition` is `{name, description, input_schema, provider_identifier,
  tool_name}`. `provider_identifier` is a PLAIN STRING, not an enum / registration
  token.
- A working bridge advertises tools with a SYNTHETIC provider id `"opencode"` and
  model-facing names `mcp_opencode_<tool>`, injected ONLY through
  `RequestContext.tools`, with NO `mcp.json` registration. The model then emits
  `mcpArgs`, and the bridge routes by `toolName || name` (prefix stripped) - it
  does NOT consult `provider_identifier` for dispatch.
- So "unregistered synthetic provider id" is NOT, by itself, a proven block.
  Requirement is CONSISTENCY: `name` == `mcp_<provider>_<tool>`, `provider_identifier`
  == `<provider>`, `tool_name` == `<tool>`.
- Known extra gates in stock cursor-agent: tool enablement / `--approve-mcps` /
  version-specific catalog staleness. Not applicable to the direct RequestContext
  injection path, but noted.

## The real puzzle (from code read)

opencodex ALREADY advertises client tools via `buildCursorToolDefinitions`
(providerIdentifier `opencodex-responses`, name = bare wire name e.g.
`exec_command` / `node_repl__js`; Cursor displays them as
`mcp_opencodex-responses_<name>`). And `exec_command` IS demonstrably called by
cursor models (tool-definitions.ts comment: live sessions saw
`mcp_opencodex-responses_exec_command`). Yet `mcp__node_repl__js` (Browser) is
not called. So the earlier "opencodex-responses is dropped" root cause is at
least incomplete: at least one client tool under that provider IS callable.

Competing hypotheses to disambiguate with ONE live probe:
- H1 (naming): opencodex sets `name` = bare `toolName`, not `mcp_<provider>_<tool>`.
  Cursor still surfaces `exec_command` (heavily reinforced by system notes) but
  drops/hides other client tools because the model-facing name doesn't match the
  `mcp_<provider>_<tool>` convention the working bridges use.
- H2 (provider id): tools under `opencodex-responses` are second-class; the same
  tool under provider id `opencodex` (matching the working reference) becomes
  callable.
- H3 (behavioral): all client tools ARE surfaced; gpt-5.6-luna just does not
  spontaneously call node_repl, while exec_command wins because of the system-note
  reinforcement. (Then this is not a protocol fix at all.)

## Probe design (isolated, no proxy restart)

Driver: a throwaway script that imports `createLiveCursorTransport` and drives ONE
live turn against api2.cursor.sh using the cursor access token from
`~/.opencodex/auth.json` (via `OPENCODEX_CURSOR_TEST_TOKEN`). This is a pure
outbound h2 request: no second server, no pid file, no config writes, no Codex
sync, zero interference with the live proxy on port 10100.

`buildCursorToolDefinitions` gets an env-gated (`OCX_CURSOR_TOOL_PROBE=1`)
experimental branch that emits the SAME probe tool under 3 variant schemes with
distinct model-facing names in ONE request, so a single live turn tests the whole
matrix (budget: 1 Cursor request):
- V_A: provider=`opencodex-responses`, name=bare `probe_a`  (current scheme)
- V_B: provider=`opencodex`,           name=`mcp_opencodex_probe_b`, toolName=`probe_b`  (working-reference scheme)
- V_C: provider=`opencodex-responses`, name=`mcp_opencodex-responses_probe_c`, toolName=`probe_c`  (current provider, pre-prefixed name)

Prompt forces tool use: "Call every tool available to you exactly once with
minimal args, then stop." `toolChoice: auto`, `parallelToolCalls: true`. Capture
every `tool_call_start`/`tool_call_delta` frame. The variant whose name appears in
a `tool_call_start` is the one Cursor made callable.

## Decision table

- Only V_A fires -> current scheme already callable; node_repl failure is H3
  (behavioral / reinforcement), not protocol. Fix = system-note reinforcement, not
  provider rewiring.
- V_B (and/or V_C) fires but V_A does not -> naming/provider matters (H1/H2). Fix =
  advertise client tools with consistent `mcp_<provider>_<tool>` naming (+ route
  incoming mcpArgs by name, already stripped by `normalizeCursorWireName`).
- Nothing fires -> even a forced tool prompt cannot surface a client tool ->
  disproves the cheap fixes; escalate to NEEDS_HUMAN (B-2 real mcpServers bridge or
  Shell-trampoline, both larger).

## Budget / safety

- Live Cursor probe requests: target 1, hard cap 6 (goal budget). Each variant
  matrix is one request.
- Never restart/kill proxy pid (ocx.pid). Verify pid unchanged before/after.
- All experimental scaffolding (env branch + probe script) is removed before any
  DONE claim; only a real, tested fix (if any) is committed.
- tsc + `bun test tests/cursor-*.test.ts` before completion.

## A-gate audit (main-judged; sol reviewer Ohm died: "workspace out of credits")

VERDICT: GO-WITH-FIXES. The sol reviewer dispatch failed on credits, so this is a
direct independent audit (AUDIT-LOOP-01 fallback). One blocker found and folded:

- BLOCKER (soundness, code-verified): the ORIGINAL isolated-script probe driving
  `createLiveCursorTransport.run()` is UNSOUND for provider-id variants. Both
  `mcpArgsFromToolCall` (protobuf-events.ts:48-51) and
  `mapSyntheticMcpExecToToolEvents` (protobuf-events.ts:126) hard-filter on
  `args.providerIdentifier === OCX_RESPONSES_TOOL_PROVIDER`. A variant-B call
  (provider `opencodex`) is therefore NEVER surfaced as `tool_call_start` through
  `run()` - it routes to native-exec `mcpExec` -> `toolNotFound` and is invisible
  to a CursorServerMessage observer. The script also bypasses the real
  `/v1/responses` system-note injection (`buildCursorToolGuidanceSystemNote`) so a
  negative result would be misleading.

- FIX (folded): run the probe through the REAL path - POST `/v1/responses` to the
  LIVE proxy on 127.0.0.1:10100 (loopback => no API key needed; auth-cors
  `isApiAuthRequired` false) with `debug:true`, and read the RAW protocol frames
  from the `/api/debug/logs` ring buffer. Raw frames are captured BEFORE the
  OCX_RESPONSES surfacing filter, so a toolCall under ANY providerIdentifier is
  observable, and the full production tool-processing path (system notes,
  cursorToolsForActivePrompt) is exercised faithfully. Zero restart, zero config
  writes; verify pid unchanged. This diagnoses which hypothesis (H1/H2/H3) holds;
  the fix (or NEEDS_HUMAN) follows from the frames.
