import { isAbsolute, join } from "node:path";
import { LocalMessagingError } from "./types";

export interface LocalSocket extends WebSocket { terminate(): void }

/** Explicit home only: resolving or starting the user's daemon is not transport work. */
export function localDaemonEndpoint(codexHome: string, platform = process.platform) {
  const path = join(codexHome, "app-server-control", "app-server-control.sock");
  // Conservative Unix path budget shared by both callers; Bun may otherwise accept
  // a path the native Codex queue client cannot connect to.
  if (!["linux", "darwin"].includes(platform) || !isAbsolute(codexHome)
    || Buffer.byteLength(path) > 103 || /[:?#%\\\x00-\x1f]/.test(path)) {
    throw new LocalMessagingError("unsupported_socket", "This local Codex control socket cannot be addressed on this platform.");
  }
  return { url: `ws+unix://${path}:/`, nativeUrl: `unix://${path}` };
}

export function localSocket(url: string): LocalSocket {
  if (!/^ws\+unix:\/\/\/[^:?#%\\\x00-\x1f]+:\/$/.test(url) || Buffer.byteLength(url.slice(10, -2)) > 103) {
    throw new LocalMessagingError("unsupported_socket", "Messaging accepts only the local Unix control socket.");
  }
  const Constructor = WebSocket as unknown as { new(url: string): LocalSocket };
  return new Constructor(url);
}
