# 350.120 — Phase 37 (WP37): real MCP client manager — make MCP tools execute end-to-end

> **Goal:** `3d57a260-c62`. Work-phase 37. **Class C4** (new dependency `@modelcontextprotocol/sdk` + child-process spawning). Full PABCD.
> **Depends on design:** devlog 119 (350.119).

## Part 1 — Easy explanation

opencodex will be able to **actually run MCP tools** that a Cursor model asks for.

Flow:
1. You declare MCP servers in your provider config (`mcpServers`), just like Claude
   Desktop / any MCP host: a `command` + `args` to spawn, or a `url` for a remote server.
2. When a Cursor stream starts, opencodex lazily connects to those servers, asks each
   *"what tools do you have?"*, and tells Cursor's server *"these tools are available"*
   (this is the `requestContext` advertise step that is currently empty).
3. When the Cursor model decides to call one of those tools, Cursor's server sends
   opencodex an `mcpArgs` request. opencodex finds the right server, calls the tool for
   real, and returns the real result.
4. The model can also list/read MCP resources, which now hit the live servers too.

Before: every MCP request → "No local MCP executor is configured."
After: real tool execution against real MCP servers.

## Part 2 — Diff-level plan

### NEW dependency

`@modelcontextprotocol/sdk@^1` (pin v1.x — v2 splits into `@modelcontextprotocol/client`
+ `/server` with different import paths). Add to `package.json` dependencies.
Runtime is Bun; `StdioClientTransport` spawns child processes (Bun-compatible).
Verified subpath exports (v1): `@modelcontextprotocol/sdk/client/index.js`,
`/client/stdio.js`, `/client/streamableHttp.js`, `/inMemory.js` (`createLinkedPair`),
`/server/index.js`, `/server/mcp.js`. tsconfig `moduleResolution: "bundler"` resolves these.

```bash
bun add @modelcontextprotocol/sdk@^1
```

> ⚠️ C4 trigger — new dependency. Justification: it is THE official MCP client SDK; there
> is no in-repo MCP client to reuse (verified: grep for mcp/Mcp finds only the cursor
> adapter deps interface + protobuf gen). Reimplementing JSON-RPC MCP by hand would be
> larger, riskier, and non-standard.

### NEW file: `src/adapters/cursor/mcp-config.ts` (config types + parse)

```ts
import type { OcxProviderConfig } from "../../types";

export interface CursorMcpServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;                 // streamable-http alternative to command
  headers?: Record<string, string>;
  enabled?: boolean;            // default true
  toolPrefix?: string;          // optional namespace
}

export interface ResolvedMcpServer extends CursorMcpServerConfig {
  serverName: string;
}

export function resolveMcpServers(provider: OcxProviderConfig): ResolvedMcpServer[] {
  const raw = provider.mcpServers;
  if (!raw) return [];
  return Object.entries(raw)
    .map(([serverName, cfg]) => ({ serverName, ...cfg }))
    .filter(s => s.enabled !== false)
    .filter(s => Boolean(s.command || s.url));
}
```

### NEW file: `src/adapters/cursor/mcp-manager.ts` (live MCP client manager, <200 lines)

Responsibilities (single owner of MCP client lifecycle):
- Lazily connect to each resolved server (stdio via `StdioClientTransport`, or
  streamable-http via `StreamableHTTPClientTransport`).
- `listAllTools()` → flat list with `{ serverName, tool }`, applying `toolPrefix`.
- `callTool(toolName, args)` → resolve the server owning `toolName`, call it, return the
  SDK result.
- `listResources(server?)`, `readResource(server, uri)`.
- `dispose()` → close all clients/transports.
- Connect + per-call timeouts; per-server connect failures are isolated (one bad server
  does not kill the others) and surfaced as tool errors, never thrown to the stream loop.

Public shape:

