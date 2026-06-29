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
};

export interface OAuthController {
  onAuth?(info: { url: string; instructions?: string }): void;
  onProgress?(message: string): void;
  onManualCodeInput?(): Promise<string>;
  signal?: AbortSignal;
}

/**
 * How a login flow may use a locally detected CLI token.
 * "off" goes straight to the real OAuth flow, "fallback" imports a local token when present
 * and falls back to OAuth otherwise, "only" imports without any OAuth fallback.
 */
export type LocalTokenImportMode = "off" | "fallback" | "only";
