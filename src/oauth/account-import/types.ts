import type { OAuthCredentials } from "../types";

export const ACCOUNT_IMPORT_PROVIDER = "google-antigravity" as const;
export const ACCOUNT_IMPORT_FORMAT = "cockpit-tools" as const;
export const ACCOUNT_IMPORT_MAX_BYTES = 256 * 1024;
// The HTTP request also carries the fixed provider/format envelope. Keep that envelope bounded
// without making a valid document at the 256 KiB contract boundary fail at the API layer.
export const ACCOUNT_IMPORT_MAX_REQUEST_BYTES = ACCOUNT_IMPORT_MAX_BYTES + 1024;
// Shared CLI POST timeout and management-route deadline. Individual provider requests keep
// shorter timeouts; this bounds the full admitted batch (up to ACCOUNT_IMPORT_MAX_RECORDS).
export const ACCOUNT_IMPORT_DEADLINE_MS = 600_000;
export const ACCOUNT_IMPORT_MAX_RECORDS = 25;
export const ACCOUNT_IMPORT_MAX_EMAIL_LENGTH = 254;
export const ACCOUNT_IMPORT_MAX_REFRESH_TOKEN_BYTES = 16 * 1024;

export type AccountImportStatus = "imported" | "updated" | "failed" | "unsupported";

export type AccountImportCode =
  | "imported"
  | "updated"
  | "import_cancelled"
  | "unsupported_provider"
  | "unsupported_format"
  | "invalid_document"
  | "invalid_record"
  | "credential_rejected"
  | "identity_mismatch"
  | "missing_project"
  | "persist_failed";

export interface AccountImportRecordResult {
  index: number;
  status: AccountImportStatus;
  code: AccountImportCode;
}

export interface AccountImportResult {
  totalCount: number;
  importedCount: number;
  updatedCount: number;
  failedCount: number;
  unsupportedCount: number;
  results: AccountImportRecordResult[];
}

export interface AccountImportRequest {
  provider: string;
  format: string;
  document: unknown;
  signal?: AbortSignal;
}

/** A secret-free terminal signal for a cancelled import request. */
export class AccountImportAbortError extends Error {
  constructor() {
    super("Account import cancelled");
    this.name = "AccountImportAbortError";
  }
}

export function throwIfAccountImportAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AccountImportAbortError();
}

export interface CockpitAccountRecord {
  email: string;
  refreshToken: string;
}

export type ParsedCockpitRecord =
  | { index: number; record: CockpitAccountRecord }
  | { index: number; code: "invalid_record" };

export type AccountImportRecordOutcome =
  | { status: "imported"; code: "imported" }
  | { status: "updated"; code: "updated" }
  | {
    status: "failed";
    code: "credential_rejected" | "identity_mismatch" | "missing_project" | "persist_failed";
  };

export interface AccountImportAdapter {
  readonly provider: typeof ACCOUNT_IMPORT_PROVIDER;
  readonly format: typeof ACCOUNT_IMPORT_FORMAT;
  importRecord(record: CockpitAccountRecord, signal?: AbortSignal): Promise<AccountImportRecordOutcome>;
}

export interface ValidatedAntigravityCredential extends OAuthCredentials {
  email?: string;
  projectId?: string;
}
