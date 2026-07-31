# 350.121 — Phase 38 (WP38): computer-use / record-screen — honest external-executor hooks

> **Goal:** `3d57a260-c62`. Work-phase 38. **Class C3** (no new dependency, no fake automation; spawns an opt-in external executor). Full PABCD.
> **Depends on:** design devlog 119; MCP work-phase devlog 120.

## Part 1 — Easy explanation

opencodex is a **headless proxy** — it has no screen, mouse, or recording surface. So it
**cannot truthfully** "control the computer" or "record the screen" by itself. The wrong
move would be to fake a success; that is a lie to the model and exactly the kind of "false
safety claim" the GPT-Pro review flagged.

The honest move (this work-phase):

1. **By default:** when Cursor asks for computer-use or record-screen, opencodex returns a
   precise, truthful result: *"not supported in this headless proxy"*. (This already happens
   today — this WP makes the message explicit and keeps it honest.)
2. **Opt-in bridge:** if you run opencodex somewhere that DOES have a screen and you provide
   an external executor command in config, opencodex spawns it, hands it the action request
   as JSON on stdin, and reads the JSON result from stdout — turning a real screenshot/click
   into a real protobuf result. No executor configured → honest "not supported".

This mirrors jawcode (which empty-acks these) but is strictly more honest and gives a real,
documented extension path instead of silence.

## Part 2 — Diff-level plan

### NEW file: `src/adapters/cursor/native-exec-desktop.ts` (<150 lines)

A spawn-based bridge that turns an external executor command into the `computerUse` /
`recordScreen` methods of `CursorNativeToolDeps`. Pattern mirrors `native-exec-network.ts`
(deps with a real-or-injected impl) and the existing shell-spawn helpers.

```ts
import { spawn } from "node:child_process";
import { create } from "@bufbuild/protobuf";
import {
  ComputerUseErrorSchema, ComputerUseResultSchema, ComputerUseSuccessSchema,
  RecordScreenFailureSchema, RecordScreenResultSchema,
  RecordScreenStartSuccessSchema, RecordScreenSaveSuccessSchema, RecordScreenDiscardSuccessSchema,
  type ComputerUseArgs, type ComputerUseResult,
  type RecordScreenArgs, type RecordScreenResult,
} from "./gen/agent_pb";
import { errorText } from "./native-exec-common";
import type { CursorNativeToolDeps } from "./native-exec-tools";

export interface DesktopExecutorConfig {
  computerUseCommand?: string;   // e.g. "ocx-desktop-bridge computer-use"
  recordScreenCommand?: string;
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;            // default 30s
}

/** Build computerUse/recordScreen deps from external executor commands. Returns {} when none. */
export function desktopDepsFromConfig(config?: DesktopExecutorConfig): CursorNativeToolDeps {
  if (!config?.computerUseCommand && !config?.recordScreenCommand) return {};
  const deps: CursorNativeToolDeps = {};
  if (config.computerUseCommand) {
    deps.computerUse = async (args: ComputerUseArgs) => runComputerUse(config, args);
  }
  if (config.recordScreenCommand) {
    deps.recordScreen = async (args: RecordScreenArgs) => runRecordScreen(config, args);
  }
  return deps;
}

// runComputerUse: spawn command, write JSON {toolCallId, actions} to stdin, parse stdout JSON
//   { screenshot?: base64, durationMs? } → ComputerUseSuccess (actionCount ALWAYS set from
//   args.actions.length — required field), or { error } → ComputerUseError (with
//   actionCount: args.actions.length, durationMs: 0). Any spawn/parse/timeout failure →
//   ComputerUseError (never throws).
// runRecordScreen: spawn command, write JSON {mode, toolCallId, saveAsFilename?} → parse
//   { startSuccess|saveSuccess|discardSuccess|failure } → matching oneof. Never throws.
```

