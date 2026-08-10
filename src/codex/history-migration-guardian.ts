import { migrateHistoryToOpenai } from "./history-provider";
import { resolveCodexHistoryJobTarget, runCodexHistoryJob } from "./history-job";

/**
 * Daemon-side retry for the one-time Design-B history migration.
 *
 * Most upgrades run `ocx start` while the Codex app still holds `state_5.sqlite`,
 * so the inject-time migration often fails on the FIRST start — exactly the moment
 * every legacy thread is still tagged `opencodex` and invisible to the app. Instead
 * of asking the user to close the app and rerun start, this guardian keeps retrying
 * in the background until the migration lands.
 *
 * Design constraints (audit-driven):
 * - Ticks use `{ attempts: 1 }`: no sleepSync inside the daemon event loop; the tick
 *   cadence IS the retry. Worst case per tick is one sqlite busy wait.
 * - Timers are unref'd so the guardian never keeps the process alive.
 * - Started ONLY from `ocx start` (cli handleStart), never from injectCodexConfig —
 *   `/api/sync` re-runs inject and must not double-start loops.
 */

export interface HistoryMigrationGuardianHandle {
  stop(): void;
}

export interface HistoryMigrationGuardianDeps {
  migrateFn?: () => ReturnType<typeof migrateHistoryToOpenai>
    | Promise<ReturnType<typeof migrateHistoryToOpenai>>;
  log?: Pick<Console, "log">;
  tickMs?: number;
  maxTicks?: number;
  /** Test hook: schedule fn after ms; return a cancel handle. Defaults to setTimeout. */
  scheduleFn?: (fn: () => void, ms: number) => { cancel(): void };
}

const DEFAULT_TICK_MS = 60_000;
const DEFAULT_MAX_TICKS = 60; // give up after ~an hour; doctor still surfaces the pending state

function defaultSchedule(fn: () => void, ms: number): { cancel(): void } {
  const timer = setTimeout(fn, ms);
  if (typeof timer.unref === "function") timer.unref();
  return { cancel: () => clearTimeout(timer) };
}

export function startHistoryMigrationGuardian(deps: HistoryMigrationGuardianDeps = {}): HistoryMigrationGuardianHandle {
  // The default migration goes through the history job, so the guardian's timer
  // thread never performs the transition itself. A background repair that races
  // an apply or a restore is exactly what H exists to order.
  const migrateFn = deps.migrateFn ?? (async () => {
    const outcome = await runCodexHistoryJob({
      ...resolveCodexHistoryJobTarget(),
      operation: "migrate-openai",
    });
    return outcome.kind === "converged"
      ? { rows: outcome.rows, files: outcome.files, verifiedNoop: outcome.proof?.kind === "verified-noop" }
      : { rows: 0, files: 0, failed: true as const };
  });
  const log = deps.log ?? console;
  const tickMs = deps.tickMs ?? DEFAULT_TICK_MS;
  const maxTicks = deps.maxTicks ?? DEFAULT_MAX_TICKS;

  let stopped = false;
  let pending: { cancel(): void } | undefined;
  let ticks = 0;

  const schedule = () => {
    if (stopped) return;
    pending = (deps.scheduleFn ?? defaultSchedule)(tick, tickMs);
  };

  const tick = async () => {
    if (stopped) return;
    ticks++;
    try {
      // The worker re-derives state under H on every pass; no pre-lock probe is
      // allowed to stop or suppress this attempt.
      const result = await migrateFn();
      if (!result.failed) {
        const moved = result.rows + ((result as { ejectedRows?: number }).ejectedRows ?? 0);
        if (moved > 0) {
          log.log(`🩹 history-migration: ${moved} legacy opencodex thread(s) migrated back to openai.`);
        }
        // Zero mutations are authoritative only when the worker verified the
        // exact DB/manifest state while H was held.
        const verifiedNoop = (result as { verifiedNoop?: boolean }).verifiedNoop === true;
        if (moved > 0 || verifiedNoop) {
          stopped = true;
          return;
        }
      }
    } catch {
      /* hard errors are not retryable state — fall through to the tick budget */
    }
    if (ticks >= maxTicks) {
      stopped = true;
      log.log("⚠️ history-migration: Could not verify that legacy threads were migrated; the history database may be busy, unavailable, or not yet ready. Run 'ocx sync' (or check 'ocx doctor').");
      return;
    }
    schedule();
  };

  schedule();
  return {
    stop() {
      stopped = true;
      pending?.cancel();
    },
  };
}
