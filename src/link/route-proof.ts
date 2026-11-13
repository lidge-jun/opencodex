/**
 * The Home's register of readiness proofs for multi-route links (src/link/supervisor.ts). Each proof
 * is a fresh id the supervisor sends, over one route, to the Child, which fetches its own
 * /v1/catalog with the id in LINK_ROUTE_PROOF_HEADER; the Child's link relay carries it to this
 * Home through the tunnel with relay authentication. The hub-link admission path reports an
 * authenticated catalog request carrying the header here (admit). A proof counts only for the
 * link key it was registered for, before its expiry, and while the link's tunnel generation is
 * still the one it was registered under. One entry per link; nothing is persisted or logged.
 */
export const LINK_ROUTE_PROOF_HEADER = "x-opencodex-link-route-proof";
const PROOF_ID = /^[0-9a-f]{32}$/;

export function isRouteProofId(value: unknown): value is string {
  return typeof value === "string" && PROOF_ID.test(value);
}

/**
 * The hub-link admission's side of a proof: read LINK_ROUTE_PROOF_HEADER and take it off the request,
 * so nothing handling the request afterwards sees it. A header that cannot be removed is not
 * reported. The id itself is validated by the registry (admit).
 */
export function takeRouteProof(req: Request): string | undefined {
  const proof = req.headers.get(LINK_ROUTE_PROOF_HEADER) ?? undefined;
  if (proof === undefined) return undefined;
  try { req.headers.delete(LINK_ROUTE_PROOF_HEADER); } catch { return undefined; }
  return proof;
}

export interface RouteProofEntry {
  linkId: string;
  apiKeyId: string;
  /** The connection generation of the candidate tunnel (supervisor.connectionGeneration). */
  generation: string;
  proofId: string;
  expiresAt: number;
}

export interface RouteProofHandle {
  /** True once an authenticated catalog request carrying this id was admitted in time. */
  admitted(): boolean;
  dispose(): void;
}

export interface RouteProofRegistry {
  register(entry: RouteProofEntry): RouteProofHandle;
  admit(apiKeyId: string, proofId: string): void;
  /** Drop a link's entry (round cancelled, link stopped or removed). */
  forget(linkId: string): void;
  size(): number;
}

export function createRouteProofRegistry(deps: { now?: () => number; generationOf: (linkId: string) => string | undefined }): RouteProofRegistry {
  const now = deps.now ?? Date.now;
  const byLink = new Map<string, { entry: RouteProofEntry; admitted: boolean }>();
  return {
    register(entry) {
      if (!isRouteProofId(entry.proofId)) throw new Error("invalid route proof id");
      const slot = { entry: { ...entry }, admitted: false };
      byLink.set(entry.linkId, slot);
      return {
        admitted: () => slot.admitted,
        dispose: () => { if (byLink.get(entry.linkId) === slot) byLink.delete(entry.linkId); },
      };
    },
    admit(apiKeyId, proofId) {
      if (!isRouteProofId(proofId)) return;
      for (const slot of byLink.values()) {
        const { entry } = slot;
        if (entry.proofId !== proofId) continue;
        if (entry.apiKeyId !== apiKeyId || now() >= entry.expiresAt) return;
        let generation: string | undefined;
        try { generation = deps.generationOf(entry.linkId); } catch { generation = undefined; }
        if (generation !== entry.generation) return;
        slot.admitted = true;
        return;
      }
    },
    forget(linkId) { byLink.delete(linkId); },
    size: () => byLink.size,
  };
}

