# 350.123 — Phase 40 (WP40): honest listMcpResources no-executor default

> **Goal:** `3d57a260-c62`. Work-phase 40. **Class C1** (one-branch honesty fix + test). Compact.
> **Follows:** WP39 (devlog 122).

## Why

Independent completion challenge (agent f3cc9770) flagged the last in-scope honesty gap:

`listMcpResourcesExec` (native-exec-tools.ts:50-52) returns **`success` + `resources: []`**
when no `listMcpResources` dep is wired — whereas `readMcpResourceExec` (63-64) returns a
typed **error** ("No local MCP resource executor is configured") in the same situation.

This asymmetry matters most after `live-transport.prepareMcp()` fails: configured-but-broken
MCP servers get their deps stripped (live-transport.ts:107), so a resource-list request then
silently succeeds with an empty list — masking the misconfiguration. That is the same
"false safety / silent empty success" class the original GPT Pro review called out.

## Fix (diff-level)

`src/adapters/cursor/native-exec-tools.ts` — make the no-deps branch honest and symmetric
with `readMcpResource`:

```ts
-  const result = deps.listMcpResources
-    ? await deps.listMcpResources()
-    : create(ListMcpResourcesExecResultSchema, { result: { case: "success", value: create(ListMcpResourcesSuccessSchema, { resources: [] }) } });
+  const result = deps.listMcpResources
+    ? await deps.listMcpResources()
+    : create(ListMcpResourcesExecResultSchema, {
+        result: { case: "error", value: create(ListMcpResourcesErrorSchema, {
+          error: "No local MCP resource executor is configured inside opencodex.",
+        }) },
+      });
```

When MCP deps ARE wired (the live path with configured servers), `mcpDepsFromManager`
provides `listMcpResources`, which still returns real `success` with the actual (possibly
empty) resource list. Only the genuinely-unconfigured / prep-failed case changes from a
misleading empty-success to an honest error.

## Verification

1. `bun x tsc --noEmit` → 0.
2. New test: no-deps `listMcpResources` now yields `result.case === "error"` (not empty
   success); the wired path still returns `success`.
3. `bun test tests` → no regressions.

## Out of scope (documented, not bugs)

- Audio/embedded-resource MCP content rendered as text placeholder (rare).
- HTTP transport has unit coverage via config; live HTTP server integration test deferred
  (stdio live test added in WP39 proves the child-process path; HTTP is the same SDK client).
- `readResource` uses `contents[0]` only (multi-part resources rare; single-part is the norm).

## Cross-references

- `src/adapters/cursor/native-exec-tools.ts` (listMcpResourcesExec)
- Flagged by: completion challenge agent f3cc9770
