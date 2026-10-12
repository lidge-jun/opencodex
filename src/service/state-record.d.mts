export interface ServiceOwnershipRecord {
  readonly owner: "cli" | "desktop";
  readonly installId: string;
  readonly consentGeneration: number;
  readonly [key: string]: unknown;
}

export declare const SERVICE_OWNERSHIP_PROTOCOL_VERSION: 1;
export declare const SERVICE_OWNERSHIP_MINIMUM_CLI_VERSION: "2.61.0";

export interface ServiceInstallStateRecord {
  readonly version: 1 | 2;
  readonly codexHome: string;
  readonly opencodexHome: string;
  readonly revision?: number;
  readonly ownership?: ServiceOwnershipRecord;
  readonly [key: string]: unknown;
}

export type ServiceStateRecordEvidence =
  | { readonly path: string; readonly kind: "absent" }
  | { readonly path: string; readonly kind: "unreadable"; readonly reason: string }
  | { readonly path: string; readonly kind: "invalid" }
  | { readonly path: string; readonly kind: "valid"; readonly state: ServiceInstallStateRecord };

export type AuthoritativeServiceStateRecord =
  | { readonly kind: "none"; readonly revision: 0; readonly needsRepair: false }
  | { readonly kind: "state"; readonly state: ServiceInstallStateRecord; readonly revision: number; readonly needsRepair: boolean }
  | { readonly kind: "unknown"; readonly reason: string };

export declare function parseServiceOwnershipRecord(value: unknown): ServiceOwnershipRecord | null;
export declare function parseServiceInstallStateRecord(value: unknown): ServiceInstallStateRecord | null;
export declare function serviceStatePathsForHomes(opencodexHome: string, defaultOpenCodexHome: string, platform?: NodeJS.Platform): string[];
export declare function inspectServiceStateRecords(paths: readonly string[], read?: (path: string) => string): readonly ServiceStateRecordEvidence[];
export declare function serviceStateFingerprint(value: unknown): string;
export declare function selectAuthoritativeServiceState(evidence: readonly ServiceStateRecordEvidence[]): AuthoritativeServiceStateRecord;
