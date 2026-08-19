export interface CodexAccount {
  id: string;
  email: string;
  /** User-owned display label; never participates in routing or identity checks. */
  alias?: string;
  plan?: string;
  /**
   * Provenance of `plan`. WHAM (live quota API) is authoritative; the JWT
   * `chatgpt_plan_type` claim is a fallback that may lag a plan change. A JWT write
   * must never overwrite a WHAM-sourced plan observed for the same credential
   * generation — only a newer generation (token refresh after the WHAM read) may.
   */
  planSource?: "jwt" | "wham";
  /** Credential generation at which `plan`/`planSource` was recorded. */
  planCredentialGeneration?: number;
  chatgptAccountId?: string;
  logLabel?: string;
  isMain: boolean;
}

export interface CodexAccountCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  chatgptAccountId: string;
}

export interface CodexAccountCredentialRecord {
  credential?: CodexAccountCredentials;
  generation: number;
  refreshGrantFingerprint?: string;
  deletedAt?: number;
  replacedAt?: number;
  lastCodexValidatedAt?: number;
  lastCodexValidationStatus?: "ok" | "failed";
  lastCodexValidationError?: string;
}
