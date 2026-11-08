import { lstatSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "../config/paths";

/**
 * The local control socket (#8184): a Unix-domain socket in a private directory under the
 * OpenCodex home. Only a process running as this user can open it, and nothing that relays TCP
 * (Tailscale Serve on the hub management listener, a reverse proxy) can deliver a request to it,
 * so a request that arrives on it came from this machine through the filesystem. That is the
 * property the TCP loopback listeners cannot offer once a relay targets them.
 */

/** sun_path is 104 bytes on macOS and 108 on Linux, both including the terminating NUL. */
export const LOCAL_CONTROL_SOCKET_PATH_MAX = 103;

export function localControlSocketSupported(): boolean {
  return process.platform !== "win32" && typeof process.getuid === "function";
}

export function localControlSocketDir(configDir: string = getConfigDir()): string {
  return join(configDir, "run");
}

/** One socket per public port, so two runtimes sharing a home never take each other's. */
export function localControlSocketPath(port: number, configDir?: string): string {
  return join(localControlSocketDir(configDir), `control-${port}.sock`);
}

/**
 * The address Bun itself binds for one runtime. It is process-specific, so a shutdown can only
 * ever unlink its own listener, and the public path above is a hard link to this socket. The name
 * is never longer than the public one (`.c65535.zzzzzz` vs `control-65535.sock`).
 */
export function localControlPrivateSocketPath(port: number, configDir?: string): string {
  return join(localControlSocketDir(configDir), `.c${port}.${process.pid.toString(36)}`);
}

/**
 * The ownership record for one port's public socket. A runtime holds it for as long as it serves
 * the socket, so a second runtime can tell a live incumbent from a crashed predecessor.
 */
export function localControlLeasePath(port: number, configDir?: string): string {
  return join(localControlSocketDir(configDir), `.c${port}.lease`);
}

/** A real directory, owned by this user, that no other user can enter or list. */
export function isPrivateSocketDir(dir: string): boolean {
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
  if (path.length > LOCAL_CONTROL_SOCKET_PATH_MAX || !isPrivateSocketDir(localControlSocketDir(configDir))) return null;
  try {
    const stat = lstatSync(path);
    return stat.isSocket() && stat.uid === process.getuid!() ? path : null;
  } catch {
    return null;
  }
}
