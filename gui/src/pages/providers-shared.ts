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
  "meta-muse": "Meta Muse Code (CLI)",
  "google-antigravity": "Google Antigravity",
  "github-copilot": "GitHub Copilot",
  cursor: "Cursor",
};

export const oauthLabel = (id: string) => OAUTH_LABELS[id] ?? id;
