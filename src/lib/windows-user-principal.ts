/**
 * Resolve the effective Windows token to the locale-independent SID form that
 * icacls accepts ("*S-1-..."). Environment values such as USERDOMAIN are not
 * an authority for the current token: on workgroup machines USERDOMAIN may be
 * the literal WORKGROUP even though the account belongs to the local computer.
 *
 * There is deliberately NO name-shaped fallback. A `DOMAIN\User` string has a
 * valid shape, but shape is not evidence that the account is the current
 * token's subject, and both environment variables are writable by whatever
 * launched us. A wrong principal here is not cosmetic: `runIcacls` grants it
 * Full Control and then removes inheritance, so a wrong grant either leaves a
 * different account holding the secret or strands the file with no usable ACE.
 * When the SID cannot be resolved, the caller declines to touch the ACL at all.
 *
 * Budget caveat: callers pass their REMAINING harden budget, which becomes the
 * child process timeout. Trusted-executable resolution (a `GetSystemDirectoryW`
 * FFI call) and spawn setup happen before that timeout starts, and the async
 * timer only arms once `Bun.spawn` returns. Both are small in practice, but the
 * lookup is not bounded by the deadline to the microsecond. Tightening that
 * would mean passing an absolute deadline through the runner interface.
 */

import { existsSync } from "node:fs";
import { win32 as windowsPath } from "node:path";

import {
  resolveTrustedWindowsPowerShellExe,
  WindowsSystemDirectoryFfiUnavailableError,
} from "./windows-elevation";

const SID_PATTERN = /^S-1-(?:\d+-)+\d+$/i;
const SID_EXPRESSION =
  "[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value";
const DEFAULT_WINDOWS_ARM64_POWERSHELL = windowsPath.join(
  "C:\\Windows\\System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
);

type PrincipalExecutableResolution = Readonly<{
  platform: NodeJS.Platform;
  arch: string;
  resolveTrusted: () => string;
  pathExists: (path: string) => boolean;
}>;

/**
 * Bun's Windows ARM64 build cannot currently execute the `bun:ffi` call used
 * by the general System32 resolver. The ACL identity lookup has a narrower
 * authority than the elevation helpers: it starts one non-elevated PowerShell
 * command and accepts only a SID-shaped result. Keep its fallback equally
 * narrow by using the fixed, OS-protected default installation path only.
 *
 * Environment and PATH lookup are deliberately absent. A Windows installation
 * outside C:\\Windows keeps failing closed rather than executing a binary chosen
 * by caller-controlled `SystemRoot`, `WINDIR`, or `PATH` values.
 */
function resolveWindowsPrincipalPowerShellExecutable(
  resolution: PrincipalExecutableResolution = {
    platform: process.platform,
    arch: process.arch,
    resolveTrusted: resolveTrustedWindowsPowerShellExe,
    pathExists: existsSync,
  },
): string {
  try {
    return resolution.resolveTrusted();
  } catch (error) {
    if (
      !(error instanceof WindowsSystemDirectoryFfiUnavailableError) ||
      resolution.platform !== "win32" ||
      resolution.arch !== "arm64" ||
      !resolution.pathExists(DEFAULT_WINDOWS_ARM64_POWERSHELL)
    ) {
      throw error;
    }
    return DEFAULT_WINDOWS_ARM64_POWERSHELL;
  }
}

/** Test-only dependency-injected view of the Windows ARM64 executable boundary. */
export function resolveWindowsPrincipalPowerShellExecutableForTests(
  resolution: PrincipalExecutableResolution,
): string {
  return resolveWindowsPrincipalPowerShellExecutable(resolution);
}

export interface WindowsPrincipalLookupResult {
  success: boolean;
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
}

export type WindowsPrincipalRunner = (
  timeoutMs: number,
) => WindowsPrincipalLookupResult;

export type AsyncWindowsPrincipalRunner = (
  timeoutMs: number,
) => Promise<WindowsPrincipalLookupResult>;

const POWERSHELL_ARGS = [
  "-NoLogo",
  "-NoProfile",
  "-NonInteractive",
  "-Command",
  SID_EXPRESSION,
] as const;

