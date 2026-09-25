import { registerCodexQuotaAutoRefreshWorker } from "../../codex/quota-auto-refresh";
import { registerDesktopAuthlessAutoWorker } from "../../codex/desktop-authless-auto";
import type { OcxConfig } from "../../types";
import type { StartServerDeps } from "./startup-warnings";

/**
 * Register the Codex minute-sweep workers behind one cleanup.
 *
 * The sweep workers grow as a pair (quota-window activation, desktop-authless failover) while
 * `src/server/index.ts` sits exactly at its file-size cap, so the combined registration lives
 * here: the composition root keeps one call site and one cleanup instead of one per worker.
 */
export function registerCodexSweepWorkers(
  config: OcxConfig,
  deps: Pick<StartServerDeps, "registerCodexQuotaAutoRefreshWorker" | "registerDesktopAuthlessAutoWorker">,
): () => void {
  const cleanups = [
    (deps.registerCodexQuotaAutoRefreshWorker ?? registerCodexQuotaAutoRefreshWorker)(config),
    (deps.registerDesktopAuthlessAutoWorker ?? registerDesktopAuthlessAutoWorker)(config),
  ];
  return () => {
    for (const cleanup of cleanups) cleanup();
  };
}
