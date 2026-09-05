/**
 * Core-owned slot for the optional ADR-0008 Go sidecar health forwarder.
 *
 * The Go sidecar is an optional subsystem: a default install never spawns it
 * and must execute none of its code. Core route files therefore hold only this
 * slot — null on installs that never activate the sidecar — and the optional
 * module (`src/server/go-sidecar.ts`) registers its forwarder here when it
 * activates. This mirrors `passive-route-linker.ts`: an optional subsystem
 * registers into a core-owned slot at activation instead of being imported.
 *
 * Contract for any registered forwarder: given the sidecar is attached, return
 * the sidecar's `GET /api/system/health` Response; return null when there is
 * nothing to forward (not attached, not reachable, or a supervision blip) so
 * the caller serves the in-process handler exactly as before. The try/catch
 * lives here so the guarantee belongs to the mechanism instead of being
 * restated by every caller.
 */

export type GoSidecarHealthForwarder = () => Promise<Response | null>;

let forwarder: GoSidecarHealthForwarder | null = null;

/** Install the forwarder. Returns a detach function. */
export function setGoSidecarHealthForwarder(next: GoSidecarHealthForwarder): () => void {
  forwarder = next;
  return () => {
    // Only detach our own registration: a later activation may have replaced it.
    if (forwarder === next) forwarder = null;
  };
}

/**
 * Forward the health request to the attached Go sidecar, or null when no
 * subsystem is active or the sidecar is unreachable. Never throws.
 */
export async function tryGoSidecarHealthForward(): Promise<Response | null> {
  if (!forwarder) return null;
  try {
    return await forwarder();
  } catch {
    return null;
  }
}

/** True when the optional subsystem has installed a forwarder. Test/diagnostic use. */
export function hasGoSidecarHealthForwarder(): boolean {
  return forwarder !== null;
}

/** Test-only reset. */
export function resetGoSidecarHealthForwarderForTests(): void {
  forwarder = null;
}