```ts
export interface McpToolHandle { serverName: string; toolName: string; advertisedName: string; description: string; inputSchema: unknown; }

export class CursorMcpManager {
  constructor(servers: ResolvedMcpServer[], opts?: { connectTimeoutMs?: number; callTimeoutMs?: number });
  async ensureConnected(): Promise<void>;          // idempotent, lazy
  async listToolHandles(): Promise<McpToolHandle[]>;
  async resolveTool(advertisedName: string): Promise<McpToolHandle | undefined>;  // for typed not-found
  async toolNames(): Promise<string[]>;            // availableTools for McpToolNotFound
  async callTool(advertisedName: string, args: Record<string, unknown>): Promise<{ isError: boolean; content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; }>;
  async listResources(server?: string): Promise<Array<{ uri: string; name?: string; description?: string; mimeType?: string; server: string }>>;
  async readResource(server: string, uri: string): Promise<{ uri: string; mimeType?: string; text?: string; blob?: Uint8Array }>;
  async dispose(): Promise<void>;
}
```

Uses SDK API verified 2026-06-27:
`new Client({name:"opencodex",version})`, `client.connect(transport)`,
`client.listTools()`, `client.callTool({name,arguments})`,
`client.listResources({cursor})`, `client.readResource({uri})`.

### NEW file: `src/adapters/cursor/native-exec-mcp.ts` (protobuf bridge, <160 lines)

Builds `CursorNativeToolDeps` (the `mcp` / `listMcpResources` / `readMcpResource` methods)
from a `CursorMcpManager`, mapping SDK results ⇄ protobuf. Also exports a helper to build
`McpToolDefinition[]` for the advertise step.

```ts
import { create } from "@bufbuild/protobuf";
import {
  McpResultSchema, McpSuccessSchema, McpErrorSchema, McpToolNotFoundSchema,
  McpToolResultContentItemSchema, McpTextContentSchema, McpToolDefinitionSchema,
  ListMcpResourcesExecResultSchema, ListMcpResourcesSuccessSchema, ListMcpResourcesErrorSchema,
  ListMcpResourcesExecResult_McpResourceSchema,
  ReadMcpResourceExecResultSchema, ReadMcpResourceSuccessSchema, ReadMcpResourceErrorSchema,
  type McpArgs, type McpToolDefinition, type ReadMcpResourceExecArgs,
} from "./gen/agent_pb";
import type { CursorNativeToolDeps } from "./native-exec-tools";
import type { CursorMcpManager } from "./mcp-manager";

const textEncoder = new TextEncoder();

export async function buildMcpToolDefinitions(manager: CursorMcpManager): Promise<McpToolDefinition[]> {
  const handles = await manager.listToolHandles();
  return handles.map(h => create(McpToolDefinitionSchema, {
    name: h.advertisedName,
    toolName: h.advertisedName,
    providerIdentifier: "opencodex",
    description: h.description,
    inputSchema: textEncoder.encode(JSON.stringify(h.inputSchema ?? {})),
  }));
}

export function mcpDepsFromManager(manager: CursorMcpManager): CursorNativeToolDeps {
  return {
    async mcp(args: McpArgs) {
      const name = args.toolName || args.name;
      try {
        const decoded = decodeMcpArgs(args.args);   // map<string,bytes> → JSON values
        const handle = await manager.resolveTool(name);
        if (!handle) {
          // AUDIT FIX (blocking #1): toolNotFound must be RETURNED, not thrown.
          // native-exec-tools.ts:41 catch maps any throw → McpError("error"), never toolNotFound.
          return create(McpResultSchema, {
            result: { case: "toolNotFound", value: create(McpToolNotFoundSchema, { name, availableTools: await manager.toolNames() }) },
          });
        }
        const result = await manager.callTool(name, decoded);  // tool-level errors resolve (isError), do not throw
        return create(McpResultSchema, {
          result: { case: "success", value: create(McpSuccessSchema, {
            isError: result.isError,
            content: result.content.map(toContentItem),
          }) },
        });
      } catch (err) {
        // protocol/transport error → typed McpError (still a valid McpResult, never propagated)
        return create(McpResultSchema, { result: { case: "error", value: create(McpErrorSchema, { error: errorText(err) }) } });
      }
    },
    // AUDIT FIX (blocking #3): listMcpResourcesExec (native-exec-tools.ts:48-53) has NO try/catch,
    // so a throw here fails the whole stream. This method MUST NOT throw — wrap internally.
    async listMcpResources() {
      try {
        const resources = await manager.listResources();
        return create(ListMcpResourcesExecResultSchema, { result: { case: "success", value: create(ListMcpResourcesSuccessSchema, {
          resources: resources.map(r => create(ListMcpResourcesExecResult_McpResourceSchema, { uri: r.uri, name: r.name, description: r.description, mimeType: r.mimeType, server: r.server })),
        }) } });
      } catch (err) {
        return create(ListMcpResourcesExecResultSchema, { result: { case: "error", value: create(ListMcpResourcesErrorSchema, { error: errorText(err) }) } });
      }
    },
    async readMcpResource(a: ReadMcpResourceExecArgs) {
      try {
        const r = await manager.readResource(a.server, a.uri);
        return create(ReadMcpResourceExecResultSchema, { result: { case: "success", value: create(ReadMcpResourceSuccessSchema, {
          uri: r.uri, mimeType: r.mimeType,
          content: r.blob ? { case: "blob", value: r.blob } : { case: "text", value: r.text ?? "" },
        }) } });
      } catch (err) {
        return create(ReadMcpResourceExecResultSchema, { result: { case: "error", value: create(ReadMcpResourceErrorSchema, { uri: a.uri, error: errorText(err) }) } });
      }
    },
  };
}
```

