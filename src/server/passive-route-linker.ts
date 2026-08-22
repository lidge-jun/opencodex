/**
 * Optional per-attempt route-identity linker.
 *
 * Compatibility Lab attaches an opaque route-subject digest to request attempts so its
 * passive-production surface (CL-09) can correlate them later. That is an opt-in
 * subsystem, so the core request path holds only a slot: null on installs that never
 * activate Lab, which is every install without a routing profile.
 *
 * Contract for any registered implementation: synchronous, free of side effects with
 * respect to the request, and non-throwing. The upstream request must never be delayed,
 * retried, or altered by identity linkage. The try/catch lives here rather than at the
 * call site so the guarantee belongs to the mechanism instead of being restated by every
 * caller.
 *
 * See devlog/_fin/260814_lab_core_decoupling/020_request_path_gate.md
 */
import type { OcxConfig, OcxProviderConfig } from "../types";
import type { InboundWire } from "../providers/registry";

export type PassiveRouteLinker = (
  config: OcxConfig,
  providerName: string,
  modelId: string,
  routed: OcxProviderConfig,
  inboundWire: InboundWire,
) => string | null;

let linker: PassiveRouteLinker | null = null;

/** Install the linker. Returns a detach function. */
export function setPassiveRouteLinker(next: PassiveRouteLinker): () => void {
  linker = next;
  return () => {
    // Only detach our own registration: a later activation may have replaced it.
    if (linker === next) linker = null;
  };
}

/**
 * Resolve the attempt identity, or null when no subsystem is active.
 * Never throws: linkage is best-effort metadata and must not affect the request.
 */
export function resolvePassiveRouteSubjectId(
  config: OcxConfig,
  providerName: string,
  modelId: string,
  routed: OcxProviderConfig,
  inboundWire: InboundWire,
): string | null {
  if (!linker) return null;
  try {
    return linker(config, providerName, modelId, routed, inboundWire);
  } catch {
    return null;
  }
}

/** True when an optional subsystem has installed a linker. Test/diagnostic use. */
export function hasPassiveRouteLinker(): boolean {
  return linker !== null;
}

/** Test-only reset. */
export function resetPassiveRouteLinkerForTests(): void {
  linker = null;
}
