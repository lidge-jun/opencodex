/**
 * provider-workspace/types.ts — shared view-model types for the Providers
 * workspace shell/rail/detail (WP080a). Data shapes only; no React.
 */
import type { ProviderSortMode, WorkspaceItem } from "../../provider-workspace/catalog";
import type { AccountQuota } from "../../codex-quota-utils";

export type { ProviderSortMode, WorkspaceItem };

/** Rail status facets (all on by default). */
export type StatusFilter = { ready: boolean; needsSetup: boolean; disabled: boolean };

/** Rail pricing facets. */
export type PricingFilter = { free: boolean; paid: boolean };

/**
 * Rail type facets. `login` covers oauth/forward providers — deliberately NOT
 * named "account" to avoid colliding with the accounts TIER (canonical openai only).
 */
export type TypeFilter = { cloud: boolean; local: boolean; selfHosted: boolean; login: boolean };

/** Per-provider usage totals for the workspace overview (30d window). */
export interface ProviderUsageTotals {
  requests?: number;
  totalTokens?: number;
}

/** Per-model usage row from /api/usage, filtered by provider. */
export interface ProviderModelUsageRow {
  model: string;
  resolvedModel?: string;
  requests: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  shareRatio: number;
  estimatedCostUsd?: number;
}

// Auth types consumed by ProviderAuthPanel (WP091).
export type OAuthAccountHealthStatus = "healthy" | "cooldown" | "reauth_required" | "warning";

export type OAuthAccountRow = {
  id: string;
  alias?: string;
  email?: string;
  active: boolean;
  needsReauth?: boolean;
  health?: { status: OAuthAccountHealthStatus; reason?: string; until?: string };
  healthLabel?: string;
  healthSummary?: string;
  healthAction?: string;
  /** Per-account rate limits, for providers that report usage per credential (anthropic). */
  quota?: AccountQuota | null;
  quotaUnavailable?: boolean;
};

export type ApiKeyRow = {
  id: string;
  label?: string;
  masked: string;
  active: boolean;
};

export type LoginHint = {
  provider: string;
  url?: string;
  instructions?: string;
  deviceCode?: string;
};

export type AccountLoadState = "idle" | "loading" | "ready" | "error";

export interface ProviderAuthHandlers {
  onLogin: (provider: string, addAccount?: boolean) => void | Promise<void>;
  onCancelLogin?: (provider: string) => void;
  onLogout: (provider: string) => void | Promise<void>;
  onReauth: (provider: string, accountId?: string) => void | Promise<void>;
  onSwitchAccount: (provider: string, account: OAuthAccountRow) => void | Promise<void>;
  onRemoveAccount: (provider: string, account: OAuthAccountRow) => void | Promise<void>;
  onRetryAccounts?: (provider: string) => void | Promise<void>;
  onAddApiKey: (provider: string, key: string) => Promise<boolean>;
  onSwitchApiKey: (provider: string, entry: ApiKeyRow) => void | Promise<void>;
  onRemoveApiKey: (provider: string, entry: ApiKeyRow) => void | Promise<void>;
  onEditAlias: (provider: string, type: "oauth" | "api-key", id: string, current?: string) => void | Promise<void>;
}

export type ProviderUpdatePatch = {
  /** A standalone routing change; the management API rejects combinations with edits. */
  setDefault?: true;
  adapter?: string;
  baseUrl?: string;
  defaultModel?: string;
  apiKey?: string;
  apiKeyTransport?: "x-api-key" | "bearer" | "";
  authMode?: string;
  note?: string;
  disabled?: boolean;
  allowPrivateNetwork?: boolean;
  liveModels?: boolean;
  upstreamHttpVersion?: "auto" | "http1.1" | "h1" | "http2" | "h2" | null;
  requestPacing?: WorkspaceItem["requestPacing"] | null;
  /** Dedicated field: the API PATCHes it alone for the canonical `openai` provider. */
  codexAccountMode?: "direct" | "pool";
  /** Management-only write that atomically owns the two supported xAI Grok adapter rows. */
  xaiResponsesOptIn?: boolean;
};

export type ProviderUpdateResult = {
  ok: boolean;
  error?: string;
  xaiResponsesOptInState?: WorkspaceItem["xaiResponsesOptInState"];
};
