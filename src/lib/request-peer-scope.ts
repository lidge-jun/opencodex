import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Where the request being served came from: a local client on this machine, or not.
 *
 * Recorded once per HTTP request or WebSocket socket at the listener, from facts a client cannot
 * forge: the listener that received it and the kernel-observed peer address. Providers that must
 * never be shared off the machine read it (the Antigravity ACP provider, plan 080). A turn with no
 * recorded scope is not local: internal or context-free calls fail closed.
 */
export interface RequestPeerSnapshot { readonly local: boolean }

const scope = new AsyncLocalStorage<RequestPeerSnapshot>();

/** Ingresses a local client can reach the data plane through. Hub and link ingress never count. */
const LOCAL_INGRESSES = new Set(["public", "unauthenticated-loopback", "claude-intercept"]);
const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/** Local only for a loopback peer on a listener a local client uses. */
export function classifyRequestPeer(ingress: string, peerAddress: string | null | undefined): RequestPeerSnapshot {
  return Object.freeze({ local: LOCAL_INGRESSES.has(ingress) && typeof peerAddress === "string" && LOOPBACK_ADDRESSES.has(peerAddress) });
}

/** Run one request, or one WebSocket frame, inside its fixed peer snapshot. */
export function runWithRequestPeer<T>(snapshot: RequestPeerSnapshot | undefined, run: () => T): T {
  return snapshot ? scope.run(snapshot, run) : scope.exit(run);
}

/** True only when the current request was recorded as local. */
export function currentRequestIsLocal(): boolean {
  return scope.getStore()?.local === true;
}
