export interface ProvidersConfig {
  port: number;
  defaultProvider: string;
  providers: Record<string, {
    adapter: string;
    baseUrl: string;
    hasApiKey?: boolean;
    hasHeaders?: boolean;
    defaultModel?: string;
    models?: string[];
    liveModels?: boolean;
    upstreamHttpVersion?: "auto" | "http1.1" | "h1" | "http2" | "h2";
    reasoningWireFormat?: "gateway-object";
    authMode?: string;
    keyOptional?: boolean;
    disabled?: boolean;
    note?: string;
    codexAccountMode?: "direct" | "pool";
    xaiResponsesOptInState?: boolean | "mixed";
  }>;
}

export interface OAuthStatus {
  loggedIn: boolean;
  email?: string;
  error?: string;
  done?: boolean;
  needsReauth?: boolean;
  activeAccountId?: string | null;
}

export interface ProviderQuotaReport {
  provider: string;
  quota: import("../codex-quota-utils").AccountQuota;
  source: string;
  updatedAt: number;
}

export interface OAuthAccount {
  id: string;
  alias?: string;
  email?: string;
  active: boolean;
  needsReauth?: boolean;
  expiresAt?: number;
}

const OAUTH_LABELS: Record<string, string> = {
  xai: "xAI (Grok)",
  anthropic: "Anthropic (Claude)",
  kimi: "Kimi (Moonshot)",
  "google-antigravity": "Google Antigravity",
  "github-copilot": "GitHub Copilot",
  cursor: "Cursor",
};

export const oauthLabel = (id: string) => OAUTH_LABELS[id] ?? id;

/**
 * Deterministic identity for the provider config fields the test endpoint depends on.
 * Covers: disabled, authMode, liveModels, adapter, baseUrl, hasHeaders — the full set
 * of config fields that affect `POST /api/providers/test` behavior (see provider-routes.ts
 * lines 797-900: disabled → early return, authMode → forward/oauth branching,
 * liveModels → static_catalog skip, adapter → cursor vs standard path,
 * baseUrl → model discovery URL, hasHeaders → transport static headers).
 *
 * No secrets or API keys are included — hasHeaders is a boolean flag.
 */
export function providerTestInputSnapshot(config: ProvidersConfig): string {
  return Object.entries(config.providers)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, p]) =>
      `${name}:${p.disabled ? 1 : 0}:${p.authMode ?? ""}:${p.liveModels === false ? "0" : "1"}:${p.adapter}:${p.baseUrl}:${p.hasHeaders ? 1 : 0}`,
    )
    .join(";");
}
