# 010 — Phase 1: break the import cycle at `lifecycle.ts`

Unit: `260814_lab_core_decoupling`. Depends on: nothing. Blocks: phases 2–4.

## Why this is first

`src/server/lifecycle.ts:10` is the edge that closes the cycle documented in
[`000_plan.md`](./000_plan.md). While it stands, any module that transitively reaches
`lifecycle.ts` — including `routing/compatibility/assemble.ts` by way of the quota chain —
drags ~69 `src/lab/` files into the graph no matter what phases 2 and 3 do to their own
imports. Removing this one import is the highest-leverage edit in the unit.

A dynamic `await import()` here would compile (the function is already async) but is the
wrong instrument: it would still load Lab during the shutdown of a process that never
activated Lab, and it would do so inside a deadline-bounded drain
(`drainAndShutdown` computes `deadline` at line 414 and reaches Lab cleanup at 455).
Loading a 69-file graph at that point is exactly when it is least affordable.

## Design

A core-owned shutdown-hook registry. Core never names Lab; Lab registers itself when it
activates. This mirrors `src/lib/server-resource-ownership.ts`, which Lab already uses at
`lab/automation/orchestrator.ts:106`.

## NEW: `src/lib/optional-shutdown-hooks.ts`

```ts
/**
 * Core-owned registry for optional-subsystem shutdown work.
 *
 * The proxy core must not import optional subsystems (Compatibility Lab and anything
 * added later) merely to be able to stop them. A subsystem registers its teardown when
 * it activates; a process that never activates it registers nothing, and shutdown does
 * no work and loads no module.
 *
 * Hooks are synchronous and best-effort by contract: shutdown runs under an absolute
 * deadline, so a hook that throws must not prevent its siblings or `server.stop` from
 * running.
 */

type ShutdownHook = () => void;

const hooks = new Map<string, ShutdownHook>();

/**
 * Register (or replace) the teardown for one optional subsystem.
 * Keyed so repeated activation of the same subsystem cannot accumulate duplicates.
 * Returns a detach function for owner-scoped release.
 */
export function registerOptionalShutdownHook(key: string, hook: ShutdownHook): () => void {
  hooks.set(key, hook);
  return () => {
    if (hooks.get(key) === hook) hooks.delete(key);
  };
}

/** Run every registered teardown. Never throws. */
export function runOptionalShutdownHooks(): void {
  for (const [key, hook] of [...hooks]) {
    try {
      hook();
    } catch (err) {
      console.warn(
        `[shutdown] optional subsystem "${key}" teardown failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
}

/** Test-only reset so isolated lifecycle tests do not inherit registrations. */
export function resetOptionalShutdownHooksForTests(): void {
  hooks.clear();
}
```

## MODIFY: `src/server/lifecycle.ts`

Line 10 — remove the Lab import, add the registry import:

```diff
-import { stopLabAutomationScheduler, requestLabAutomationShutdown } from "../lab/automation/orchestrator";
+import { runOptionalShutdownHooks } from "../lib/optional-shutdown-hooks";
```

Lines 454-456 inside `drainAndShutdown` — replace the two direct calls:

```diff
     stopStorageCleanupScheduler();
-    requestLabAutomationShutdown();
-    stopLabAutomationScheduler();
+    // Optional subsystems (Compatibility Lab, and anything added later) tear themselves
+    // down through hooks they registered at activation. A process that never activated
+    // one runs nothing here and never loads its module graph.
+    runOptionalShutdownHooks();
     stopStateStoreSweeper();
```

## MODIFY: `src/lab/automation/orchestrator.ts`

`setLabAutomationDispatchDeps` (line 79) already owns activation-scoped lifetime and
already registers a server-resource cleanup at line 106. Register the shutdown hook in the
same place, so activation and teardown registration cannot drift apart.

Add to imports:

```diff
 import { registerCurrentServerResourceCleanup } from "../../lib/server-resource-ownership";
+import { registerOptionalShutdownHook } from "../../lib/optional-shutdown-hooks";
```

Inside `setLabAutomationDispatchDeps`, extend the existing lease wiring:

```diff
   let released = false;
   let detachServerCleanup = () => {};
+  let detachShutdownHook = () => {};
   const release = () => {
     if (released) return;
     released = true;
     detachServerCleanup();
+    detachShutdownHook();
     const current = dispatchDepsByConfigDir.get(key);
     if (current?.token !== token) return;
     dispatchDepsByConfigDir.delete(key);
     const scheduler = schedulerTimers.get(key);
     if (scheduler?.ownerToken === token) {
       clearInterval(scheduler.timer);
       schedulerTimers.delete(key);
     }
   };
   detachServerCleanup = registerCurrentServerResourceCleanup(release);
+  // Shutdown teardown is registered here, at activation, so lifecycle.ts never has to
+  // import Lab to be able to stop it.
+  detachShutdownHook = registerOptionalShutdownHook(`lab-automation:${key}`, () => {
+    requestLabAutomationShutdown();
+    stopLabAutomationScheduler(deps.configDir);
+  });
   return release;
 }
```

Both functions are already defined in this module, so no new import is needed for them.

## Behavioral equivalence

| Before | After |
|---|---|
| `requestLabAutomationShutdown()` on every shutdown | runs only if Lab automation was activated |
| `stopLabAutomationScheduler()` process-wide (no arg) | scoped to the activated `configDir` |
| Lab loaded on every shutdown | Lab loaded only if already activated |

The scoping change is a deliberate correction, not a regression: the previous call passed
no `configDir` and therefore keyed on the default, while `setLabAutomationDispatchDeps`
is explicitly per-`configDir`. Multi-config test processes were the case where these
disagreed.

## Tests

NEW `tests/optional-shutdown-hooks.test.ts`:

1. `runOptionalShutdownHooks()` with nothing registered is a no-op and does not throw.
2. A registered hook runs exactly once per invocation.
3. Re-registering the same key replaces rather than accumulates.
4. A throwing hook does not prevent a sibling hook from running.
5. The detach function removes the hook; a stale detach after replacement is inert.

MODIFY existing lab automation lifecycle tests: assert the scheduler is stopped after
`drainAndShutdown` when automation was activated — the outcome, not the direct call.

## Accept criteria

- `rg -n "lab/" src/server/lifecycle.ts` returns nothing.
- Activated automation is still stopped by `drainAndShutdown`.
- Shutdown for a never-activated process performs no Lab work.
- `bun x tsc --noEmit` exits 0.
