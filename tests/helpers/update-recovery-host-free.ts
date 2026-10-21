import { expect } from "bun:test";
import { tmpdir } from "node:os";
import { win32 } from "node:path";

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
 *
 * The Windows ACL belt is the other exception. Every private config write on Windows tightens
 * its ACL with `%SystemRoot%\\System32\\icacls.exe` (src/config/atomic-write.ts,
 * src/config/paths.ts), and these scenarios write config inside the test home. Before this
 * helper existed, those calls ran for real on Windows CI. Exactly that executable, called in one
 * of the ACL belt's own argv shapes (one target, then nothing or /grant:r, /inheritance:r,
 * /remove:g or /findsid with principal/SID/ACE tokens only), with the target canonicalized and
 * inside the test's OPENCODEX_HOME or the temp directory, is passed through to the real spawn.
 * It is recorded in a separate `allowed` list (readable through `observed`) rather than the
 * refused list, so a caller can assert on it. Everything else is still refused.
 */
export async function withoutHostProcesses<T>(
  run: () => Promise<T>,
  observed?: { allowed: string[] },
): Promise<T> {
  const bun = Bun as unknown as { spawnSync: (...args: unknown[]) => unknown };
  const original = bun.spawnSync;
  const spawned: string[] = [];
  const allowed: string[] = observed?.allowed ?? [];
  bun.spawnSync = (...args: unknown[]) => {
    const first = args[0] as string[] | { cmd?: string[] } | undefined;
    const command = String(Array.isArray(first) ? first[0] : first?.cmd?.[0]);
    if (isTestScopedWindowsAcl(command, Array.isArray(first) ? first : first?.cmd ?? [])) {
      allowed.push(command);
      return (original as (...a: unknown[]) => unknown).apply(bun, args);
    }
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
  expect(allowed.every(command => process.platform === "win32" && isWindowsIcaclsBinary(command))).toBe(true);
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}

function isWindowsWrapperCleanup(command: string): boolean {
  return process.platform === "win32" && /[\\/]powershell\.exe$/i.test(command);
}

/** Exported for the helper's own test; see the Windows ACL note on {@link withoutHostProcesses}. */
export function isTestScopedWindowsAcl(
  command: string,
  argv: readonly unknown[],
  platform: string = process.platform,
  roots: readonly string[] = testScopedRoots(),
  systemRoot: string = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows",
): boolean {
  if (platform !== "win32" || !isWindowsIcaclsBinary(command, systemRoot)) return false;
  // Exactly the argv shapes src/lib/windows-secret-acl.ts builds: one target path, then nothing,
  // or one of its four switches followed only by principal/SID/ACE tokens. Any other switch
  // (/save, /restore, /setowner, ...) or any further path or file operand is refused.
  const [, target, step, ...rest] = argv.map(String);
  if (target === undefined || !/^(?:[a-zA-Z]:[\\/]|\\\\)/.test(target)) return false;
  if (step !== undefined && !ACL_BELT_STEPS.has(step)) return false;
  if (step === undefined && rest.length > 0) return false;
  if (!rest.every(token => ACE_TOKEN.test(token))) return false;
  // win32.resolve collapses "." and ".." segments, so a traversal cannot pass the prefix check.
  const canonical = normalizeWindowsPath(win32.resolve(target));
  return roots.filter(Boolean)
    .map(root => normalizeWindowsPath(win32.resolve(root)))
    .some(root => canonical === root || canonical.startsWith(`${root}/`));
}

/** The four switches the production ACL belt passes to icacls (src/lib/windows-secret-acl.ts). */
const ACL_BELT_STEPS = new Set(["/grant:r", "/inheritance:r", "/remove:g", "/findsid"]);
/** A principal or SID, optionally with rights: "user:(OI)(CI)(F)", "*S-1-1-0", "*S-1-5-32-545:(R)". */
const ACE_TOKEN = /^\*?[^\\/:\s][^\\/:]*(?::(?:\([A-Z]+\))+)?$/;

/** True only for the exact `%SystemRoot%\\System32\\icacls.exe`, compared case-insensitively. */
export function isWindowsIcaclsBinary(
  command: string,
  systemRoot: string = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows",
): boolean {
  return normalizeWindowsPath(command) === normalizeWindowsPath(win32.join(systemRoot, "System32", "icacls.exe"));
}

function normalizeWindowsPath(value: string): string {
  return value.replace(/[\\/]+/g, "/").replace(/\/$/, "").toLowerCase();
}

function testScopedRoots(): string[] {
  return [process.env.OPENCODEX_HOME ?? "", tmpdir()];
}
