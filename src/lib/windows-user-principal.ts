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
 *
 * The lookup runs `whoami /user` instead of `powershell.exe`. The original
 * PowerShell path spawned without `windowsHide`, so every secret-file write
 * from the console-less proxy presented a visible console window (the v2.11.0
 * popup bug). `whoami.exe` keeps the popup fixed — it runs hidden via
 * CREATE_NO_WINDOW (windowsHide) — while starting far faster than PowerShell
 * 5.1 and reading the same effective-token SID. It is resolved from the
 * trusted System32 directory, never from PATH.
 */

import { resolveTrustedWindowsWhoamiExe } from "./windows-elevation";
import { parseWindowsSidFromWhoami, runWhoamiAsync, runWhoamiSync } from "./windows-whoami";

const SID_PATTERN = /^S-1-(?:\d+-)+\d+$/i;

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

function windowsPrincipalWhoamiCommand(): string[] {
  return [resolveTrustedWindowsWhoamiExe(), "/user"];
}

/** Test-only readback of the exact trusted executable and static arguments. */
export function windowsPrincipalCommandForTests(): string[] {
  return windowsPrincipalWhoamiCommand();
}

function defaultWindowsPrincipalRunner(timeoutMs: number): WindowsPrincipalLookupResult {
  const result = runWhoamiSync(timeoutMs);
  return {
    success: result.success,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    // stdout carries exactly the SID (principalFromResult validates it).
    stdout: result.success ? parseWindowsSidFromWhoami(result.output) ?? "" : "",
  };
}

async function defaultAsyncWindowsPrincipalRunner(
  timeoutMs: number,
): Promise<WindowsPrincipalLookupResult> {
  const result = await runWhoamiAsync(timeoutMs);
  return {
    success: result.success,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    stdout: result.success ? parseWindowsSidFromWhoami(result.output) ?? "" : "",
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
