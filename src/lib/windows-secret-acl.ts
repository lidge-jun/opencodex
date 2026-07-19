/**
 * Windows per-user NTFS ACL hardening for secret files and directories.
 *
 * On Windows, `chmod` only controls POSIX-style bits in the ACE list and does NOT remove
 * inherited permissions from other users. Real per-user isolation requires icacls to:
 *   1. Disable inheritance   (icacls path /inheritance:r)
 *   2. Strip broad explicit grants by SID (Everyone, Users, Authenticated Users)
 *   3. Grant the current user full control (icacls path /grant:r "CURRENTUSER:(F)")
 *
 * On non-Windows platforms the helpers fall through to the caller's existing chmod-based
 * behaviour: they return ok:true without invoking any external process.
 *
 * Design:
 *   hardenSecretPath(path, { required: false }) — non-fatal read-path mode.
 *     Never throws. Returns { ok, diagnostics? }.
 *   hardenSecretPath(path, { required: true })  — write-path mode.
 *     Throws a sanitized error (no raw path) on Windows ACL failure.
 *   hardenSecretDir  — same contract for directories.
 */

import { existsSync } from "node:fs";
import { env, platform } from "node:process";

const hardenedDirectories = new Set<string>();
const hardenedPaths = new Set<string>();

/** Serialize icacls — concurrent hardens on auth.json + dir during OAuth can stall until timeout. */
let icaclsHeld = false;

export interface HardenResult {
  ok: boolean;
  diagnostics?: string;
}

export interface HardenOptions {
  required: boolean;
}

/**
 * Return the current Windows username from the environment.
 * Falls back to USERDOMAIN\USERNAME if USERNAME alone is ambiguous.
 * The value is used directly in icacls arguments, so it must be present.
 */
function currentWindowsUser(): string | undefined {
  const username = env["USERNAME"];
  const domain = env["USERDOMAIN"];
  if (!username) return undefined;
  // USERDOMAIN is the machine/domain name; USERNAME is the account name.
  // icacls accepts "DOMAIN\User" or just "User" for local accounts.
  return domain ? `${domain}\\${username}` : username;
}

function errorCode(error: unknown): string {
  return error instanceof Error && "code" in error ? String((error as NodeJS.ErrnoException).code) : "";
}

function isTimeoutError(error: unknown): boolean {
  return errorCode(error) === "ETIMEDOUT";
}

/** ACL failures that should not block auth/config writes (chmod still applied by caller). */
function isSoftFailAclError(error: unknown): boolean {
  const code = errorCode(error);
  return code === "ETIMEDOUT" || code === "EPERM" || code === "EACCES";
}

/**
 * Run one icacls argv via Bun.spawnSync (windowsHide + timeout).
 * Node execFileSync has hung under the GUI/proxy even with windowsHide.
 */
function icaclsOnce(args: string[], timeoutMs: number): void {
  const result = Bun.spawnSync(["icacls.exe", ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: timeoutMs,
    windowsHide: true,
  });
  if (result.success) return;

  const err = new Error(`icacls exited ${result.exitCode ?? "null"}`) as NodeJS.ErrnoException;
  // Bun sets exitedDueToTimeout when the timeout kills the child.
  err.code = result.exitedDueToTimeout ? "ETIMEDOUT" : "EPERM";
  throw err;
}

function icaclsWithRetry(args: string[]): void {
  const attempts = 3;
  const timeoutMs = 15_000;
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      icaclsOnce(args, timeoutMs);
      return;
    } catch (error) {
      last = error;
      if (!isTimeoutError(error) || i === attempts - 1) throw error;
      Bun.sleepSync(100 * (i + 1));
    }
  }
  throw last;
}

function withIcaclsLock(fn: () => void): void {
  const started = Date.now();
  while (icaclsHeld) {
    if (Date.now() - started > 60_000) {
      const err = new Error("icacls lock timeout") as NodeJS.ErrnoException;
      err.code = "ETIMEDOUT";
      throw err;
    }
    Bun.sleepSync(25);
  }
  icaclsHeld = true;
  try {
    fn();
  } finally {
    icaclsHeld = false;
  }
}

/**
 * Run icacls to harden a single file system entry.
 * - Disables inheritance (keeps nothing: /inheritance:r)
 * - Grants the current user Full Control
 *
 * Throws the raw child_process-like error on failure (caller sanitizes).
 */
