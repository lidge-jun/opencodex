import { expect } from "bun:test";

/**
 * Service-recovery scenarios answer every host probe themselves (#7417). On macOS the default
 * listener scan is `lsof -iTCP`, which walks every process's descriptors: ~50ms on an idle
 * host, seconds once concurrent suites fill the process table. A service-to-direct fallback
 * scans twice, and that alone pushed these cases past Bun's 5s budget. The service-manager
 * step is answered explicitly too, instead of relying on the armed test guard refusing the
 * real launchctl/systemctl call.
 */
export const HOST_FREE_RECOVERY_IO = {
  listListenPidsFn: (): number[] => [],
  restartServiceManagerFn: async () => "failed" as const,
};

/**
 * Runs a scenario with host process launches refused, and fails it if it attempted any. The
 * launch is refused rather than observed, so a regressed path neither waits on the command nor
 * touches the host; the record still fails the case if production code swallows the refusal.
 *
 * One attempt is expected on a real Windows host and only there: the recovery path's
 * best-effort scheduler-wrapper cleanup (`killWindowsSchedulerWrappers`) launches PowerShell,
 * scoped to this test home's own wrapper paths, and swallows any failure. It is refused like
 * everything else, so it does no host work, but it is not counted against the scenario.
 */
export async function withoutHostProcesses<T>(run: () => Promise<T>): Promise<T> {
  const bun = Bun as unknown as { spawnSync: (...args: unknown[]) => unknown };
  const original = bun.spawnSync;
  const spawned: string[] = [];
  bun.spawnSync = (...args: unknown[]) => {
    const first = args[0] as string[] | { cmd?: string[] } | undefined;
    const command = String(Array.isArray(first) ? first[0] : first?.cmd?.[0]);
    spawned.push(command);
    throw new Error(`unexpected host process launch: ${command}`);
  };
  let outcome: { ok: true; value: T } | { ok: false; error: unknown };
  try {
    outcome = { ok: true, value: await run() };
  } catch (error) {
    outcome = { ok: false, error };
  } finally {
    bun.spawnSync = original;
  }
  expect(spawned.filter(command => !isWindowsWrapperCleanup(command))).toEqual([]);
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}

function isWindowsWrapperCleanup(command: string): boolean {
  return process.platform === "win32" && /[\\/]powershell\.exe$/i.test(command);
}
