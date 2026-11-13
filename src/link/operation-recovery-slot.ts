import type { ExplicitRoute } from "./explicit-route";

/**
 * Core-owned slot through which the enrollment journal (lane O1, ocx link add --operation-id) lets
 * ocx link recover --operation-id find the Child an enrollment left behind before it reached
 * links.json. Nothing registers here until that journal ships; recover then answers
 * operation_journal_unavailable.
 *
 * Contract for the journal: lookup answers the operation's reserved link id, alias, pinned host-key
 * fingerprint and platform when its outcome is residual (or unknown with a reserved link id);
 * settle is called after the Child's receipt proved cleanup, so the journal can record that and
 * start its retention clock. Both run synchronously and never touch SSH.
 */
export interface LinkRecoveryTarget {
  linkId: string;
  alias: string;
  hostKeyFingerprint: string;
  remotePlatform?: "posix" | "windows";
  /** The link's explicit route (O6), or absent for an ssh_config alias. */
  explicitRoute?: ExplicitRoute;
}

export type OperationRecoveryLookup =
  | { kind: "target"; target: LinkRecoveryTarget }
  | { kind: "not_found" }
  | { kind: "not_residual" };

export interface OperationRecoveryResolver {
  lookup(operationId: string): OperationRecoveryLookup;
  settle(operationId: string): void;
}

let registered: OperationRecoveryResolver | null = null;

/** Register the journal's resolver; returns the unregister function. */
export function registerOperationRecoveryResolver(resolver: OperationRecoveryResolver): () => void {
  registered = resolver;
  return () => { if (registered === resolver) registered = null; };
}

/** The registered resolver, or null when no enrollment journal is available. */
export function operationRecoveryResolver(): OperationRecoveryResolver | null {
  return registered;
}
