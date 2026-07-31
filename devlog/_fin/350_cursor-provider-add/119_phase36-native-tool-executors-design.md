# 350.119 — Phase 36 (design): native tool executors — MCP / computer-use / record-screen

> **Type:** Phase 0 design-only PABCD pass (slice map + spec, no code).
> **Goal:** `3d57a260-c62` — wire real local executors for the Cursor native-exec tool bridge.
> **Band:** new work-phases 36–38 (devlog 119–121), following the GPT-Pro remediation band (28–35 / devlog 111–118).

## Easy explanation (non-developer terms)

When a Cursor model wants to use a "tool" while talking to opencodex, Cursor's server
sends opencodex a request like *"run this MCP tool"*, *"list MCP resources"*, *"control
the computer"*, or *"record the screen"*. Today opencodex always answers *"no executor is
configured"* for all four — so those tools never actually run.

This band makes the realistic, honest subset of that **actually work**:

1. **MCP (the real win).** opencodex will start the MCP servers you list in config
   (the same `command + args` style every MCP host uses), discover their tools, tell
   Cursor's server *"these tools exist"*, and when Cursor asks to run one, opencodex
   runs it against the live MCP server and returns the real result. This is a standard,
   well-defined protocol, so it can be implemented correctly end-to-end.

2. **computer-use / record-screen (honest handling).** opencodex is a **headless proxy**
   — it has no screen, mouse, or recording surface of its own, so it cannot truthfully
   "control the computer". Instead of faking it, opencodex will (a) expose an optional
   hook so a *host* process that DOES have a screen can plug in a real executor, and
   (b) by default return a precise, truthful "not supported in this headless proxy"
   result. No fake automation, no silent success.

The reference implementation (jawcode) only has a real injection point for MCP and
empty-acks the other three — so this band is at least as capable as jawcode for MCP and
strictly more honest/explicit for the rest.

## Pre-write evidence

### Current opencodex state (the gap)

The deps interface and dispatch already exist and are correct:

```26:32:src/adapters/cursor/native-exec-tools.ts
export interface CursorNativeToolDeps {
  mcp?: (args: McpArgs) => McpResult | Promise<McpResult>;
  listMcpResources?: () => ListMcpResourcesExecResult | Promise<ListMcpResourcesExecResult>;
  readMcpResource?: (args: ReadMcpResourceExecArgs) => ReadMcpResourceExecResult | Promise<ReadMcpResourceExecResult>;
  computerUse?: (args: ComputerUseArgs) => ComputerUseResult | Promise<ComputerUseResult>;
  recordScreen?: (args: RecordScreenArgs) => RecordScreenResult | Promise<RecordScreenResult>;
}
```

But the live transport calls the dispatcher with **no deps**, so every tool case hits the
"no executor configured" branch:

```199:202:src/adapters/cursor/live-transport.ts
    if (message.message.case === "execServerMessage") {
      const replies = await handleCursorNativeExec(message.message.value);
      for (const reply of replies) this.stream.write(encodeConnectFrame(reply));
      return;
    }
```

And the `requestContextResult` is sent with an **empty** `RequestContext`, so the Cursor
server is never told any MCP tools exist — meaning it will never send `mcpArgs` at all:

```49:53:src/adapters/cursor/native-exec.ts
  if (execCase === "requestContextArgs") {
    return [execBytes(execMsg, "requestContextResult", create(RequestContextResultSchema, {
      result: { case: "success", value: create(RequestContextSuccessSchema, { requestContext: create(RequestContextSchema, {}) }) },
    }))];
  }
```

`RequestContext.tools` (protobuf field 7) is `McpToolDefinition[]` (`agent_pb.ts:10251`).
This is the missing advertise→execute loop.

### Reference (jawcode) — confirmed by read-only research (agent dc65e9c5)

- **MCP:** provider is a thin dispatcher; routes `mcpArgs` to an injected `execHandlers.mcp`
  (`cursor.ts:1155`). The jaw reference backs `mcp` with a tool `Map`, not a live MCP wire
  client. Default with no handler → typed `McpResult.case = "toolNotFound"`.
- **listMcpResources / readMcpResource / computerUse / recordScreen:** **empty-ack stubs**
  (`create(...Schema, {})`, no oneof set) — no injection point exists in jawcode
  (`cursor.ts:1169–1187`).
- **Advertise loop:** `buildMcpToolDefinitions(context.tools)` → sent in
  `requestContextResult.tools`; server later calls back `mcpArgs` with `toolName` matching
  an advertised `McpToolDefinition.toolName` (`cursor.ts:352, 977, 2139`).

**Takeaway:** opencodex will go *beyond* jawcode by backing `mcp` with a **real
`@modelcontextprotocol/sdk` client** (live MCP servers) instead of a local tool map, and by
returning **typed honest results** (not empty-acks) for the resource/computer/screen cases.

