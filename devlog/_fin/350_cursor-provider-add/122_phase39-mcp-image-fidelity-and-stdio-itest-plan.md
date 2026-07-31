# 350.122 — Phase 39 (WP39): MCP image-content fidelity + live stdio integration test

> **Goal:** `3d57a260-c62`. Work-phase 39 (hardening). **Class C2** (localized fidelity fix + test; no new dependency, no public-contract change). Compact PABCD.
> **Follows:** WP37 (devlog 120, MCP), WP38 (devlog 121, desktop).

## Why this exists (stop-audit honesty)

The goal's REQ1 is "execute `mcpArgs` against live MCP servers". The completion-challenge
reviewer (agent 52bc06ae) flagged two real fidelity gaps in that execution path:

1. **Image results are discarded.** `toContentItems` (native-exec-mcp.ts:121) maps EVERY MCP
   content block to `McpTextContent`, so an MCP tool returning an image (`{type:"image",
   data:<base64>, mimeType}`) loses its bytes and the model only sees `[image]`. The
   protobuf has a real `McpImageContent {data: bytes, mimeType}` we should use.
2. **stdio path is only unit-tested via `InMemoryTransport`.** REQ1 claims stdio + HTTP
   connection; a real child-process stdio round-trip is not yet proven.

Neither is "the goal is incomplete" — the goal's core is met and verified — but both
strengthen the exact execution claim, so the honest move is one more compact pass, not a
rubber-stamp.

`listMcpResources` no-deps returning `success + empty[]` was also flagged, but that is
**correct behavior** (the model asked to list and there are none); changing it to an error
would be a regression. Left as-is, documented here.

## Part 1 — Easy explanation

When an MCP tool returns an image (e.g. a screenshot or chart), opencodex currently throws
the picture away and tells the model "[image]". This work-phase passes the real image bytes
through to the model. It also adds a test that spawns a real MCP server as a child process
over stdio (not just an in-memory fake), proving the stdio path opencodex advertises.

## Part 2 — Diff-level plan

### MODIFY: `src/adapters/cursor/native-exec-mcp.ts` — real image mapping

```ts
+import {
+  ...,
+  McpImageContentSchema,
+} from "./gen/agent_pb";

 function toContentItems(result: McpCallResult): McpToolResultContentItem[] {
-  return result.content.map(block => create(McpToolResultContentItemSchema, {
-    content: { case: "text", value: create(McpTextContentSchema, { text: block.text ?? renderNonText(block) }) },
-  }));
+  return result.content.map(block => {
+    if (block.type === "image" && typeof block.data === "string") {
+      return create(McpToolResultContentItemSchema, {
+        content: { case: "image", value: create(McpImageContentSchema, {
+          data: base64ToBytes(block.data),
+          mimeType: block.mimeType ?? "application/octet-stream",
+        }) },
+      });
+    }
+    return create(McpToolResultContentItemSchema, {
+      content: { case: "text", value: create(McpTextContentSchema, { text: block.text ?? renderNonText(block) }) },
+    });
+  });
 }
+
+function base64ToBytes(b64: string): Uint8Array {
+  return Uint8Array.from(Buffer.from(b64, "base64"));
+}
```

`renderNonText` stays as the fallback for non-text, non-image blocks (audio/resource), so
nothing regresses; image is now the one promoted to a real protobuf content case.

### NEW test: `tests/cursor-mcp-stdio.test.ts` — live child-process stdio round-trip

Spawn a tiny real MCP server (written inline as a temp file run via `bun`/`node`) over actual
stdio (`StdioClientTransport`, NOT InMemory), through `CursorMcpManager` with the default
(real) transport factory. Assert:
- Manager connects to the spawned process and discovers a tool.
- `callTool` returns the real result over the pipe.
- An image-returning tool round-trips to `McpImageContent` with non-empty `data` through the
  `mcpDepsFromManager` + `handleCursorNativeExec` path.
- `dispose()` terminates the child cleanly (no leaked process).

The fixture server uses the SDK's `McpServer` + `StdioServerTransport` and is written to a
temp file; the test spawns it with the current runtime. Keep it small and deterministic; if
the runtime cannot spawn within a short connect timeout the test fails loudly (no silent
skip).

### Also add to `tests/cursor-mcp-manager.test.ts`: image mapping unit test

A fixture tool returning `{ content: [{ type: "image", data: <base64>, mimeType: "image/png" }] }`
→ assert the dispatcher reply has a content item with `content.case === "image"` and
non-empty `data`. (Fast, in-memory; complements the heavier stdio test.)

## Verification plan

1. `bun x tsc --noEmit` → 0 errors.
2. `bun test tests/cursor-mcp-manager.test.ts tests/cursor-mcp-stdio.test.ts` → all pass,
   including a real spawned-process round-trip and the image-fidelity assertions.
3. `bun test tests` → no regressions.
4. Independent review (C2 micro-audit): confirm image bytes are real (not placeholder), stdio
   test spawns a real process (not InMemory), no silent skips, text path unchanged.

## Out of scope

- `listMcpResources` no-deps default (correct as-is — see above).
- Audio/embedded-resource MCP content (rare; still rendered as text placeholder — documented).
- diagnostics empty-success (pre-existing, prior bands).

## Cross-references

- Bridge: `src/adapters/cursor/native-exec-mcp.ts` (toContentItems)
- Image schema: `McpImageContent` (`gen/agent_pb.ts:8449`)
- Manager real transport: `src/adapters/cursor/mcp-manager.ts` (createTransport stdio)
- Flagged by: completion challenge agent 52bc06ae (gaps: image flattening, no live stdio test)
