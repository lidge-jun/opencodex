# 350.125 — Phase 42: preserve and advertise Responses API tools to Cursor

> Goal: `160d07c7-38b`
> Depends on: 350.124

## Part 1 — Easy explanation

Codex sends tool definitions in the Responses API request. Cursor never sees them today.
This phase carries those definitions into the Cursor request and advertises them through
the Cursor native request context, which is the only tool-discovery channel currently
implemented in the live protobuf bridge.

## Part 2 — Diff-level plan

### MODIFY: `src/adapters/cursor/types.ts`

Add tool metadata to `CursorRunRequest`:

```ts
import type { OcxTool } from "../../types";

export interface CursorRunRequest {
  modelId: string;
  conversationId: string;
  system: string[];
  messages: CursorRequestMessage[];
  tools?: OcxTool[];
  toolChoice?: "auto" | "none" | "required" | { name: string };
}
```

Rationale: this is the narrowest preservation point. It avoids importing protobuf details
into the generic request builder.

### MODIFY: `src/adapters/cursor/request-builder.ts`

Copy tools and tool choice from parsed request:

```ts
export function createCursorRequest(parsed: OcxParsedRequest): CursorRunRequest {
  return {
    modelId: normalizeCursorModelId(parsed.modelId, parsed.options.reasoning),
    conversationId: parsed.previousResponseId ?? generatedConversationId(),
    system: [...(parsed.context.systemPrompt ?? [])],
    messages: ...,
    ...(parsed.context.tools?.length ? { tools: parsed.context.tools } : {}),
    ...(parsed.options.toolChoice ? { toolChoice: parsed.options.toolChoice } : {}),
  };
}
```

### NEW: `src/adapters/cursor/tool-definitions.ts`

One owner for converting `OcxTool` to Cursor `McpToolDefinition`.

Planned API:

```ts
export function buildCursorToolDefinitions(tools: readonly OcxTool[] | undefined): McpToolDefinition[];
export function cursorToolWireName(tool: OcxTool): string;
```

Rules:

- Use `namespacedToolName(tool.namespace, tool.name)` as the advertised name, matching
  chat adapter behavior and existing bridge maps.
- `name` and `toolName` both use the advertised wire name.
- `providerIdentifier` should identify opencodex client tools, e.g. `opencodex-responses`.
- `description` maps from `OcxTool.description`.
- `inputSchema` is JSON bytes of `OcxTool.parameters ?? {}`.
- Preserve `strict` only if Cursor protobuf has a compatible field. If not, do not invent one.

Open question for GPT Pro/audit: whether Cursor uses `RequestContext.tools` only for MCP
tools or accepts generic client tool definitions there. If it is MCP-only upstream, the
fallback is to encode Responses tools into Cursor's expected native tool affordance fields
if generated protobuf exposes them.

### MODIFY: `src/adapters/cursor/native-exec.ts`

Extend context from MCP-only tool defs to all request tool defs:

```ts
export interface CursorNativeExecContext extends CursorNativeExecDeps {
  mcpToolDefs?: McpToolDefinition[];
  clientToolDefs?: McpToolDefinition[];
}
```

In `requestContextArgs`, return merged `tools`:

```ts
const tools = [...(deps.mcpToolDefs ?? []), ...(deps.clientToolDefs ?? [])];
requestContext: create(RequestContextSchema, { tools })
```

Name collision rule: client tools and MCP tools are already namespaced/wire-named. If
duplicates remain, keep first and log once in preparation.

### MODIFY: `src/adapters/cursor/live-transport.ts`

At `run(request)` startup:

- Build client tool defs from `request.tools`.
- Preserve existing MCP preparation.
- Set `this.execContext` to include desktop deps, MCP deps, MCP defs, and client tool defs.
- Ensure this happens before `this.open(...)`, like current MCP preparation.

### Tests

Modify or add:

- `tests/cursor-request-builder.test.ts`: `createCursorRequest` preserves `context.tools`
  and `toolChoice`.
- `tests/cursor-native-exec.test.ts`: `requestContextArgs` includes client tool defs.
- `tests/cursor-tool-definitions.test.ts`: tool definition conversion, namespace wire names,
  duplicate-safe schema bytes.

## Risks

- `RequestContext.tools` might be MCP-only semantically despite the generic name. This needs
  audit and GPT Pro feedback.
- Tool choice may need a Cursor-specific field rather than request-context-only handling.
  If no field exists, we still preserve it on internal types for future mapping and test the
  no-regression behavior.

