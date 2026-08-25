# 050 — wp6: #2477, namespace alias authorization (security boundary)

Phase: wp6. Depends on: wp1. PR: #2477, head `71afa5f14`, author `luvs01`.
**This phase changes a request authorization boundary and requires explicit
security review per `MAINTAINERS.md`.**

## What the PR gets right

On `dev`, `rewriteRoutedNamespaceToolsForUpstream` returns `plan.aliases`
unconditionally (`src/responses/namespace-tool-compat.ts:287-295`). Every
namespace child's wire name stays restorable regardless of what the caller's
`tool_choice` actually permitted. The PR adds `authorizedAliases()` and filters
the returned map, which is the right shape and the right insertion point —
after `rewriteToolChoice` has already converted namespace selectors to wire
names, so the comparison is apples to apples.

## The blocker (confirmed independently by the main agent)

The `allowed_tools` branch matches on **name only**:

```ts
toolChoice.tools
  .filter(tool => isPlainObject(tool) && typeof tool.name === "string")
  .map(tool => tool.name as string)
```

So this input still retains the alias:

```ts
{ type: "file_search", name: "collaboration__safe" }
```

A selector for a *different kind of tool* authorizes a client namespace function
call. The restoration path then rewrites an upstream `function_call` carrying
that wire name into `{namespace, name}`
(`src/responses/namespace-tool-compat.ts:354-362`), and it reaches both
transports (`src/server/responses/core.ts:3682` SSE, `:3911` JSON).

The undeclared-tool guard does not save this: it authorizes from the declared
catalog, not from `tool_choice`
(`src/server/responses-undeclared-tool-guard.ts:202-208`).

The PR body promises foreign kinds get an empty map; the `allowed_tools` branch
breaks that promise. CodeRabbit flagged it and the thread is unresolved.

## The fix

`src/responses/namespace-tool-compat.ts`, in `authorizedAliases` — MODIFY:

```diff
     authorizedNames = new Set(
       toolChoice.tools
-        .filter(tool => isPlainObject(tool) && typeof tool.name === "string")
+        .filter(tool =>
+          isPlainObject(tool)
+          && (tool.type === "function" || tool.type === "custom")
+          && typeof tool.name === "string",
+        )
         .map(tool => tool.name as string),
     );
```

A whitelist, not a blacklist. The schema types `allowed_tools` entries as
`{type: z.string(), name: z.string().optional()}`
(`src/responses/schema.ts:120`) — the type is unbounded, so enumerating what to
*reject* can never be complete. Kinds present in the runtime today include
`web_search`, `web_search_preview`, `file_search`, `computer_use`,
`computer_use_preview`, `code_interpreter`, `image_generation`, `image_gen`,
`mcp`, `tool_search`, `local_shell`, `x_search`; a whitelist closes future
ones too.

## Required test additions

`tests/namespace-tool-compat.test.ts` — MODIFY. The PR's existing test uses only
`{type:"function"}`, so it cannot fail when the type check is missing — it is
not a regression test for this blocker.

1. `rejects non-function/custom allowed_tools entries` — table over every kind
   listed above plus an unknown future kind, each carrying the exact namespace
   wire name. Assert `aliases.size === 0` and that restoring an upstream
   `function_call` with that name returns `changed === false` and no
   `namespace`.
2. `retains aliases for function and custom entries` — proves the whitelist is
   not deny-all.
3. `applies default and foreign top-level policies` — absent / `auto` /
   `required` retain; `none` and a top-level `{type:"file_search"}` return empty;
   a forced `function` selector **retains the selected alias** (the PR only
   asserts it excludes the other one).

Test 1 must be driven red before the fix and green after — a security regression
that was never observed failing is not a regression test.

## Accept criteria

| # | Criterion | Proof |
|---|-----------|-------|
| 1 | Foreign tool-type selector authorizes no alias | `bun test tests/namespace-tool-compat.test.ts` |
| 2 | Same selector cannot restore an upstream `function_call` | same |
| 3 | `function` and `custom` still authorize | same |
| 4 | Test 1 observed failing before the fix | captured output in the D record |
| 5 | Independent adversarial security review recorded | reviewer verdict in this unit |
| 6 | CodeRabbit thread resolved; exact-head CI green | `gh` thread state + checks |
| 7 | Merged | merge SHA + ancestry |

## Scope boundary

IN: `authorizedAliases` and its tests.
OUT: the undeclared-tool guard, the restoration path itself, declaration
filtering, and #2458's guard-adjacent fix (deferred in 000 precisely to keep two
changes off one guard in one hotfix).