function windowsPrincipalPowerShellCommand(): string[] {
  return [resolveWindowsPrincipalPowerShellExecutable(), ...POWERSHELL_ARGS];
}

/** Test-only readback of the exact trusted executable and static arguments. */
export function windowsPrincipalPowerShellCommandForTests(): string[] {
  return windowsPrincipalPowerShellCommand();
}

function defaultWindowsPrincipalRunner(timeoutMs: number): WindowsPrincipalLookupResult {
  const result = Bun.spawnSync(windowsPrincipalPowerShellCommand(), {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
    timeout: Math.max(1, timeoutMs),
    windowsHide: true,
  });
  return {
    success: result.success,
    exitCode: result.exitCode,
    timedOut: result.exitedDueToTimeout ?? false,
    stdout: result.stdout ? result.stdout.toString() : "",
  };
}

async function defaultAsyncWindowsPrincipalRunner(
  timeoutMs: number,
): Promise<WindowsPrincipalLookupResult> {
  const proc = Bun.spawn(windowsPrincipalPowerShellCommand(), {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
    windowsHide: true,
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try { proc.kill(); } catch { /* already exited */ }
  }, Math.max(1, timeoutMs));
  let exitCode: number | null = null;
  try {
    exitCode = await proc.exited;
  } finally {
    clearTimeout(timer);
  }
  const stdout = proc.stdout
    ? await new Response(proc.stdout).text().catch(() => "")
    : "";
  return {
    success: !timedOut && exitCode === 0,
    exitCode: timedOut ? null : exitCode,
    timedOut,
    stdout,
  };
}

let principalRunner: WindowsPrincipalRunner = defaultWindowsPrincipalRunner;
let asyncPrincipalRunner: AsyncWindowsPrincipalRunner = defaultAsyncWindowsPrincipalRunner;
let cachedPrincipal: string | null = null;
let asyncLookupInFlight: Promise<string> | null = null;

/**
 * POSIX CI drives the Windows ACL branch through `setPlatformForTests("win32")`,
 * on hosts that have neither System32 nor PowerShell. Those runs need SOME
 * principal, so this seam supplies a synthetic one.
 *
 * It lives here rather than in `windows-secret-acl.ts` for one reason that is
 * not cosmetic: an explicitly injected runner must be able to beat it. When the
 * synthetic value was chosen first, in the ACL module, a test could not inject a
 * lookup FAILURE on POSIX at all — so the fail-closed and memo-isolation cases
 * were guarded with `if (process.platform !== "win32") return;` and never ran
 * outside Windows. Resolution order below is what makes those cases executable
 * on every runner.
 */
let syntheticPrincipalForTests: string | null = null;

/**
 * Test seam: supply the principal used when no runner was injected and the host
 * is not really Windows. Pass null to disable.
 */
export function setSyntheticWindowsPrincipalForTests(principal: string | null): void {
  syntheticPrincipalForTests = principal;
  cachedPrincipal = null;
}

/** True when an explicit runner override is installed and must take precedence. */
function hasSyncRunnerOverride(): boolean {
  return principalRunner !== defaultWindowsPrincipalRunner;
}

function hasAsyncRunnerOverride(): boolean {
  return asyncPrincipalRunner !== defaultAsyncWindowsPrincipalRunner;
}

function identityError(reason: string): NodeJS.ErrnoException {
  const error = new Error(`Windows effective-account SID lookup ${reason}`) as NodeJS.ErrnoException;
  // Keep identity lookup failures distinct from icacls timeouts. In particular,
  // they must not populate windows-secret-acl's destination timeout memo.
  error.code = "EACLIDENTITY";
  return error;
}

function principalFromResult(result: WindowsPrincipalLookupResult): string {
  if (!result.success) {
    throw identityError(result.timedOut
      ? "timed out"
      : `exited ${result.exitCode ?? "null"}`);
  }
  const sid = result.stdout.trim();
  if (!SID_PATTERN.test(sid)) {
    throw identityError(sid ? "returned an invalid SID" : "returned an empty SID");
  }
  return `*${sid.toUpperCase()}`;
}

