import { lstatSync, readdirSync, realpathSync, unlinkSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { getConfigDir } from "../config/paths";
import { resolveTrustedWindowsPowerShellExe } from "./windows-elevation";
import { verifyWindowsEntriesAcl, WINDOWS_OWNER_ACL_TIMEOUT_MS, type WindowsAclEntry } from "./windows-owner-acl";

/**
 * The local control socket (#8184): a Unix-domain socket in a private directory under the
 * OpenCodex home. Only a process running as this user can open it, and nothing that relays TCP
 * (Tailscale Serve on the hub management listener, a reverse proxy) can deliver a request to it,
 * so a request that arrives on it came from this machine through the filesystem. That is the
 * property the TCP loopback listeners cannot offer once a relay targets them.
 *
 * Windows (#8998) has AF_UNIX sockets too, with two differences this module absorbs: an AF_UNIX
 * file is a reparse point that lstat refuses with EACCES, so neither its type nor its owner can be
 * read; and the private directory is a DACL, not a mode. The directory therefore has to be proven
 * private by its ACL, and the whole path to it by trusted ancestry with no reparse point on it, so
 * that no other account can create, replace or redirect anything the CLI sends the token to.
 */

/** sun_path is 104 bytes on macOS and 108 on Linux, both including the terminating NUL. */
export const LOCAL_CONTROL_SOCKET_PATH_MAX = 103;

/**
 * Whether the kernel can bind this path. sun_path counts the BYTES of the encoded path, not
 * JavaScript's UTF-16 code units, so a home directory with non-ASCII characters needs a shorter
 * name than path.length suggests.
 */
export function localControlSocketPathFits(path: string): boolean {
  return Buffer.byteLength(path, "utf8") <= LOCAL_CONTROL_SOCKET_PATH_MAX;
}

export function localControlSocketSupported(): boolean {
  return process.platform === "win32" || typeof process.getuid === "function";
}

export function localControlSocketDir(configDir: string = getConfigDir()): string {
  return join(configDir, "run");
}

/** One socket per public port, so two runtimes sharing a home never take each other's. */
export function localControlSocketPath(port: number, configDir?: string): string {
  return join(localControlSocketDir(configDir), `control-${port}.sock`);
}

/**
 * How much of the instance token the socket name keeps. The name only has to differ from the
 * instance it replaces, and the lease already serializes instances, so 32 bits is plenty;
 * keeping it short keeps the private path no longer than the public one (`.c65535.abcdef12` is
 * 16 bytes, `control-65535.sock` is 18), so a home that fits the public path fits this one too.
 */
const PRIVATE_SOCKET_TOKEN_CHARS = 8;
const PRIVATE_SOCKET_NAME = /^\.c([1-9]\d{0,4})\.[0-9a-f]{8}$/;

/**
 * Is this directory entry one runtime's private socket for this port? Exactly that name shape and
 * nothing else, so the lease, its claim files or any other file in the directory are never cleanup
 * candidates.
 */
export function isLocalControlPrivateSocketName(port: number, name: string): boolean {
  const match = PRIVATE_SOCKET_NAME.exec(name);
  return match !== null && match[1] === String(port);
}

/**
 * The address Bun itself binds for one runtime. It is instance-specific, so a shutdown can only
 * ever unlink its own listener and a restart in the same process cannot collide with the instance
 * it is replacing; the public path above is a hard link to this socket.
 */
export function localControlPrivateSocketPath(port: number, token: string, configDir?: string): string {
  return join(localControlSocketDir(configDir), `.c${port}.${token.slice(0, PRIVATE_SOCKET_TOKEN_CHARS)}`);
}

/**
 * The ownership record for one port's public socket. A runtime holds it for as long as it serves
 * the socket, so a second runtime can tell a live incumbent from a crashed predecessor.
 */
export function localControlLeasePath(port: number, configDir?: string): string {
  return join(localControlSocketDir(configDir), `.c${port}.lease`);
}

/**
 * On Windows, is this an AF_UNIX socket entry? The directory lists it and lstat refuses it with
 * EACCES, which is how an AF_UNIX reparse point reads; a file lstat can read is not one. This is an
 * observation, not proof of the type: it is only trusted inside a directory proven private, where
 * nothing but this account and the system can create entries.
 */
export function windowsSocketEntry(path: string): boolean {
  return windowsSocketEntryState(path) === "socket";
}

/**
 * The same observation with the doubt kept: "absent" only when the directory was read and does not
 * list the name (or is itself gone), "other" for an entry lstat can read, "socket" as above, and
 * "unknown" for any failure in between. Cleanup that must prove a name gone treats "unknown" as
 * still present.
 */
export type WindowsSocketEntryState = "absent" | "socket" | "other" | "unknown";

export function windowsSocketEntryState(path: string): WindowsSocketEntryState {
  let listed: boolean;
  try {
    listed = readdirSync(dirname(path)).includes(basename(path));
  } catch (error) {
    return (error as { code?: unknown } | null)?.code === "ENOENT" ? "absent" : "unknown";
  }
  if (!listed) return "absent";
  try {
    lstatSync(path);
    return "other";
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    return code === "EACCES" ? "socket" : code === "ENOENT" ? "absent" : "unknown";
  }
}

/**
 * Remove a socket name this runtime published, or throw. A name proven absent is done, and so is an
 * entry lstat can read: it is verifiably not a socket, so not one this runtime could still serve. A
 * socket is unlinked and must then read absent. Anything that cannot be proven (an unreadable
 * directory, an unexpected error, a failed unlink) throws, so the caller keeps its lease and retries
 * instead of handing the port to a successor while the name may still exist.
 */
export function removeWindowsPrivateSocket(
  path: string,
  observe: (path: string) => WindowsSocketEntryState = windowsSocketEntryState,
  unlink: (path: string) => void = unlinkSync,
): void {
  const state = observe(path);
  if (state === "absent" || state === "other") return;
  if (state !== "socket") throw new Error("socket name could not be proven removed");
  unlink(path);
  if (observe(path) !== "absent") throw new Error("socket name is still present after unlink");
}

/**
 * One directory, as it is: the canonical path spells the same, lstat sees a directory and no link,
 * and Windows reports no reparse point on it. Checked before anything changes the directory, so a
 * pre-existing junction or other reparse point is refused before an ACL operation could follow it.
 */
export function windowsPlainDirectory(dir: string): boolean {
  try {
    const absolute = resolve(dir);
    if (realpathSync.native(absolute).toLowerCase() !== absolute.toLowerCase()) return false;
    const stat = lstatSync(absolute);
    return stat.isDirectory() && !stat.isSymbolicLink() && windowsNoReparsePoint([absolute]);
  } catch {
    return false;
  }
}

/** The config home's ancestors, nearest first, up to the volume root. */
function ancestorsOf(path: string): string[] {
  const ancestors: string[] = [];
  for (let current = dirname(path); ; current = dirname(current)) {
    ancestors.push(current);
    if (dirname(current) === current) return ancestors;
  }
}

/**
 * The ACL entries the Windows path has to pass: the run directory private, the config home
 * writable by this account alone, and every ancestor owned by this account or a kernel-equivalent
 * principal with nobody else able to change it (src/lib/windows-owner-acl.ts).
 */
function windowsTrustEntries(runDir: string, includeRunDir: boolean): WindowsAclEntry[] {
  const config = dirname(runDir);
  return [
    ...(includeRunDir ? [{ path: runDir, directory: true, policy: "private-runtime-directory" as const }] : []),
    { path: config, directory: true, policy: "write-private" as const },
    ...ancestorsOf(config).map(path => ({ path, directory: true, policy: "trusted-ancestry" as const })),
  ];
}

// Constant script; the paths arrive as environment data and never become PowerShell source.
const REPARSE_SCRIPT = String.raw`
$ErrorActionPreference='Stop'
try {
  $countText=[Environment]::GetEnvironmentVariable('OCX_LC_COUNT')
  if ($countText -notmatch '^[1-9][0-9]?$') { exit 3 }
  for ($i=0; $i -lt [int]$countText; $i++) {
    $path=[Environment]::GetEnvironmentVariable(('OCX_LC_PATH_{0}' -f $i))
    if ([string]::IsNullOrEmpty($path)) { exit 3 }
    $attributes=[System.IO.File]::GetAttributes($path)
    if (($attributes -band [System.IO.FileAttributes]::Directory) -eq 0) { exit 1 }
    if (($attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { exit 1 }
  }
  exit 0
} catch { exit 3 }
`;
const ENCODED_REPARSE_SCRIPT = Buffer.from(REPARSE_SCRIPT, "utf16le").toString("base64");

/** Every path a real directory without a reparse point, as Windows itself reports the attributes. */
function windowsNoReparsePoint(paths: readonly string[]): boolean {
  if (paths.length === 0 || paths.length > 99) return false;
  const env: Record<string, string | undefined> = { ...process.env, OCX_LC_COUNT: String(paths.length) };
  paths.forEach((path, index) => { env[`OCX_LC_PATH_${index}`] = path; });
  try {
    const result = Bun.spawnSync([
      resolveTrustedWindowsPowerShellExe(), "-NoLogo", "-NoProfile", "-NonInteractive",
      "-ExecutionPolicy", "Bypass", "-EncodedCommand", ENCODED_REPARSE_SCRIPT,
    ], { env, stdin: "ignore", stdout: "ignore", stderr: "ignore", timeout: WINDOWS_OWNER_ACL_TIMEOUT_MS, windowsHide: true });
    return result.success && !result.exitedDueToTimeout && result.exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * The Windows path rule (#8998). The canonical path spells the same path and every component is
 * a real directory, so no junction, symlink or other reparse point redirects it; and the ACLs
 * leave no other account able to create, replace or rename anything on it, so the path checked
 * now is the path a later connect uses. Any doubt, error or timeout answers false.
 */
export function windowsTrustedPath(runDir: string, includeRunDir = true): boolean {
  try {
    const absolute = resolve(runDir);
    const entries = windowsTrustEntries(absolute, includeRunDir);
    const checked = includeRunDir ? absolute : dirname(absolute);
    if (realpathSync.native(checked).toLowerCase() !== checked.toLowerCase()) return false;
    for (const entry of entries) {
      const stat = lstatSync(entry.path);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    }
    return windowsNoReparsePoint(entries.map(entry => entry.path))
      && verifyWindowsEntriesAcl(entries, WINDOWS_OWNER_ACL_TIMEOUT_MS);
  } catch {
    return false;
  }
}

/** A real directory, owned by this user, that no other user can enter or list (Windows: see above). */
export function isPrivateSocketDir(dir: string): boolean {
  if (process.platform === "win32") return windowsTrustedPath(dir);
  try {
    const stat = lstatSync(dir);
    return stat.isDirectory() && !stat.isSymbolicLink()
      && stat.uid === process.getuid!() && (stat.mode & 0o077) === 0;
  } catch {
    return false;
  }
}

/**
 * The socket path a client may send the admin token to, or null. The directory must still be
 * private and the socket must be a socket owned by this user: anything else is not ours.
 */
export function usableLocalControlSocket(port: number, configDir?: string): string | null {
  if (!localControlSocketSupported() || !Number.isInteger(port) || port <= 0 || port > 65535) return null;
  const path = localControlSocketPath(port, configDir);
  if (process.platform === "win32") {
    // Trust boundary: the current user and administrators are trusted, as for every file in the
    // config home. Windows cannot report an AF_UNIX file's owner, so endpoint ownership is not
    // verified here; what is verified is that the run directory is private. The runtime creates
    // it only under a write-private config home and refuses one that already existed loose.
    // The cheap observation first: no listed socket means no PowerShell at all.
    if (!localControlSocketPathFits(path) || !windowsSocketEntry(path)) return null;
    return isPrivateSocketDir(localControlSocketDir(configDir)) && windowsSocketEntry(path) ? path : null;
  }
  if (!localControlSocketPathFits(path) || !isPrivateSocketDir(localControlSocketDir(configDir))) return null;
  try {
    const stat = lstatSync(path);
    return stat.isSocket() && stat.uid === process.getuid!() ? path : null;
  } catch {
    return null;
  }
}