`CursorMcpManager` gains `resolveTool(name)` and `toolNames()` so not-found is a typed
RETURN. `callTool` only throws on protocol/transport failure (caught above → `McpError`);
MCP tool-level errors resolve as `{isError:true}` and map to `McpSuccess{isError}`.
Mapping helpers `decodeMcpArgs`, `toContentItem`, plus `errorText` (reuse from
`native-exec-common.ts`) live in this file.

### MODIFY: `src/types.ts` — add config fields to `OcxProviderConfig`

```ts
  // after liveModels / headers block, near other cursor-only options
+  /** Cursor adapter: MCP servers opencodex starts/connects and exposes as callable tools. */
+  mcpServers?: Record<string, import("./adapters/cursor/mcp-config").CursorMcpServerConfig>;
```

(Inline-import type to avoid a hard module cycle; or define `CursorMcpServerConfig` in
`types.ts` and re-export — A-phase audit decides. Default plan: define in `mcp-config.ts`,
inline-import in the field type.)

### MODIFY: `src/adapters/cursor/native-exec.ts` — thread deps + advertise tools

`handleCursorNativeExec` already accepts `deps`. The change: when `requestContextArgs`
arrives, populate `RequestContext.tools` from an injected `mcpToolDefs`:

```ts
-export async function handleCursorNativeExec(execMsg: ExecServerMessage, deps: CursorNativeExecDeps = {}): Promise<Uint8Array[]> {
+export interface CursorNativeExecContext extends CursorNativeExecDeps {
+  mcpToolDefs?: McpToolDefinition[];
+}
+export async function handleCursorNativeExec(execMsg: ExecServerMessage, deps: CursorNativeExecContext = {}): Promise<Uint8Array[]> {
   const execCase = execMsg.message.case;
   if (execCase === "requestContextArgs") {
     return [execBytes(execMsg, "requestContextResult", create(RequestContextResultSchema, {
-      result: { case: "success", value: create(RequestContextSuccessSchema, { requestContext: create(RequestContextSchema, {}) }) },
+      result: { case: "success", value: create(RequestContextSuccessSchema, { requestContext: create(RequestContextSchema, { tools: deps.mcpToolDefs ?? [] }) }) },
     }))];
   }
```

### MODIFY: `src/adapters/cursor/live-transport.ts` — construct manager + inject deps

- Build a `CursorMcpManager` from `resolveMcpServers(input.provider)` once in the
  constructor (lazy connect). If no servers configured → manager is undefined, deps stay
  empty, behavior is unchanged (MCP fully optional).