/** Resolve and process-cache the effective token SID for synchronous ACL paths. */
export function resolveCurrentWindowsPrincipal(timeoutMs: number): string {
  // Order matters: an explicitly injected runner outranks the synthetic value,
  // so a test can inject a FAILURE on a POSIX host. See the seam comment above.
  if (hasSyncRunnerOverride()) {
    if (cachedPrincipal) return cachedPrincipal;
    if (timeoutMs <= 0) throw identityError("had no remaining deadline");
    let overridden: WindowsPrincipalLookupResult;
    try {
      overridden = principalRunner(timeoutMs);
    } catch {
      throw identityError("could not start");
    }
    const principal = principalFromResult(overridden);
    cachedPrincipal = principal;
    return principal;
  }
  if (cachedPrincipal) return cachedPrincipal;
  if (syntheticPrincipalForTests) return syntheticPrincipalForTests;
  if (timeoutMs <= 0) throw identityError("had no remaining deadline");
  let result: WindowsPrincipalLookupResult;
  try {
    result = principalRunner(timeoutMs);
  } catch {
    throw identityError("could not start");
  }
  const principal = principalFromResult(result);
  cachedPrincipal = principal;
  return principal;
}

async function waitForExistingLookup(
  lookup: Promise<string>,
  timeoutMs: number,
): Promise<string> {
  if (timeoutMs <= 0) throw identityError("had no remaining deadline");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      lookup,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(identityError("timed out while awaiting the shared lookup")),
          Math.max(1, timeoutMs),
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Async counterpart. Concurrent callers share one owned child lookup; a later
 * caller may exhaust its own budget without cancelling the lookup owned by the
 * first caller. The first caller owns that child and its process timeout; a
 * later, longer budget deliberately does not extend an already-running child.
 */
export async function resolveCurrentWindowsPrincipalAsync(timeoutMs: number): Promise<string> {
  const overridden = hasAsyncRunnerOverride();
  if (cachedPrincipal) return cachedPrincipal;
  if (asyncLookupInFlight) return waitForExistingLookup(asyncLookupInFlight, timeoutMs);
  // Same precedence rule as the sync path: an injected runner beats the synthetic.
  if (!overridden && syntheticPrincipalForTests) return syntheticPrincipalForTests;
  if (timeoutMs <= 0) throw identityError("had no remaining deadline");

  const lookup = (async (): Promise<string> => {
    let result: WindowsPrincipalLookupResult;
    try {
      result = await asyncPrincipalRunner(timeoutMs);
    } catch {
      throw identityError("could not start");
    }
    const principal = principalFromResult(result);
    cachedPrincipal = principal;
    return principal;
  })();
  asyncLookupInFlight = lookup;
  try {
    return await lookup;
  } finally {
    if (asyncLookupInFlight === lookup) asyncLookupInFlight = null;
  }
}

/** Test seam: replace the sync resolver process and clear its successful cache. */
export function setWindowsPrincipalRunnerForTests(
  runner: WindowsPrincipalRunner | null,
): void {
  if (asyncLookupInFlight) {
    throw new Error("Cannot replace the Windows principal runner while a lookup is in flight.");
  }
  principalRunner = runner ?? defaultWindowsPrincipalRunner;
  cachedPrincipal = null;
}

/** Test seam: replace the async resolver process and clear its successful cache. */
export function setAsyncWindowsPrincipalRunnerForTests(
  runner: AsyncWindowsPrincipalRunner | null,
): void {
  if (asyncLookupInFlight) {
    throw new Error("Cannot replace the Windows principal runner while a lookup is in flight.");
  }
  asyncPrincipalRunner = runner ?? defaultAsyncWindowsPrincipalRunner;
  cachedPrincipal = null;
}

/** Test seam: clear only process-local principal state. */
export function resetWindowsPrincipalForTests(): void {
  if (asyncLookupInFlight) {
    throw new Error("Cannot reset the Windows principal while a lookup is in flight.");
  }
  cachedPrincipal = null;
  syntheticPrincipalForTests = null;
}
