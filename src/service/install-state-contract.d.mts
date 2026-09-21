/** Declaration for the plain-ESM install-state contract shared with `bin/ocx.mjs`. */
export type OwnershipClaim = { owner: string; installId: string; consentGeneration: number };

export type InstallStateEvidence =
  | { path: string; kind: "absent" }
  | { path: string; kind: "unreadable"; reason: string }
  | { path: string; kind: "invalid" }
  | { path: string; kind: "valid"; state: unknown };

export type OwnershipResolution =
  | { kind: "none" }
  | { kind: "owned"; ownership: OwnershipClaim }
  | { kind: "unknown"; reason: string };

export declare const SERVICE_STATE_FILE: string;
export declare function parseOwnershipClaim(value: unknown): OwnershipClaim | null;
/** Returns the validated record, or null. Typed loosely so each runtime applies its own shape. */
export declare function parseInstallStateRecord(value: unknown): unknown;
export declare function inspectInstallStateBytes(path: string, read: (path: string) => string): InstallStateEvidence;
export declare function resolveOwnershipFromEvidence(
  evidence: readonly { path: string; kind: string; reason?: string; state?: unknown }[],
): OwnershipResolution;
export declare function serviceStateFilesFor(opencodexHomeDir: string, defaultHomeDir: string): string[];

