# 001 - WP1 root cause: why the Browser plugin fails under Cursor routing

## Verdict

NOT a permission problem. Class: tool-advertisement / Cursor-protocol gap
(architectural). Refined after A-gate review (see Synthesis): the precise class
is an UNREGISTERED / SYNTHETIC-PROVIDER routing gap. Cursor DOES surface
dynamically advertised MCP tools - but only ones under a registered, routable
MCP provider (provider.mcpServers). opencodex advertises Codex client tools
(mcp__node_repl__js and every other client tool) under the SYNTHETIC provider
id opencodex-responses (OCX_RESPONSES_TOOL_PROVIDER), which Cursor cannot route
to, so it hides/rejects those tools from the model's callable catalog. The
Browser plugin runs on mcp__node_repl__js, so it is not callable under Cursor
routing and the browser cannot start. No config flag opens it - the earlier
unsafeAllowNativeLocalExec flag only governs Cursor NATIVE read/write/shell
exec, a different mechanism.

## Evidence chain (provider debug ON)

1. Cursor-routed subagent (cursor/gpt-5.6-luna) tool inventory = ONLY Cursor's
   own native agent tools: Shell, Glob, rg, AwaitShell, ReadFile, Delete,
   EditNotebook, TodoWrite, WebSearch, WebFetch, GenerateImage, AskQuestion,
   Subagent, ListMcpResources, FetchMcpResource, SwitchMode, ApplyPatch. NO
   mcp__node_repl__js, NO tool_search, NO github/sites MCP tools.
2. Control: identical subagent on a NON-cursor model (gpt-5.6-sol) = full MCP
   suite INCLUDING mcp__node_repl__js + all mcp__codex_apps__* tools. So the
   difference is the Cursor routing, not the subagent harness.
3. Direct proxy test: POST /v1/responses to cursor/gpt-5.6-luna advertising a
   plain function tool probe_client_tool (tool_choice required). Debug frames
   show requestContextArgs fired once (opencodex DID inject the client tool defs
   via requestContextResult) and the model used its native shellStreamArgs - yet
   the model replied verbatim: "I don't have access to a probe_client_tool in
   this session." Injection happens; the tool never becomes model-callable.

## Why (code + prior devlog)

- opencodex advertises client tools to Cursor via RequestContext.tools
  (native-exec.ts:140 requestContextArgs -> [...mcpToolDefs, ...clientToolDefs];
  buildCursorToolDefinitions maps request.tools to OCX_RESPONSES_TOOL_PROVIDER
  MCP defs; live-transport.ts:417). The advertise+return bridge was built in
  devlog _fin/350 phase 42-43.
- Same channel, different routability: provider.mcpServers tools go into the
  SAME RequestContext.tools response AND are model-callable, whereas the
  synthetic opencodex-responses provider is not routable, so Cursor drops/hides
  its tools from the model catalog (A-gate reviewer, native-exec.ts:140,
  mcp-config.ts:35). So it is not "Cursor ignores all injected tools" - it is
  "Cursor only surfaces tools under a routable provider identity."
- This is documented as a deliberate gap, not a bug:
  devlog/_fin/362_cursor-usage-and-stall/00_overview.md - "the empty MCP listing
  ... is expected: Codex's harness only has node_repl ...; opencodex's Cursor
  adapter only reads provider.mcpServers" and "importing Codex's own MCP config
  into the Cursor adapter is a separate feature, not a bug, left out."
- The obvious alternative channel is already a dead end: AgentRunRequest.mcpTools
  exists in the generated protobuf (agent_pb.ts:2733) but a prior attempt to send
  client tools there made Cursor's live parser REJECT the request as an illegal
  protobuf tag, so the assignment was removed
  (devlog/_fin/350_cursor-provider-add/129_phase45-cursor-tool-wire-compat-live-rca.md).

## Consequence

Every Codex plugin that works through a client MCP tool is unavailable under
Cursor routing: Browser (mcp__node_repl__js), and the mcp__codex_apps__*
github/sites tools. Cursor-native file read/write/shell DO work (that was the
earlier fix). The browser specifically cannot, because it has no Cursor-native
equivalent and Cursor will not surface node_repl.

## Fix feasibility (WP2 input)

No permission toggle exists. A real fix is a C4 protocol-boundary FEATURE, and
the shipped requestContext advertisement does not make synthetic-provider client
tools model-callable on Cursor today. Candidate directions, all uncertain/large:
- (B-1, narrowest hypothesis to test FIRST per A-gate) Make client tools carry a
  routable provider identity Cursor accepts - e.g. register the opencodex client
  bridge as a provider.mcpServers-style routable MCP provider so its tools land
  in the model catalog the same way configured MCP tools do. Needs live Cursor
  protocol experimentation to find an accepted provider shape.
- (B-2) Expose a browser-control bridge as an actual provider.mcpServers MCP
  server the Cursor model CAN call - but node_repl needs the Codex client
  runtime, so this is a new bridge, not a wiring tweak.
- (B-3) AgentRunRequest.mcpTools is NOT viable (phase45: Cursor parser rejects it).
- (B-4) Accept the limitation: use a non-Cursor model for browser/plugin work.

This is a scoping decision (effort vs uncertain payoff at a proprietary protocol
boundary, requiring live Cursor experimentation), so WP2 is NEEDS_HUMAN, not a
silent code change. Next concrete step if the user wants it pursued: B-1 - probe
what routable provider identity Cursor accepts for dynamically advertised tools.

## A-gate synthesis (reviewer: sol/Huygens, GO-WITH-FIXES, 1 blocker folded)

- ACCEPTED: reclassified from "universal Cursor protocol gap" to
  "unregistered/synthetic-provider routing gap" - Cursor surfaces routable-provider
  MCP tools via the same channel; only the synthetic opencodex-responses provider
  is dropped. Verdict "not a permission" and NEEDS_HUMAN disposition upheld.
- Confirmed by reviewer: cursorToolsForActivePrompt does NOT drop a plain function
  tool for a normal prompt (tool-definitions.ts:162), so probe_client_tool did
  populate clientToolDefs - the non-surfacing is Cursor-side routability, not a
  local filter. AgentRunRequest.mcpTools dead-end confirmed (phase45).
