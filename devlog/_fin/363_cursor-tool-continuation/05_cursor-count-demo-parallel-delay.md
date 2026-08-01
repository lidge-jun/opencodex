# 363.05 - Cursor count-demo parallel tool delay

Date: 2026-07-02

## Problem

Cursor-provider tool-count prompts such as "use 10 tools" could look unlike native
Codex:

- Cursor sometimes emitted one `exec_command`, waited for the result, then continued
  one-at-a-time.
- The assistant text sometimes described `mcp_opencodex-responses_exec_command` or
  MCP-shaped names instead of simply treating `exec_command` as the available Codex
  tool.
- The delay between a tool closing and the next tool opening was much longer than on
  OpenAI/Codex-native surfaces.

This is Cursor-specific. The bridge exposes Responses client tools to Cursor as
`McpToolDefinition` entries with provider `opencodex-responses`; this is the Cursor
tool protocol shape, not an external MCP server. Cursor then sends `execServerMessage`
`mcpArgs` frames when it wants a Responses client tool call.

## Confirmed mechanics

1. Codex/OpenAI surfaces already receive system/developer prompt text plus a tool
   catalog. The model is optimized for that tool contract and tends to use the exact
   listed tools when the catalog is clear.
2. Cursor also receives upstream Cursor rules/settings and a Cursor-native tool
   protocol. Our adapter additionally injects the Responses tool catalog into Cursor's
   request context as MCP-shaped tool definitions. Therefore a prompt must explain the
   catalog without pretending that the bridge tool is a real external MCP server.
3. Non-OpenAI model providers are not guaranteed to have the same RL prior around
   Codex tools. Observed failures include trying neighboring-agent names (`Glob`,
   `Bash`, `Read`, `LS`) or a `run_shell` name when those names are not actually in the
   current catalog. The right correction is a catalog-grounded nudge, not a fake tool
   alias.
4. Cursor's stateless Responses bridge cannot return a real `mcpResult` into the same
   Cursor run. Once Cursor asks for a Responses bridge tool, opencodex must surface the
   tool call to Codex, finalize the local Responses turn, cancel/suspend the Cursor h2
   run, then continue on the next `/v1/responses` request with the tool result in
   history.

The slow gap is not caused by shell execution itself. It is caused by the bridge
finalization boundary around Cursor `mcpArgs` plus a too-small grace window for hidden
sibling calls.

## Hypotheses

### H1 - Fixed 50ms finalize grace cuts off late sibling calls

When the first bridge `mcpArgs` drains the known open-tool set, the transport arms a
finalize timer. With the old fixed 50ms grace, a second sibling tool call announced in a
later receive chunk can arrive after the run is already locally finalized. The next tool
then happens only after a new Responses turn, which looks like one-at-a-time tool use.

Verdict: accepted. Keep the fast default, but expand grace only for generic tool-count
demo prompts.

### H2 - A global longer grace would make normal Cursor tools feel slower

A global 750ms-1800ms timer would protect count demos, but every ordinary single-tool
turn would pay that latency before Codex sees the tool call.

Verdict: accepted. The adaptive grace is scoped to generic count-demo prompts and is
disabled on tool-result continuation turns.

### H3 - "not MCP" wording overcorrects and causes weird assistant narration

The old nudge said the tool was "not MCP". Internally the Cursor protocol shape is
MCP-like, so this wording can conflict with what Cursor exposes and make the assistant
talk about `mcp_opencodex-responses_*`.

Verdict: accepted. Use the precise phrase: `exec_command` is the Codex Responses bridge
exec tool exposed through Cursor's tool protocol; it is not an external MCP server tool.

### H4 - Generic count-demo filtering can erase explicit `tool_choice`

The count-demo filter keeps only bare `exec_command` to prevent padding with discovery
tools. However, if the caller explicitly constrains `tool_choice` to a non-exec tool,
filtering before `tool_choice` can advertise zero tools.

Verdict: accepted from gpt-5.5 redteam. Keep the generic exec-only filter only when the
remaining exec tool is allowed by `tool_choice`; otherwise preserve the original catalog
and let `tool_choice` narrow it.

### H5 - `run_shell` can be parallel only if it is truly advertised

The bridge can serialize multiple sibling client tool calls that Cursor emits before
waiting for results, regardless of the tool's wire name. But `run_shell` is not a magic
Codex built-in on this surface. If Cursor is only shown `exec_command`, the assistant
must call `exec_command`. If a future catalog really advertises `run_shell`, the same
parallel-safe tool-call machinery can carry it; the runtime still cannot force the model
to emit siblings in one batch.

Verdict: accepted. The prompt says not to use `run_shell` unless the current tool
catalog lists it.

## Patch plan

1. Keep Cursor-facing `exec_command` as the default bridge tool. Do not switch generic
   demos to `run_shell`.
2. Make Cursor prompt guidance exact-catalog based:
   - list only available wire names;
   - warn against neighboring-agent names unless actually advertised;
   - describe `exec_command` as a Codex Responses bridge tool through Cursor's protocol,
     not as an external MCP server.
3. For generic tool-count demos:
   - append a count-aware user hint;
   - require N separate `exec_command` calls/results;
   - prefer one sibling batch before waiting when the runtime supports parallel calls;
   - avoid `tool_search`, external MCP, and resource discovery as count padding.
4. Filter generic count-demo visible tools to bare `exec_command` only when doing so
   does not violate explicit `tool_choice`.
5. Add request-scoped adaptive finalize grace:
   - normal base: 50ms;
   - generic count-demo minimum: 750ms;
   - per requested tool: 125ms;
   - cap: 1800ms;
   - tool-result continuation: always base grace.
6. Add focused non-E2E regression tests:
   - stale prompt assertions updated to bridge/external-MCP wording;
   - `tool_choice` non-exec narrowing does not produce an empty advertised catalog;
   - ordinary single-tool grace stays base;
   - generic N=10 expands to 1250ms;
   - generic N=50 caps at 1800ms;
   - tool-result continuation does not inherit expanded grace;
   - existing hidden-sibling race test remains green.

## Redteam notes

gpt-5.5 redteam flagged three actionable risks:

- The adaptive grace helper existed but was not wired into the actual timer.
- Generic filtering before `tool_choice` could erase the only allowed tool.
- Tests still asserted old prompt substrings.

All three are addressed in this pass.

## Verification

No E2E was run in this pass.

Local checks:

- `bun test tests/cursor-tool-definitions.test.ts tests/cursor-blob.test.ts tests/cursor-tool-finalize-race.test.ts tests/cursor-tool-continuation.test.ts tests/cursor-protobuf-events.test.ts tests/cursor-tool-arg-decoding.test.ts`
  - 65 pass / 0 fail.
- `bun x tsc --noEmit --pretty false`
  - pass.
- `git diff --check -- src/adapters/cursor/live-transport.ts src/adapters/cursor/protobuf-request.ts src/adapters/cursor/tool-definitions.ts tests/cursor-tool-definitions.test.ts tests/cursor-blob.test.ts tests/cursor-tool-finalize-race.test.ts`
  - pass.

## Remaining out of scope

The fully native same-stream solution still requires a stateful live bridge that keeps
Cursor's h2 run open and later writes a real `mcpResult` after Codex executes the tool.
That would be a larger architectural change. This pass improves the current stateless
multi-turn bridge so count-demo sibling calls are less likely to be cut off and the
model sees a clearer, less misleading tool contract.