`runExternalJson(command, payload, config)` is a private helper: `spawn(sh, ["-c", command])`,
write `JSON.stringify(payload)` to stdin, collect stdout, enforce `timeoutMs`, parse JSON.
All errors are caught and converted to the typed error/failure result by the callers.

### MODIFY: `src/adapters/cursor/native-exec-tools.ts` — clearer honest defaults + recordScreen try/catch

(a) Reword the computer-use default to be explicit about the headless limitation and the
config field name (`desktopExecutor.computerUseCommand`):

```ts
-      : create(ComputerUseResultSchema, {
-        result: { case: "error", value: create(ComputerUseErrorSchema, { error: "No local computer-use executor is configured inside opencodex.", actionCount: args.actions.length, durationMs: 0 }) },
-      });
+      : create(ComputerUseResultSchema, {
+        result: { case: "error", value: create(ComputerUseErrorSchema, { error: "computer-use is not supported in this headless opencodex proxy. Configure provider.desktopExecutor.computerUseCommand to enable it.", actionCount: args.actions.length, durationMs: 0 }) },
+      });
```

(b) Reword the record-screen default identically:

```ts
-  const result = deps.recordScreen
-    ? await deps.recordScreen(args)
-    : create(RecordScreenResultSchema, {
-      result: { case: "failure", value: create(RecordScreenFailureSchema, { error: "No local record-screen executor is configured inside opencodex." }) },
-    });
-  return execBytes(execMsg, "recordScreenResult", result);
+  try {
+    const result = deps.recordScreen
+      ? await deps.recordScreen(args)
+      : create(RecordScreenResultSchema, {
+        result: { case: "failure", value: create(RecordScreenFailureSchema, { error: "record-screen is not supported in this headless opencodex proxy. Configure provider.desktopExecutor.recordScreenCommand to enable it." }) },
+      });
+    return execBytes(execMsg, "recordScreenResult", result);
+  } catch (err) {
+    return execBytes(execMsg, "recordScreenResult", create(RecordScreenResultSchema, {
+      result: { case: "failure", value: create(RecordScreenFailureSchema, { error: errorText(err) }) },
+    }));
+  }
```

