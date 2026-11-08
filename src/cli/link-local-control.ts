import { usableLocalControlSocket } from "../lib/local-control-socket";
import { RuntimeApiError, type RuntimeApiDeps } from "./runtime-api";

export interface LocalControlDeps {
  /** Test seam: the socket a live runtime on this port exposes, or null. */
  localControlSocket?: (port: number) => string | null;
}

/**
 * Send one `ocx link status` read over the runtime's local control socket when it has one (#8184).
 * A hub whose public listener is not loopback refuses the admin token on its TCP listeners, and the
 * socket is the ingress that may accept it. A runtime without the socket (Windows, a loopback bind,
 * an older version), or one whose socket cannot be reached, is asked over TCP exactly as before.
 */
export async function viaLocalControlSocket<T, D extends RuntimeApiDeps & LocalControlDeps>(
  baseUrl: string,
  deps: D,
  request: (deps: D) => Promise<T>,
): Promise<T> {
  const tcp = { ...deps, baseUrl };
  if (deps.baseUrl) return request(tcp);
  let port: number;
  try { port = Number(new URL(baseUrl).port); } catch { return request(tcp); }
  const socket = (deps.localControlSocket ?? usableLocalControlSocket)(port);
  if (!socket) return request(tcp);
  const fetchImpl = deps.fetchImpl ?? fetch;
  try {
    return await request({
      ...deps,
      baseUrl: "http://localhost",
      fetchImpl: ((url: string | URL | Request, init?: RequestInit) =>
        fetchImpl(url, { ...init, unix: socket } as RequestInit)) as typeof fetch,
    });
  } catch (error) {
    // Only a transport failure falls back: an answer from the socket is the runtime's answer.
    if (error instanceof RuntimeApiError && error.status === 503 && error.body === null) return request(tcp);
    throw error;
  }
}
