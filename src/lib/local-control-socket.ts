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

/**
 * Whether the kernel can bind this path. sun_path counts the BYTES of the encoded path, not
 * JavaScript's UTF-16 code units, so a home directory with non-ASCII characters needs a shorter
 * name than path.length suggests.
 */
export function localControlSocketPathFits(path: string): boolean {
  return Buffer.byteLength(path, "utf8") <= LOCAL_CONTROL_SOCKET_PATH_MAX;
}

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
 * How much of the instance token the socket name keeps. The name only has to differ from the
 * instance it replaces, and the lease already serializes instances, so 32 bits is plenty;
 * keeping it short keeps the private path no longer than the public one (`.c65535.abcdef12` is
 * 16 bytes, `control-65535.sock` is 18), so a home that fits the public path fits this one too.
 */
const PRIVATE_SOCKET_TOKEN_CHARS = 8;

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
  if (!localControlSocketPathFits(path) || !isPrivateSocketDir(localControlSocketDir(configDir))) return null;
  try {
    const stat = lstatSync(path);
    return stat.isSocket() && stat.uid === process.getuid!() ? path : null;
  } catch {
    return null;
  }
}
