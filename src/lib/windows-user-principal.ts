/**
 * Resolve the effective Windows token to the locale-independent SID form that
 * icacls accepts ("*S-1-..."). Environment values such as USERDOMAIN are not
 * an authority for the current token: on workgroup machines USERDOMAIN may be
 * the literal WORKGROUP even though the account belongs to the local computer.
 */

import { resolveTrustedWindowsPowerShellExe } from "./windows-elevation";

const SID_PATTERN = /^S-1-(?:\d+-)+\d+$/i;
const SID_EXPRESSION =
  "[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value";

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
  "-WindowStyle",
  "Hidden",
  "-Command",
  SID_EXPRESSION,
] as const;

function windowsPrincipalPowerShellCommand(): string[] {
  return [resolveTrustedWindowsPowerShellExe(), ...POWERSHELL_ARGS];
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
  if (cachedPrincipal) return cachedPrincipal;
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
  if (cachedPrincipal) return cachedPrincipal;
  if (asyncLookupInFlight) return waitForExistingLookup(asyncLookupInFlight, timeoutMs);
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
}