- **AUDIT FIX (blocking #2 — advertise race):** `run()` currently fires `this.open()`
  without awaiting (`live-transport.ts:95-101`), and `requestContextArgs` can arrive on the
  first server frame before `mcpToolDefs` is ready. Fix: at the **top of `run()`, before
  `this.open(...)`**, `await this.#prepareMcp()` which connects servers + computes
  `this.mcpToolDefs = await buildMcpToolDefinitions(manager)` (best-effort: wrapped in
  try/catch, on failure logs + leaves `mcpToolDefs = []` and continues). This guarantees
  defs exist before any `requestContextArgs`. No-server case: `#prepareMcp` returns
  immediately.
- Replace the no-deps call (actual line **:200**, not :199):

```ts
-      const replies = await handleCursorNativeExec(message.message.value);
+      const replies = await handleCursorNativeExec(message.message.value, this.execContext);
```

where `this.execContext: CursorNativeExecContext = this.mcpManager
  ? { ...mcpDepsFromManager(this.mcpManager), mcpToolDefs: this.mcpToolDefs }
  : {}`. (`execContext` is recomputed/memoized after `#prepareMcp`.)
- **AUDIT FIX (note):** `close()` is synchronous (`:119`), `dispose()` is async. Wire as
  `void this.mcpManager?.dispose();` (fire-and-forget cleanup) — `CursorTransport.close?`
  allows `void | Promise<void>`, so returning the dispose promise is also acceptable; plan
  uses `void` to keep `close()` non-blocking.

### Tests: `tests/cursor-mcp-manager.test.ts` (NEW)

Mirror the existing `tests/cursor-native-exec.test.ts` pattern (deps-injected
`handleCursorNativeExec` + protobuf round-trip). Use the SDK's in-memory transport:

```ts
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";   // createLinkedPair()
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";          // high-level server fixture
```

Build an in-process `McpServer` exposing one tool + one resource, connect a
`CursorMcpManager` to its linked transport (manager gains an internal seam to accept a
pre-built transport for tests, or the fixture exposes a stdio-like pair). Assert:
- `listToolHandles()` returns the tool with prefix applied.
- `callTool` success → `McpSuccess` with text content; `isError` propagated.
- unknown tool → typed not-found mapping.
- `listResources` / `readResource` map to protobuf success.
- `buildMcpToolDefinitions` emits a valid `McpToolDefinition` with JSON `inputSchema` bytes.
- `dispose()` closes cleanly.

## Verification plan

1. `bun add @modelcontextprotocol/sdk@^1` then `bun x tsc --noEmit` → zero errors.
   (Note: tsconfig `include` is src-only, so `tsc --noEmit` does NOT typecheck the test
   file; run the test to validate test-side types via Bun's transpile.)
2. `bun test tests/cursor-mcp-manager.test.ts` → all pass.
3. `bun test tests` → no regressions in existing cursor tests.
4. Independent employee review (C4): confirm new dependency justified, child-process
   lifecycle disposed (`void dispose()` on close), no fake results, not-found RETURNED
   (not thrown), deps methods never throw to the stream, advertise computed before first
   `requestContextArgs`, deps actually threaded at **live-transport.ts:200**.

## Audit resolution (devlog 120, agent 67ff93b3)

Plan A-phase audit returned FAIL → all 3 blocking issues fixed in this revision:
1. **toolNotFound RETURNED not thrown** — `mcpDepsFromManager.mcp` returns
   `McpResult.case="toolNotFound"` via `resolveTool` miss; throws map to `McpError`.
2. **Advertise race** — `run()` awaits `#prepareMcp()` (connect + buildMcpToolDefinitions)
   before `this.open()`, so `mcpToolDefs` is ready before any `requestContextArgs`.
3. **listMcpResources cannot throw** — method wraps in try/catch → typed
   `ListMcpResourcesError` (the dispatcher has no wrapper for this case).
Non-blocking applied: SDK pinned `^1`; import paths fixed (`/inMemory.js`,
`/server/mcp.js`); inject line corrected to :200; `close()` uses `void dispose()`;
tsconfig/test typecheck caveat noted.

## Out of scope (this WP)

- computer-use / record-screen (WP38 / devlog 121).
- Native-exec policy gate integration (devlog 111 / phase 28) — referenced, not built here.
- Live network MCP integration test (covered by in-memory fixture).

## Cross-references

- Design: devlog 119
- Deps interface: `src/adapters/cursor/native-exec-tools.ts:26`
- Dispatch: `src/adapters/cursor/native-exec.ts:47`
- Inject site: `src/adapters/cursor/live-transport.ts:199`
- Advertise field: `RequestContext.tools` (`gen/agent_pb.ts:10251`), `McpToolDefinition` (`:8969`)
- jawcode advertise pattern: subagent dc65e9c5 (buildMcpToolDefinitions, requestContextResult.tools)
