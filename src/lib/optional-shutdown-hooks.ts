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
 * Hooks are synchronous and best-effort by contract: `drainAndShutdown` runs under an
 * absolute deadline, so a hook that throws must not prevent its siblings — or
 * `server.stop` — from running.
 *
 * See devlog/_fin/260814_lab_core_decoupling/010_lifecycle_shutdown_registry.md
 */

type ShutdownHook = () => void;

const hooks = new Map<string, ShutdownHook>();

/**
 * Register (or replace) the teardown for one optional subsystem.
 *
 * Keyed so repeated activation of the same subsystem cannot accumulate duplicate hooks.
 * Returns a detach function so an owner-scoped lease can release its registration.
 */
export function registerOptionalShutdownHook(key: string, hook: ShutdownHook): () => void {
  hooks.set(key, hook);
  return () => {
    // Only detach our own registration: a later activation may have replaced it.
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

/** Test-only reset so an isolated lifecycle test does not inherit registrations. */
export function resetOptionalShutdownHooksForTests(): void {
  hooks.clear();
}
