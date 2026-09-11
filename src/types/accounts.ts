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
  /** OAuth succeeded while quota was exhausted; never route until deferred validation succeeds. */
  codexValidationPending?: boolean;
  /**
   * Set when the recorded failure is TERMINAL: the OAuth grant itself was revoked or has
   * expired, so no retry can recover it and only a re-login will. It distinguishes a dead
   * credential from a transient warmup or probe failure that may clear on its own.
   *
   * Deliberately a separate optional key rather than a third value in
   * `lastCodexValidationStatus`: `isCredentialRecord` admits only `"ok" | "failed"`, so a
   * record carrying an unrecognized status fails validation and is DROPPED from the store
   * on load. An unknown extra key is carried through untouched instead, which keeps a
   * downgrade from deleting the account entry and its credential.
   *
   * Cleared by `markCodexAccountValidated` and — because it is absent from
   * `preservedValidationMetadata` — by every credential write. A refresh that succeeds
   * disproves "the grant was revoked", so the verdict must not outlive it.
   */
  lastCodexValidationTerminal?: boolean;
}
