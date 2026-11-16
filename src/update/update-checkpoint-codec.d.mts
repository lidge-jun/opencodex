/** Unauthenticated checkpoint data. These types do not grant update authority. */
export type CheckpointChannel = "latest" | "preview" | "nightly";
export interface CheckpointHistoryEntry {
  previousRevision: number;
  previousDigest: Uint8Array;
  nextRevision: number;
  nextDigest: Uint8Array;
  acceptedAtMs: number;
  rootBytes: Uint8Array;
  envelopeBytes: Uint8Array;
}
export interface CheckpointFloor { sequence: number; releaseDigest: Uint8Array; version: string }
export interface CheckpointObservation { candidateDigest: Uint8Array; firstSeenMs: number }
export interface CheckpointPayload {
  namespaceDigest: Uint8Array;
  principalDigest: Uint8Array;
  ownerKind: "desktop" | "npm" | "pnpm" | "bun" | "standalone" | "service";
  consentGeneration: number;
  identityKind: "posix" | "windows";
  identityBytes: Uint8Array;
  generation: number;
  rootRevision: number;
  rootDigest: Uint8Array;
  rootBytes: Uint8Array;
  history: CheckpointHistoryEntry[];
  channels: Record<CheckpointChannel, CheckpointFloor | null>;
  firstSeen: Record<CheckpointChannel, CheckpointObservation[]>;
  clockHighWaterMs: number;
  securityEpoch: number;
}
export function encodeCheckpointPayload(record: CheckpointPayload): Uint8Array;
export function decodeCheckpointPayload(bytes: Uint8Array): CheckpointPayload;
export function checkpointPayloadDigest(bytes: Uint8Array): string;
