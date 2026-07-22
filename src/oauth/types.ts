/** Minimal OAuth types, ported from jawcode packages/ai/src/utils/oauth/types.ts. */
export type OAuthCredentialSource = "oauth" | "local-cli" | "credential-file" | "environment" | "manual";

export type OAuthCredentials = {
  refresh: string;
  access: string;
  expires: number; // epoch ms (already skew-adjusted by the provider flow)
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