function runIcacls(targetPath: string, directory: boolean): void {
  const user = currentWindowsUser();
  if (!user) {
    throw new Error("Cannot determine current Windows user for ACL hardening");
  }

  withIcaclsLock(() => {
    // Step 1: disable inheritance and remove inherited ACEs
    icaclsWithRetry([targetPath, "/inheritance:r"]);

    // Step 2: remove broad explicit grants using stable SIDs (not localized names).
    // Missing ACEs can yield a non-zero exit — treat as best-effort, not fatal.
    try {
      icaclsWithRetry([
        targetPath,
        "/remove:g",
        "*S-1-1-0",
        "*S-1-5-11",
        "*S-1-5-32-545",
      ]);
    } catch (error) {
      if (isTimeoutError(error)) throw error;
      // ACE already absent / not granted — continue to grant.
    }

    // Step 3: grant current user full control.
    const grant = directory ? `${user}:(OI)(CI)(F)` : `${user}:(F)`;
    icaclsWithRetry([targetPath, "/grant:r", grant]);
  });
}

/**
 * Sanitize an error from a failed ACL operation into a safe diagnostic string.
 * The raw path must not appear in the returned string (it may contain
 * sensitive username components or PII from the home directory path).
 */
function sanitizeDiagnostics(error: unknown): string {
  // We do not expose the raw error message or any path-like fragments.
  // Just describe what failed generically.
  const code = errorCode(error);
  const codePart = code ? ` (${code})` : "";
  return `ACL hardening failed${codePart} — filesystem may not support per-user NTFS ACLs`;
}

/**
 * Harden a single file path with per-user NTFS ACLs on Windows.
 * On non-Windows platforms, returns ok:true immediately (caller owns chmod).
 *
 * @param targetPath  Absolute path to the file to harden.
 * @param opts        { required: boolean } — required:true throws on failure.
 */
export function hardenSecretPath(targetPath: string, opts: HardenOptions): HardenResult {
  // Skip for missing files — we cannot harden what does not exist yet.
  if (!existsSync(targetPath)) {
    return { ok: true };
  }

  // Non-Windows: no NTFS ACLs; caller handles chmod.
  if (platform !== "win32") {
    return { ok: true };
  }

  if (hardenedPaths.has(targetPath)) return { ok: true };

  try {
    runIcacls(targetPath, false);
    hardenedPaths.add(targetPath);
    return { ok: true };
  } catch (err) {
    const diagnostics = sanitizeDiagnostics(err);
    if (opts.required) {
      // Last-resort: do not block OAuth/login/token refresh when icacls fails
      // (timeout or filesystem ACL unsupported). chmod still applied by caller.
      if (isSoftFailAclError(err)) {
        console.warn(`[opencodex] ${diagnostics} — continuing without NTFS ACL harden`);
        return { ok: false, diagnostics };
      }
      throw new Error(diagnostics);
    }
    return { ok: false, diagnostics };
  }
}

/**
 * Harden a directory path with per-user NTFS ACLs on Windows.
 * On non-Windows platforms, returns ok:true immediately (caller owns chmod).
 *
 * @param targetPath  Absolute path to the directory to harden.
 * @param opts        { required: boolean } — required:true throws on failure.
 */
export function hardenSecretDir(targetPath: string, opts: HardenOptions): HardenResult {
  // Skip for missing directories — we cannot harden what does not exist yet.
  if (!existsSync(targetPath)) {
    return { ok: true };
  }

  // Non-Windows: no NTFS ACLs; caller handles chmod.
  if (platform !== "win32") {
    return { ok: true };
  }

  if (hardenedDirectories.has(targetPath)) return { ok: true };

  try {
    runIcacls(targetPath, true);
    hardenedDirectories.add(targetPath);
    return { ok: true };
  } catch (err) {
    const diagnostics = sanitizeDiagnostics(err);
    if (opts.required) {
      if (isSoftFailAclError(err)) {
        console.warn(`[opencodex] ${diagnostics} — continuing without NTFS ACL harden`);
        return { ok: false, diagnostics };
      }
      throw new Error(diagnostics);
    }
    return { ok: false, diagnostics };
  }
}
