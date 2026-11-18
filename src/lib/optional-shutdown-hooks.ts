/**
 * Core-owned registry for optional-subsystem shutdown work.
 *
 * The proxy core must not import an optional subsystem merely to be able to stop it.
 * Compatibility Lab is the first case: `server/lifecycle.ts` imported
 * `lab/automation/orchestrator` for two teardown calls, and that single edge closed an
 * import cycle (`routing/compatibility/assemble` → `routing/quota` → `providers/quota` →
 * `codex/auth-api` → `codex/native-main-admission` → `server/lifecycle` → Lab) that pulled
 * ~69 `src/lab/` modules into the graph of every install, including installs with no
 * routing profile at all.
 *
 * A subsystem registers its teardown when it activates. A process that never activates it
 * registers nothing, so shutdown does no work and loads no module.
 *
 * Synchronous hooks are best-effort. Subsystems that own processes can register an
 * asynchronous cleanup receipt with its own bounded wait after the active-turn drain.
 *
 * See devlog/_fin/260814_lab_core_decoupling/010_lifecycle_shutdown_registry.md
 */

import { OPTIONAL_SHUTDOWN_GRACE_MS } from "./shutdown-budget";

type ShutdownHook = () => void;
type AsyncShutdownHook = { run: (deadlineMs: number) => Promise<void>; onIncomplete?: ShutdownHook };

const hooks = new Map<string, ShutdownHook>();
const asyncHooks = new Map<string, AsyncShutdownHook>();
let hooksRan = false;

/**
 * Register (or replace) the teardown for one optional subsystem.
 *
 * Keyed so repeated activation of the same subsystem cannot accumulate duplicate hooks.
 * Returns a detach function so an owner-scoped lease can release its registration.
 *
 * Registration after a sweep is NOT retro-applied: the hook waits for the next
 * `runOptionalShutdownHooks`, which a draining process never reaches. Callers whose work
 * must not outlive the sweep should gate on `didRunOptionalShutdownHooks`.
 *
 * The `hooksRan` latch is process-lifetime: every production caller runs the sweep inside
 * `drainAndShutdown`, whose callers then exit or hand off to a newly spawned process —
 * there is no in-process restart after a sweep. `resetOptionalShutdownHooksForTests`
 * models that fresh process; it is the only way a post-sweep subsystem may start again.
 */
export function registerOptionalShutdownHook(key: string, hook: ShutdownHook): () => void {
  hooks.set(key, hook);
  return () => {
    // Only detach our own registration: a later activation may have replaced it.
    if (hooks.get(key) === hook) hooks.delete(key);
  };
}

/** The async hook shares the absolute stop deadline. Its fallback must finish synchronously. */
export function registerAsyncOptionalShutdownHook(
  key: string,
  run: AsyncShutdownHook["run"],
  onIncomplete?: ShutdownHook,
): void {
  asyncHooks.set(key, { run, onIncomplete });
}

/** Whether `runOptionalShutdownHooks` has run at least once since the last test reset. */
export function didRunOptionalShutdownHooks(): boolean {
  return hooksRan;
}

/** Run every teardown, reporting whether the asynchronous work completed successfully. */
export async function runOptionalShutdownHooks(
  { deadlineMs = Date.now() + OPTIONAL_SHUTDOWN_GRACE_MS }: { deadlineMs?: number } = {},
): Promise<boolean> {
  hooksRan = true;
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
  if (asyncHooks.size === 0) return true;
  const incomplete = new Map(asyncHooks);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadline = new Promise<null>(resolve => {
      const remainingMs = deadlineMs - Date.now();
      if (remainingMs <= 0) resolve(null);
      else timer = setTimeout(() => resolve(null), remainingMs);
    });
    const cleanup = Promise.all([...incomplete].map(async ([key, hook]) => {
      try {
        await hook.run(deadlineMs);
        incomplete.delete(key);
        return true;
      } catch {
        console.warn(`[shutdown] optional subsystem "${key}" teardown failed`);
        return false;
      }
    }));
    const results = await Promise.race([deadline, cleanup]);
    if (results === null || Date.now() >= deadlineMs) {
      console.warn("[shutdown] optional subsystem teardown timed out");
      return false;
    }
    return results.every(Boolean);
  } finally {
    clearTimeout(timer);
    for (const [key, hook] of incomplete) {
      try {
        hook.onIncomplete?.();
      } catch {
        console.warn(`[shutdown] optional subsystem "${key}" emergency teardown failed`);
      }
    }
  }
}

/** Test-only reset so an isolated lifecycle test does not inherit registrations. */
export function resetOptionalShutdownHooksForTests(): void {
  hooks.clear();
  asyncHooks.clear();
  drainStartHooks.clear();
  drainStartHooksRan = false;
  hooksRan = false;
}

const drainStartHooks = new Map<string, ShutdownHook>();
let drainStartHooksRan = false;

/**
 * Register work that must run the moment a drain begins, before in-flight turns are awaited.
 * The service health sentinel (#6671) uses it: a deliberate stop whose drain stalls must stay a
 * stop, so the sentinel is withdrawn before the drain can look unresponsive. Same contract as
 * {@link registerOptionalShutdownHook}: keyed, synchronous, best-effort, detachable.
 */
export function registerDrainStartHook(key: string, hook: ShutdownHook): () => void {
  drainStartHooks.set(key, hook);
  return () => {
    if (drainStartHooks.get(key) === hook) drainStartHooks.delete(key);
  };
}

/** Run every drain-start hook. Never throws. */
export function runDrainStartHooks(): void {
  drainStartHooksRan = true;
  for (const [key, hook] of [...drainStartHooks]) {
    try {
      hook();
    } catch (err) {
      console.warn(`[shutdown] drain-start hook "${key}" failed:`, err instanceof Error ? err.message : err);
    }
  }
}

/** Whether a drain has begun in this process; work that must not start mid-drain checks this. */
export function didRunDrainStartHooks(): boolean {
  return drainStartHooksRan;
}