### External evidence (MCP TS SDK, verified 2026-06-27)

Official `@modelcontextprotocol/sdk` high-level `Client`:
`new Client({name,version})` + `StdioClientTransport({command,args,env,cwd})`
(or `StreamableHTTPClientTransport`) → `client.connect(transport)` →
`listTools()`, `callTool({name,arguments})`, `listResources({cursor})`,
`readResource({uri})`. `callTool` returns `{isError, content[], structuredContent?}`;
tool-level errors resolve (do not throw); protocol errors throw `McpError`.
Source: ts.sdk.modelcontextprotocol.io/documents/client.html (fetched).

## Decision — work-phase slice map

| WP | Devlog | Outcome (consumer-visible) | Class |
|----|--------|----------------------------|-------|
| **36 (this doc)** | 119 | Design + spec + slice map (Phase 0, code-free) | C5→design |
| **37** | 120 | **MCP tools actually execute**: config `mcpServers` → live MCP clients → advertise tools to Cursor → `mcp`/`listMcpResources`/`readMcpResource` run end-to-end | **C4** (new dependency `@modelcontextprotocol/sdk`, spawns child processes) |
| **38** | 121 | **computer-use / record-screen honestly handled**: config-driven external-executor hooks + typed "not supported in headless proxy" default; deps threaded from config | C3 |

Each of WP37 and WP38 is its own full P→A→B→C→D cycle.

### Why this split

- WP37 (MCP) is the genuine "make it work" deliverable and carries the only **C4 trigger**
  (new dependency + child-process spawning). It deserves full PABCD + independent review.
- WP38 (computer-use/record-screen) is a smaller, honest wiring task with no new dependency
  and no fake automation; C3 with a focused audit.

### Config surface (decided here, implemented in WP37/38)

Add to `OcxProviderConfig` (cursor adapter only reads them):

```ts
/** MCP servers opencodex starts and exposes to the Cursor agent as callable tools. */
mcpServers?: Record<string, CursorMcpServerConfig>;
/** Optional external executor command for computer-use (headless proxy has none by default). */
computerUseExecutor?: string;   // reserved: spawn-based hook in WP38
/** Optional external executor command for record-screen. */
recordScreenExecutor?: string;  // reserved: spawn-based hook in WP38
```

```ts
export interface CursorMcpServerConfig {
  // stdio (default): spawn a local MCP server
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  // OR streamable-http: connect to a remote MCP server
  url?: string;
  headers?: Record<string, string>;
  // gating
  enabled?: boolean;       // default true
  toolPrefix?: string;     // optional namespace to avoid name collisions
}
```

### Security & safety posture (C4 awareness)

- MCP servers run arbitrary local commands → opt-in only (config-declared), never derived
  from caller input. Document the trust boundary clearly.
- MCP exec must **interoperate with the native-exec policy gate** planned in devlog 111
  (phase 28): MCP tool calls are a native-exec surface and must respect the same
  deny-by-default policy once that lands. WP37 references but does not duplicate that work.
- Child MCP processes must be lifecycle-managed (lazy connect, dispose on transport close,
  timeout on connect/call) to avoid leaks — opencodex is a long-lived server.
- No fake computer-use: returning a fabricated success for screen/mouse control would be a
  "false safety claim" (the exact class flagged as High #3 in the GPT-Pro review). WP38
  returns the truth.

## Verification plan (band-level)

- WP37: `bun x tsc --noEmit` clean; unit tests for the MCP manager (connect, advertise,
  callTool mapping, listResources/readResource mapping, error/notFound mapping) with a
  fake in-process MCP server (`InMemoryTransport`); independent employee review (C4).
- WP38: `tsc` clean; unit tests for default not-supported result + hook delegation; focused
  audit.
- No live-network test is required to pass the gate (MCP stdio uses a local fake server).

## Out of scope

- Real OS-level screen capture / mouse / keyboard automation inside the proxy.
- Re-implementing the native-exec policy gate (owned by devlog 111 / phase 28).
- Changing the file/shell/fetch executors (owned by the remediation band 111–118).

## Cross-references

- Deps & dispatch: `src/adapters/cursor/native-exec-tools.ts`, `native-exec.ts`
- Injection site: `src/adapters/cursor/live-transport.ts:199`
- Advertise loop: `requestContextArgs` branch in `native-exec.ts:49`
- Policy interplay: devlog `111_phase28-native-exec-policy-gate-plan.md`
- Honest-error principle: devlog `117_phase34-error-truth-suffix-audit-plan.md`
- Research: subagent dc65e9c5 (jawcode exec handlers), MCP TS SDK docs (2026-06-27)