> **AUDIT FIX (blocking #2):** `recordScreenExec` currently has NO try/catch
> (`native-exec-tools.ts:90-98`), so a throwing executor fails the whole stream via
> `handleServerMessage.catch`. Adding this try/catch mirrors `computerUseExec` (which is
> already wrapped at :76-87) and guarantees the "never throws into the stream" contract at
> the dispatcher boundary — independent of the desktop module's own internal guards.
> `errorText` is already imported in this file (used by `mcpExec`).

(c) No behavior change for `listMcpResources`/`readMcpResource` (owned by WP37).

### MODIFY: `src/types.ts` — add `desktopExecutor` to `OcxProviderConfig`

```ts
+  /**
+   * Cursor adapter only: opt-in external executor for computer-use / record-screen. opencodex is
+   * headless and cannot control a screen itself; provide commands here only when running on a host
+   * that can. With no executor, these tools honestly report "not supported".
+   */
+  desktopExecutor?: import("./adapters/cursor/native-exec-desktop").DesktopExecutorConfig;
```

### MODIFY: `src/adapters/cursor/live-transport.ts` — merge desktop deps into execContext

In `prepareMcp()` (rename concept → it already builds execContext), merge the desktop deps so
both MCP and desktop executors are present:

```ts
-          this.execContext = { ...mcpDepsFromManager(this.mcpManager!), mcpToolDefs };
+          this.execContext = { ...desktopDepsFromConfig(this.input.provider.desktopExecutor), ...mcpDepsFromManager(this.mcpManager!), mcpToolDefs };
```

And handle the **no-MCP-but-yes-desktop** case: today `execContext` stays `{}` when
`mcpManager` is undefined. Fix: compute desktop deps unconditionally in the constructor and
store them so both the seed and the MCP catch path can preserve them:

```ts
  private readonly desktopDeps: CursorNativeToolDeps;
  constructor(...) {
    ...
    this.desktopDeps = desktopDepsFromConfig(input.provider.desktopExecutor);
    this.execContext = { ...this.desktopDeps };   // desktop available even with no MCP
    if (servers.length > 0) this.mcpManager = new CursorMcpManager(servers, {...});
  }
```

`prepareMcp()` layers MCP onto the desktop deps on success, and **on failure restores the
desktop deps instead of wiping to `{}`**:

```ts
-          this.execContext = { ...mcpDepsFromManager(this.mcpManager!), mcpToolDefs };
+          this.execContext = { ...this.desktopDeps, ...mcpDepsFromManager(this.mcpManager!), mcpToolDefs };
         } catch (err) {
           console.warn(...);
-          this.execContext = {};
+          this.execContext = { ...this.desktopDeps };   // AUDIT FIX (blocking #1): keep desktop deps on MCP failure
         }
```

(If no MCP and no desktop, `execContext = {}`, unchanged behavior.)

> **AUDIT FIX (blocking #1):** without restoring `this.desktopDeps` in the catch, a combined
> MCP+desktop config would silently lose its computer-use/record-screen executors whenever
> MCP preparation failed.

### Tests: `tests/cursor-desktop-exec.test.ts` (NEW)

- `desktopDepsFromConfig(undefined)` → `{}` (no methods).
- With a tiny echo script as `computerUseCommand` (a node `-e` one-liner that reads stdin and
  prints `{"durationMs":5}`), `computerUse` → `ComputerUseSuccess`.
- A script that prints `{"error":"x"}` → `ComputerUseError`.
- A script that exits non-zero / bad JSON → typed error (no throw).
- `recordScreen` with a script printing `{"startSuccess":{}}` → `startSuccess` oneof.
- Default (no executor) via `handleCursorNativeExec(..., {})`: computer-use → `error` with the
  "headless proxy" message; record-screen → `failure`.

## Verification plan

1. `bun x tsc --noEmit` → 0 errors.
2. `bun test tests/cursor-desktop-exec.test.ts` → all pass.
3. `bun test tests` → no regressions (incl. existing
   "returns typed defaults for MCP resource and record screen" test still green).
4. Focused independent review (C3): confirm no fabricated success, defaults honest, deps never
   throw into the stream, no-config path unchanged, desktop deps available without MCP.

## Audit resolution (devlog 121, agent 3f3bc726)

Plan A-phase audit returned FAIL → both blocking issues fixed in this revision:
1. **prepareMcp catch wiped desktop deps** — success and catch paths now both preserve
   `this.desktopDeps` (`{ ...this.desktopDeps, ...mcp }` / `{ ...this.desktopDeps }`).
2. **recordScreenExec had no try/catch** — added one mirroring `computerUseExec`, so a
   throwing record-screen executor returns a typed `RecordScreenFailure` instead of failing
   the stream.
Corrections applied: `actionCount` always set from `args.actions.length`; explicit
record-screen default-message diff added; `errorText` import noted (already present).
Non-blocking confirmed: existing regression test checks `.result.case` only (reword safe);
`ComputerUseError.durationMs` is required (set to 0 in errors); config inline-import matches
WP37 with no cycle.

## Out of scope

- Real OS-level screen/mouse/keyboard automation inside the proxy (the whole point: opencodex
  stays headless; a real executor is the host's responsibility).
- Shipping a reference desktop-bridge binary (documented extension point only).
- MCP work (WP37 / devlog 120).

## Cross-references

- Honest-error principle: devlog 117 (phase 34, false-safety class)
- Deps interface: `src/adapters/cursor/native-exec-tools.ts:26`
- Spawn pattern reference: `src/adapters/cursor/native-exec-shell.ts`, `native-exec-network.ts`
- Inject site / execContext: `src/adapters/cursor/live-transport.ts` (WP37)
- Result schemas: ComputerUseResult (`gen/agent_pb.ts:4945`), RecordScreenResult (`:9586`)
