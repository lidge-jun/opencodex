import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { LocalMessagingError } from "./types";

export interface LocalSocket extends WebSocket { terminate(): void }
interface SocketStat {
  uid: number;
  mode: number;
  isSocket(): boolean;
  isDirectory(): boolean;
}
export interface SocketFilesystem {
  realpath(path: string): string;
  lstat(path: string): SocketStat;
}
/** Bun on macOS cannot realpath a socket inode; resolve its parent and terminal symlinks. */
function socketRealpath(path: string): string {
  for (let links = 0; links < 40; links++) {
    const parent = realpathSync(dirname(path));
    const candidate = join(parent, basename(path));
    if (!lstatSync(candidate).isSymbolicLink()) return candidate;
    path = resolve(parent, readlinkSync(candidate));
  }
  throw new Error("Too many socket symlinks");
}
const filesystem: SocketFilesystem = { realpath: socketRealpath, lstat: lstatSync };

/** Explicit home only: resolving or starting the user's daemon is not transport work. */
export function localDaemonEndpoint(codexHome: string, platform = process.platform) {
  const path = join(codexHome, "app-server-control", "app-server-control.sock");
  if (!["linux", "darwin"].includes(platform) || !isAbsolute(codexHome)
    || Buffer.byteLength(path) > 103 || /[:?#%\\\x00-\x1f]/.test(path)) {
    throw new LocalMessagingError("unsupported_socket", "This local Codex control socket cannot be addressed on this platform.");
  }
  return { url: `ws+unix://${path}:/` };
}

/** StrictModes on the resolved endpoint and every ancestor; symlinked homes are permitted. */
export function trustedSocketPath(path: string, fs: SocketFilesystem = filesystem,
  uid = process.getuid?.()): string {
  try {
    if (uid === undefined) throw new Error();
    const real = fs.realpath(path);
    if (!isAbsolute(real)) throw new Error();
    const socket = fs.lstat(real);
    if (!socket.isSocket() || socket.uid !== uid) throw new Error();
    for (let dir = dirname(real); ; dir = dirname(dir)) {
      const stat = fs.lstat(dir);
      if (!stat.isDirectory() || (stat.uid !== uid && stat.uid !== 0)
        || ((stat.mode & 0o022) !== 0 && !(stat.uid === 0 && (stat.mode & 0o1000) !== 0))) throw new Error();
      if (dir === "/") break;
    }
    return real;
  } catch {
    throw new LocalMessagingError("untrusted_socket", "The local Codex control socket or its parent directories are not trusted.");
  }
}

/** Validate trust before opening the resolved Unix endpoint; never accept network transports. */
export function localSocket(url: string): LocalSocket {
  if (!["linux", "darwin"].includes(process.platform)
    || !/^ws\+unix:\/\/\/[^:?#%\\\x00-\x1f]+:\/$/.test(url) || Buffer.byteLength(url.slice(10, -2)) > 103) {
    throw new LocalMessagingError("unsupported_socket", "Messaging accepts only the local Unix control socket.");
  }
  const path = trustedSocketPath(url.slice(10, -2));
  // A short alias does not bypass the actual Unix address budget or URL grammar.
  if (Buffer.byteLength(path) > 103 || /[:?#%\\\x00-\x1f]/.test(path)) {
    throw new LocalMessagingError("unsupported_socket", "Messaging accepts only the local Unix control socket.");
  }
  const Constructor = WebSocket as unknown as { new(url: string): LocalSocket };
  return new Constructor(`ws+unix://${path}:/`);
}
