/**
 * provider-workspace/types.ts — shared view-model types for the Providers
 * workspace shell/rail/detail (WP080a). Data shapes only; no React.
 */
import type { ProviderSortMode, WorkspaceItem } from "../../provider-workspace/catalog";

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

// Auth types consumed by ProviderAuthPanel (WP091).
export type OAuthAccountRow = {
  id: string;
  email?: string;
  active: boolean;
  needsReauth?: boolean;
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
}

export type ProviderUpdatePatch = {
  adapter?: string;
  baseUrl?: string;
  defaultModel?: string;
  apiKey?: string;
  authMode?: string;
  note?: string;
  disabled?: boolean;
};
