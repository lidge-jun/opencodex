export type NativeProfileErrorCode =
  | "INVALID_REQUEST"
  | "CODEX_HOME_UNAVAILABLE"
  | "UNSUPPORTED_AUTH_STORE"
  | "AUTH_MISSING"
  | "AUTH_INVALID"
  | "AUTH_UNREADABLE"
  | "AUTH_TEMP_CLEANUP_REQUIRED"
  | "ACTIVE_PROFILE_MISMATCH"
  | "PROFILE_NOT_FOUND"
  | "PROFILE_ALREADY_EXISTS"
  | "PROFILE_DECRYPT_FAILED"
  | "KEYRING_UNAVAILABLE"
  | "KEYRING_KEY_MISSING"
  | "PROFILE_LOCK_UNAVAILABLE"
  | "NATIVE_PROFILE_BUSY"
  | "NATIVE_MAIN_OWNER_BUSY"
  | "NATIVE_MAIN_OWNER_UNAVAILABLE"
  | "NATIVE_MAIN_CLAIM_BUSY"
  | "NATIVE_MAIN_CLAIM_UNAVAILABLE"
  | "CODEX_BUSY"
  | "CODEX_PROCESS_CHECK_UNAVAILABLE"
  | "MAIN_REQUESTS_ACTIVE"
  | "RECOVERY_REQUIRED"
  | "AUTH_RESTORE_FAILED"
  | "SWITCH_ROLLED_BACK"
  | "STAGING_NOT_FOUND"
  | "STAGING_EXPIRED"
  | "STAGING_TERMINAL"
  | "STAGING_CLEANUP_REQUIRED"
  | "PROFILE_METADATA_TOO_LARGE"
  | "PROFILE_STORAGE_UNSAFE"
  | "LEGACY_PROFILE_STATE"
  | "INTERNAL_ERROR"
  | "VAULT_INVALID";

export class NativeProfileError extends Error {
  constructor(
    readonly code: NativeProfileErrorCode,
    message: string,
    readonly status = 409,
    readonly retryable = false,
    readonly cleanupRequired?: true,
    readonly plaintextMayRemain?: boolean,
  ) {
    super(message);
    this.name = "NativeProfileError";
  }
}

export type NativeProfileState = "active" | "inactive";

export interface EncryptedNativeEnvelopeV1 {
  cipher: "aes-256-gcm";
  keyRef: string;
  nonce: string;
  ciphertext: string;
  tag: string;
  envelopeSha256: string;
}

export interface NativeMainProfileRecordV1 {
  id: string;
  label: string;
  identityHash: string;
  identityHint: string;
  state: NativeProfileState;
  payload: EncryptedNativeEnvelopeV1 | null;
  createdAt: string;
  updatedAt: string;
}

export interface NativeMainProfileVaultV1 {
  version: 1;
  revision: number;
  homeId: string;
  activeProfileId: string | null;
  profiles: NativeMainProfileRecordV1[];
}

export const NATIVE_PROFILE_JOURNAL_PHASES = [
  "prepared",
  "auth-replaced",
  "vault-committed",
] as const;

export type NativeProfileJournalPhase = (typeof NATIVE_PROFILE_JOURNAL_PHASES)[number];

export interface NativeProfileSwitchJournalV1 {
  version: 1;
  transactionId: string;
  homeId: string;
  phase: NativeProfileJournalPhase;
  sourceProfileId: string;
  sourceIdentityHash: string;
  sourcePayload: EncryptedNativeEnvelopeV1;
  targetProfileId: string;
  targetIdentityHash: string;
  targetPayload: EncryptedNativeEnvelopeV1;
  beforeVault: NativeMainProfileVaultV1;
  afterVault: NativeMainProfileVaultV1;
  createdAt: string;
}

export interface NativeProfilePublic {
  id: string;
  label: string;
  identityHint: string;
  state: NativeProfileState;
}

export interface NativeProfileKey {
  keyRef: string;
  key: Uint8Array;
}

export interface NativeProfileKeyProvider {
  get(homeId: string): Promise<NativeProfileKey | null>;
  create(homeId: string): Promise<NativeProfileKey>;
}
