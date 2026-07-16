/**
 * provider-workspace-data.ts
 *
 * Pure data/view-model helpers for the Providers workspace view.
 * No network calls, no model-count inference -- transforms the proxy config
 * `providers` map into three stable UI sections: ready, needsSetup, disabled.
 *
 * Binning rules (applied in priority order):
 *  1. disabled === true              -> disabled
 *  2. keyOptional === true           -> ready  (key not required — not the same as free pricing)
 *  3. authMode === "oauth"           -> ready  (credentials managed externally)
 *  4. authMode === "forward"         -> ready  (passes caller credentials through)
 *  5. authMode === "local"           -> ready  (local runtime, no key required)
 *  6. loopback base URL              -> ready  (local runtime, auth mode may be stripped)
 *  7. hasApiKey === true             -> ready  (key-auth with credential present)
 *  8. everything else                -> needsSetup
 *
 * Pricing (Free badge / Free filter) is separate: see `isFreeProvider` (`freeTier` or keyless free).
 */

/**
 * Shape of a single provider value as it appears in the proxy config map.
 * The provider name is the Record key, not a field here.
 */
export interface WorkspaceProvider {
  adapter: string;
  baseUrl: string;
  hasApiKey?: boolean;
  hasHeaders?: boolean;
  defaultModel?: string;
  authMode?: "key" | "forward" | "oauth" | "local" | string;
  keyOptional?: boolean;
  /** Free pricing (may still require an API key). */
  freeTier?: boolean;
  disabled?: boolean;
  note?: string;
}

/**
 * A provider item as surfaced to the workspace view.
 * Extends WorkspaceProvider with the name resolved from the Record key.
 */
export interface WorkspaceItem extends WorkspaceProvider {
  name: string;
}

/** The three sections rendered in the Providers workspace. */
export interface WorkspaceSections {
  /** Providers that are enabled and have all credentials needed to route requests. */
  ready: WorkspaceItem[];
  /** Enabled providers that are missing required credentials (e.g. an API key). */
  needsSetup: WorkspaceItem[];
  /** Providers explicitly disabled by the user. */
  disabled: WorkspaceItem[];
}

function hasLoopbackBaseUrl(baseUrl: string): boolean {
  try {
    const hostname = new URL(baseUrl).hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  } catch {
    return false;
  }
}

function isConfigurationReady(p: WorkspaceProvider): boolean {
  return p.keyOptional === true ||
    p.authMode === "oauth" ||
    p.authMode === "forward" ||
    p.authMode === "local" ||
    hasLoopbackBaseUrl(p.baseUrl) ||
    p.hasApiKey === true;
}

/**
 * Free pricing (badge / filter / sort): `freeTier`, keyless free (`keyOptional`),
 * local runtimes, or loopback. Does **not** imply ready-without-key — use
 * `isConfigurationReady` / `binProviderStatus` for that.
 */
export function isFreeProvider(p: WorkspaceProvider): boolean {
  return p.freeTier === true
    || p.keyOptional === true
    || p.authMode === "local"
    || hasLoopbackBaseUrl(p.baseUrl);
}

export function isPaidProvider(p: WorkspaceProvider): boolean {
  return !isFreeProvider(p);
}

/** Rail / list sort modes for the providers workspace. */
export type ProviderSortMode = "az" | "za" | "free-paid" | "paid-free";

export function sortWorkspaceItems(items: WorkspaceItem[], mode: ProviderSortMode): WorkspaceItem[] {
  const copy = [...items];
  const byName = (a: WorkspaceItem, b: WorkspaceItem) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  switch (mode) {
    case "az":
      return copy.sort(byName);
    case "za":
      return copy.sort((a, b) => byName(b, a));
    case "free-paid":
      return copy.sort((a, b) => {
        const af = isFreeProvider(a) ? 0 : 1;
        const bf = isFreeProvider(b) ? 0 : 1;
        return af - bf || byName(a, b);
      });
    case "paid-free":
      return copy.sort((a, b) => {
        const af = isFreeProvider(a) ? 1 : 0;
        const bf = isFreeProvider(b) ? 1 : 0;
        return af - bf || byName(a, b);
      });
    default:
      return copy;
  }
}

/**
 * Transforms the proxy config `providers` map into the three workspace sections.
 * Iteration order follows `Object.entries` (insertion order).
 */
export function buildProviderWorkspace(
  providers: Record<string, WorkspaceProvider>,
): WorkspaceSections {
  const ready: WorkspaceItem[] = [];
  const needsSetup: WorkspaceItem[] = [];
  const disabled: WorkspaceItem[] = [];

  for (const [name, p] of Object.entries(providers)) {
    const item: WorkspaceItem = { name, ...p };
    if (p.disabled) {
      disabled.push(item);
      continue;
    }
    if (isConfigurationReady(p)) {
      ready.push(item);
    } else {
      needsSetup.push(item);
    }
  }

  return { ready, needsSetup, disabled };
}

// ---------------------------------------------------------------------------
// Legacy aliases -- kept so any existing imports of the v1 names still compile.
// ---------------------------------------------------------------------------

/** @deprecated Use WorkspaceProvider instead. */
export interface ProviderRecord extends WorkspaceProvider {
  name: string;
  hasApiKey: boolean;
  hasHeaders: boolean;
  keyOptional: boolean;
  disabled: boolean;
}

