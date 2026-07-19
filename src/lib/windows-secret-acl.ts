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

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { env, platform } from "node:process";

const hardenedDirectories = new Set<string>();
const hardenedPaths = new Set<string>();

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

/**
 * Run icacls to harden a single file system entry.
 * - Disables inheritance (keeps nothing: /inheritance:r)
 * - Grants the current user Full Control
 *
 * We do NOT use a shell string; all arguments are passed as an array so no
 * shell injection is possible even for paths with unusual characters.
 *
 * Throws the raw child_process error on failure (caller sanitizes).
 */
function runIcacls(targetPath: string, directory: boolean): void {
  const user = currentWindowsUser();
  if (!user) {
    throw new Error("Cannot determine current Windows user for ACL hardening");
  }

  // Step 1: disable inheritance and remove inherited ACEs
  execFileSync("icacls.exe", [targetPath, "/inheritance:r"], {
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 5000,
    shell: false,
  });

  // Step 2: remove broad explicit grants using stable SIDs (not localized names).
  execFileSync("icacls.exe", [
    targetPath,
    "/remove:g",
    "*S-1-1-0",
    "*S-1-5-11",
    "*S-1-5-32-545",
  ], {
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 5000,
    shell: false,
  });

  // Step 3: grant current user full control.
  const grant = directory ? `${user}:(OI)(CI)(F)` : `${user}:(F)`;
  execFileSync("icacls.exe", [targetPath, "/grant:r", grant], {
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 5000,
    shell: false,
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
  const code = error instanceof Error && "code" in error ? String((error as NodeJS.ErrnoException).code) : "";
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
      throw new Error(diagnostics);
    }
    return { ok: false, diagnostics };
  }
}
