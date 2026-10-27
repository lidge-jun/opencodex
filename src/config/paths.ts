import { chmodSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { flushWindowsSecretAclReapsBeforeRemoval, hardenSecretDirAsync, windowsSecretAclApplies, withWindowsSecretAclSettled } from "../lib/windows-secret-acl";
import { assertNotRealHomeUnderTest } from "../lib/test-home-guard";
import { isPassiveRead } from "../lib/passive-read";
import { trackBackgroundWork } from "../lib/background-work";

/**
 * Expand a leading `~` in user-supplied paths without interpreting shell
 * variables or `~user` forms that belong to the caller's shell.
 */
export function expandUserPath(raw: string): string {
  if (raw === "~") return homedir();
  if (raw.startsWith("~/") || raw.startsWith("~\\")) return join(homedir(), raw.slice(2));
  return raw;
}
let resolvedConfigDirCache: { raw: string | undefined; path: string } | null = null;
const configDirHardeningFlights = new Map<string, Promise<void>>();

export function getConfigDir(): string {
  const raw = process.env["OPENCODEX_HOME"]?.trim() || undefined;
  if (resolvedConfigDirCache && resolvedConfigDirCache.raw === raw) return resolvedConfigDirCache.path;
  const path = raw ? resolve(expandUserPath(raw)) : join(homedir(), ".opencodex");
  resolvedConfigDirCache = { raw, path };
  return path;
}

export function getConfigPath(): string {
  return join(getConfigDir(), "config.json");
}

export function hardenConfigDir(): void {
  // A passive read (a Remote Link Child's, #6959) repairs nothing on this machine.
  if (isPassiveRead()) return;
  const dir = getConfigDir();
  // The guard runs before any mutation: refusing after chmod/ACL would already
  // have changed the protected directory used by the test-home boundary.
  assertNotRealHomeUnderTest(dir);
  // Follow directory links as before, but never apply directory permissions to a file.
  try { if (!statSync(dir).isDirectory()) return; } catch { return; }
  // Windows privacy is enforced by NTFS ACLs. chmod only changes DOS attributes there;
  // doing it before the ACL lookup can invalidate its ctime-based successful observation.
  if (!windowsSecretAclApplies()) {
    try { chmodSync(dir, 0o700); } catch { /* best-effort */ }
  }
  if (windowsSecretAclApplies() && !configDirHardeningFlights.has(dir)) {
    // This is an optional read-path harden. Waiting synchronously here used to stop the Bun
    // event loop (including /healthz) for the full icacls timeout. Required mutation paths keep
    // their own awaited/fail-closed hardening; ordinary config reads only start one soft flight.
    // Tracked: icacls holds the directory open, and a config write or removal that lands on
    // it before the child exits fails with a sharing violation on Windows.
    const flight = trackBackgroundWork("config-dir-acl-harden", hardenSecretDirAsync(dir, { required: false })
      .then(() => undefined)
      .catch(() => undefined)
      .finally(() => {
        if (configDirHardeningFlights.get(dir) === flight) configDirHardeningFlights.delete(dir);
      }));
    configDirHardeningFlights.set(dir, flight);
  }
}

/**
 * Settle the optional hardening flight for one config directory.
 *
 * The flight spawns `icacls.exe`, which holds the directory open until it exits. Windows file
 * locking is mandatory, so anything that removes or renames that directory after a "clean"
 * shutdown — a test fixture teardown, an uninstaller, a home move — gets EPERM/EBUSY unless the
 * process that started the child also waits for it. `server.stop` calls this so the shutdown
 * contract owns every child it started. No-op when nothing is in flight.
 */
export async function flushConfigDirHardening(dir: string = getConfigDir()): Promise<void> {
  const flight = configDirHardeningFlights.get(dir);
  if (flight) await flight;
}

/**
 * Intercept CA/token/picker writers call this after their last unrelated await. Parent
 * inheritable ACL propagation can overwrite a child's concurrent explicit grant. Drain the
 * registered config flight and overlapping work (including ancestors and timeout reaps),
 * within one ACL deadline. Timeout refuses admission without dropping child cleanup ownership.
 * The final registry check and synchronous callback share a turn: promise continuations and
 * newly queued hardeners cannot start icacls between that check and secret publication.
 * Keep the callback synchronous; an await inside it would reopen the propagation race.
 */
export async function withConfigDirHardeningSettled<T>(dir: string, mutate: () => T): Promise<T> {
  // Async work registers before its factory starts, including the optional config flight.
  // A separate flush here would escape the registry's total admission deadline.
  return withWindowsSecretAclSettled(dir, mutate);
}

/** A settled ACL deadline is not proof its child has exited; stop must drain both before removal. */
export async function flushConfigDirHardeningAndReaps(dir: string): Promise<void> {
  try { await flushConfigDirHardening(dir); }
  finally { await flushWindowsSecretAclReapsBeforeRemoval(dir); }
}

/** Test-only: settle every in-flight config-directory harden regardless of directory. */
export async function flushConfigDirHardeningForTests(): Promise<void> {
  await Promise.all([...configDirHardeningFlights.values()]);
}
