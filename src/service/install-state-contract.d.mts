export type {
  AuthoritativeServiceStateRecord,
  ServiceInstallStateRecord,
  ServiceOwnershipRecord as OwnershipClaim,
  ServiceStateRecordEvidence as InstallStateEvidence,
} from "./state-record.mjs";

export {
  SERVICE_OWNERSHIP_MINIMUM_CLI_VERSION,
  SERVICE_OWNERSHIP_PROTOCOL_VERSION,
  selectAuthoritativeServiceState,
  serviceStateFingerprint,
} from "./state-record.mjs";

import type { ServiceStateRecordEvidence } from "./state-record.mjs";

export type OwnershipResolution =
  | { readonly kind: "none"; readonly revision: number; readonly needsRepair?: boolean }
  | { readonly kind: "owned"; readonly ownership: { owner: string; installId: string; consentGeneration: number }; readonly revision: number }
  | { readonly kind: "unknown"; readonly reason: string };

export declare const SERVICE_STATE_FILE: "service-state.json";
export declare function parseOwnershipClaim(value: unknown): import("./state-record.mjs").ServiceOwnershipRecord | null;
export declare function parseInstallStateRecord(value: unknown): import("./state-record.mjs").ServiceInstallStateRecord | null;
export declare function inspectInstallStateBytes(path: string, read: (path: string) => string): ServiceStateRecordEvidence;
export declare function resolveOwnershipFromEvidence(evidence: readonly ServiceStateRecordEvidence[]): OwnershipResolution;
export declare function serviceStateFilesFor(opencodexHomeDir: string, defaultHomeDir: string, platform?: NodeJS.Platform): string[];
