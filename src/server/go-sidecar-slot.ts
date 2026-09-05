/**
 * Core-owned slot for the optional ADR-0008 Go sidecar route forwarder.
 *
 * The Go sidecar is an optional subsystem: a default install never spawns it
 * and must execute none of its code. Core route dispatch therefore holds only
 * this slot — empty on installs that never activate the sidecar — and the
 * optional module (`src/server/go-sidecar.ts`) registers its forwarder here
 * when it activates. This mirrors `passive-route-linker.ts`: an optional
 * subsystem registers into a core-owned slot at activation instead of being
 * imported.
 *
 * Contract for any registered forwarder: given the sidecar is attached, relay
 * the request (`method` + `pathAndSearch`) to the sidecar's loopback listener
 * and return its Response; return null when there is nothing to forward (not
 * attached, not reachable, a supervision blip, or a non-2xx upstream) so the
 * caller serves the in-process handler exactly as before. The try/catch lives
 * here so the guarantee belongs to the mechanism instead of being restated by
 * every caller.
 *
 * Dispatch decides WHICH requests reach this slot: `management-api.ts` first
 * looks up the route in the declared Go-owned surface (`route-registry.ts`) and
 * only then asks the slot to forward, so the slot never invents surface of its
 * own and a misconfigured opt-in cannot hijack a route that is not declared
 * Go-owned.
 */

export type GoOwnedRouteForwarder = (method: string, pathAndSearch: string) => Promise<Response | null>;

let forwarder: GoOwnedRouteForwarder | null = null;

/** Install the forwarder. Returns a detach function. */
export function setGoOwnedRouteForwarder(next: GoOwnedRouteForwarder): () => void {
  forwarder = next;
  return () => {
    // Only detach our own registration: a later activation may have replaced it.
    if (forwarder === next) forwarder = null;
  };
}

/**
 * Forward one declared Go-owned request to the attached sidecar, or null when
 * no subsystem is active or the sidecar is unreachable. Never throws.
 */
export async function tryForwardGoOwnedRoute(method: string, pathAndSearch: string): Promise<Response | null> {
  if (!forwarder) return null;
  try {
    return await forwarder(method, pathAndSearch);
  } catch {
    return null;
  }
}

/** True when the optional subsystem has installed a forwarder. Test/diagnostic use. */
export function hasGoOwnedRouteForwarder(): boolean {
  return forwarder !== null;
}

/** Test-only reset. */
export function resetGoOwnedRouteForwarderForTests(): void {
  forwarder = null;
}