/** @deprecated Use WorkspaceSections instead. */
export type ProviderWorkspaceSections = WorkspaceSections;

/** @deprecated Use buildProviderWorkspace instead. */
export function buildProviderWorkspaceSections(
  providers: ProviderRecord[],
): WorkspaceSections {
  const map: Record<string, WorkspaceProvider> = {};
  for (const p of providers) {
    const { name, ...rest } = p;
    map[name] = rest;
  }
  return buildProviderWorkspace(map);
}

// ---------------------------------------------------------------------------
// New v2 pure-data helpers for the alternate workspace view
// ---------------------------------------------------------------------------

/** Canonical status string for a single provider — no network, pure config. */
export type ProviderStatus = "ready" | "needs-setup" | "disabled";

/**
 * Returns the canonical status for a single WorkspaceProvider (or WorkspaceItem).
 * Applies the same priority rules as buildProviderWorkspace.
 */
export function binProviderStatus(p: WorkspaceProvider): ProviderStatus {
  if (p.disabled) return "disabled";
  if (isConfigurationReady(p)) return "ready";
  return "needs-setup";
}

/**
 * Per-provider model count as returned by /api/selected-models.
 * The endpoint shape is { available: Record<string, unknown[]> }.
 */
export type ProviderModelCounts = Record<string, number>;
export type ProviderAvailableModels = Record<string, string[]>;
export type ProviderSelectedModels = Record<string, string[]>;

/** Parse `/api/selected-models` available map into provider -> model id list. */
export function parseAvailableModels(data: unknown): ProviderAvailableModels {
  if (!data || typeof data !== "object") return {};
  const available = (data as { available?: unknown }).available;
  if (!available || typeof available !== "object" || Array.isArray(available)) return {};

  const models: ProviderAvailableModels = {};
  for (const [provider, ids] of Object.entries(available)) {
    if (!Array.isArray(ids)) continue;
    models[provider] = ids.filter((id): id is string => typeof id === "string");
  }
  return models;
}

/** Parse `/api/selected-models` selected allowlist map into provider -> model id list. */
export function parseSelectedModels(data: unknown): ProviderSelectedModels {
  if (!data || typeof data !== "object") return {};
  const selected = (data as { selected?: unknown }).selected;
  if (!selected || typeof selected !== "object" || Array.isArray(selected)) return {};

  const models: ProviderSelectedModels = {};
  for (const [provider, ids] of Object.entries(selected)) {
    if (!Array.isArray(ids)) continue;
    models[provider] = ids.filter((id): id is string => typeof id === "string");
  }
  return models;
}

export function countAvailableModels(data: unknown): ProviderModelCounts {
  const counts: ProviderModelCounts = {};
  for (const [provider, models] of Object.entries(parseAvailableModels(data))) {
    counts[provider] = models.length;
  }
  return counts;
}

/**
 * Per-provider usage totals derived from /api/usage?range=30d.
 * The endpoint shape is { providers: Array<{ provider: string; requests: number; totalTokens: number }> }.
 */
export interface ProviderUsageTotals {
  requests?: number;
  totalTokens?: number;
}

export interface MostUsedProvider extends ProviderUsageTotals {
  name: string;
  requests: number;
}

export function buildMostUsedProviders(
  usageTotals: Record<string, ProviderUsageTotals>,
): MostUsedProvider[] {
  return Object.entries(usageTotals)
    .filter((entry): entry is [string, ProviderUsageTotals & { requests: number }] =>
      typeof entry[1].requests === "number" && entry[1].requests > 0)
    .map(([name, totals]) => ({ name, ...totals, requests: totals.requests }))
    .sort((a, b) => b.requests - a.requests || a.name.localeCompare(b.name));
}

export function formatRelativeTime(updatedAt: number | undefined, now = Date.now()): string {
  if (updatedAt === undefined || !Number.isFinite(updatedAt)) return "Not checked";
  const elapsedMs = Math.max(0, now - updatedAt);
  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** An entry in the "Attention required" list shown in the overview panel. */
export interface AttentionItem {
  name: string;
  reason: string;
}

/**
 * Derives the list of providers that require user attention:
 * - needsSetup providers → "Missing credentials"
 * - disabled providers that have an explicit override reason in `overrideReasons`
 *
 * Ready providers are never included.
 */
export function buildAttentionItems(
  sections: WorkspaceSections,
  overrideReasons: Record<string, string>,
): AttentionItem[] {
  const items: AttentionItem[] = [];
  for (const p of sections.needsSetup) {
    items.push({ name: p.name, reason: overrideReasons[p.name] ?? "Missing credentials" });
  }
  for (const p of sections.disabled) {
    const reason = overrideReasons[p.name];
    if (reason) items.push({ name: p.name, reason });
  }
  return items;
}

/**
 * Format a raw request/token count for display.
 * Returns "—" when the value is undefined (data unavailable).
 */
export function formatRequestCount(n: number | undefined): string {
  if (n === undefined) return "\u2014";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** Same as formatRequestCount but aliased for token quantities (same rules). */
export function formatTokenCount(n: number | undefined): string {
  return formatRequestCount(n);
}
