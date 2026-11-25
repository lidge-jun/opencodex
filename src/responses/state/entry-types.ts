import type { OcxProviderContinuationState } from "../../types";
import type { ResponseSpillRef } from "../spill-store";
import type { ConnectionReplayScope } from "./connection-scope";

export interface ResidentResponseState {
  kind: "resident";
  createdAt: number;
  clientThreadId?: string;
  replayOwnerKey?: string;
  /** Memory-only: connection-owned entries never spill, demote or enter the snapshot. */
  connectionOwned?: true;
  /** Issued scope for cap bookkeeping and the handshake deadline. */
  connectionScope?: ConnectionReplayScope;
  items: unknown[];
  /** Index in `items` where provider output begins; see clientCarriedPrefixLength. */
  providerOutputStart?: number;
  providers?: OcxProviderContinuationState;
  unforcedStoreFalse?: boolean;
  sizeBytes: number;
}

export interface SpilledResponseState {
  kind: "spill";
  createdAt: number;
  clientThreadId?: string;
  replayOwnerKey?: string;
  /** Mirrors the spilled payload boundary so a spilled entry keeps its anchor. */
  providerOutputStart?: number;
  providers?: OcxProviderContinuationState;
  unforcedStoreFalse?: boolean;
  spill: ResponseSpillRef;
  sizeBytes: number;
}

export interface SpillFailedResponseState {
  kind: "spill-failed";
  createdAt: number;
  sizeBytes: number;
}

export type StoredResponseState = ResidentResponseState | SpilledResponseState | SpillFailedResponseState;
export type ResidentInput = Omit<ResidentResponseState, "kind" | "sizeBytes">;

export type PreviousResponseReplayFailure = {
  code: "previous_response_not_found";
  reason: "spill_missing" | "spill_corrupt" | "spill_failed" | "spill_too_large" | "scope_mismatch" | "missing";
};
