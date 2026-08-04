/** Minimal OAuth types, ported from jawcode packages/ai/src/utils/oauth/types.ts. */
export type OAuthCredentialSource = "oauth" | "local-cli" | "credential-file" | "environment" | "manual";

/** Account-scoped Kiro data required for refresh and request routing. */
export interface KiroOAuthMetadata {
  profileArn?: string;
  ssoRegion?: string;
  apiRegion?: string;
  clientId?: string;
  clientSecret?: string;
}

export type OAuthCredentials = {
  refresh: string;
  access: string;
  /** Epoch ms after any small provider-specific early-refresh margin; the shared gate adds 1 minute. */
  expires: number;
  email?: string;
  accountId?: string;
  source?: OAuthCredentialSource;
  /** Google Antigravity (Cloud Code Assist) discovered project id; injected into the CCA envelope. */
  projectId?: string;
  /**
   * GitHub Copilot allowlisted API origin from token `endpoints.api` (HTTPS `*.githubcopilot.com` only).
   * Never reuse for Antigravity projectId; validated on write and again at request time.
   */
  apiBaseUrl?: string;
  /** Never returned by management APIs; persisted only inside the protected auth-store boundary. */
  kiro?: KiroOAuthMetadata;
};

/** One logged-in account inside a provider's account set (multiauth). */
export interface ProviderAccount {
  /** Stable short id, generated once at append time; never re-derived after rotation. */
  id: string;
  /** User-owned display label; never participates in auth identity or routing. */
  alias?: string;
  credential: OAuthCredentials;
  /** Terminal refresh failure (invalid_grant / reused / revoked) — re-login required. */
  needsReauth?: boolean;
  addedAt?: number;
}

/** auth.json value per provider: N accounts + which one requests use. */
export interface ProviderAccountSet {
  activeAccountId: string;
  accounts: ProviderAccount[];
}

export interface OAuthController {
  onAuth?(info: { url: string; instructions?: string; deviceCode?: string }): void;
  onProgress?(message: string): void;
  onManualCodeInput?(expectedState?: string): Promise<string>;
  signal?: AbortSignal;
}

/**
 * How a login flow may use a locally detected CLI token.
 * "off" goes straight to the real OAuth flow, "fallback" imports a local token when present
 * and falls back to OAuth otherwise, "only" imports without any OAuth fallback.
 */
export type LocalTokenImportMode = "off" | "fallback" | "only";
