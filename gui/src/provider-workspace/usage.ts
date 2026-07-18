/**
 * provider-workspace/usage.ts
 *
 * Pure usage/metrics helpers for the Providers workspace view: model counts,
 * usage totals, relative-time formatting, and the attention list. No network,
 * no React.
 */

import type { WorkspaceSections } from "./catalog";

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

/** Optional label resolver — pass `t` from i18n for localized relative times. */
export type RelativeTimeLabels = {
  justNow: string;
  notChecked: string;
  minutesAgo: (n: number) => string;
  hoursAgo: (n: number) => string;
  daysAgo: (n: number) => string;
};

const EN_RELATIVE: RelativeTimeLabels = {
  justNow: "Just now",
  notChecked: "Not checked",
  minutesAgo: n => `${n}m ago`,
  hoursAgo: n => `${n}h ago`,
  daysAgo: n => `${n}d ago`,
};

export function formatRelativeTime(
  updatedAt: number | undefined,
  labelsOrNow?: RelativeTimeLabels | number,
  nowArg?: number,
): string {
  const labels = typeof labelsOrNow === "object" && labelsOrNow !== null ? labelsOrNow : EN_RELATIVE;
  const now = typeof labelsOrNow === "number" ? labelsOrNow : (nowArg ?? Date.now());
  if (updatedAt === undefined || !Number.isFinite(updatedAt)) return labels.notChecked;
  const elapsedMs = Math.max(0, now - updatedAt);
  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes < 1) return labels.justNow;
  if (minutes < 60) return labels.minutesAgo(minutes);
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return labels.hoursAgo(hours);
  return labels.daysAgo(Math.floor(hours / 24));
}

/** Build RelativeTimeLabels from the app translator. */
export function relativeTimeLabelsFromT(
  t: (key: "time.justNow" | "time.notChecked" | "time.minutesAgo" | "time.hoursAgo" | "time.daysAgo", vars?: Record<string, string | number>) => string,
): RelativeTimeLabels {
  return {
    justNow: t("time.justNow"),
    notChecked: t("time.notChecked"),
    minutesAgo: n => t("time.minutesAgo", { n }),
    hoursAgo: n => t("time.hoursAgo", { n }),
    daysAgo: n => t("time.daysAgo", { n }),
  };
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
export function formatRequestCount(n: number | undefined, locale = "en"): string {
  if (n === undefined) return "\u2014";
  const loc = locale.toLowerCase().slice(0, 2);
  if (loc === "de") {
    const trimDe = (s: string) => s.replace(/\.0+$/, "").replace(".", ",");
    if (n >= 1_000_000_000) return `${trimDe((n / 1_000_000_000).toFixed(2))} Mrd.`;
    if (n >= 1_000_000) return `${trimDe((n / 1_000_000).toFixed(1))} Mio.`;
    if (n >= 1_000) return `${trimDe((n / 1_000).toFixed(1))} Tsd.`;
    return String(n);
  }
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2).replace(/\.?0+$/, "")}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** Same as formatRequestCount but aliased for token quantities (same rules). */
export function formatTokenCount(n: number | undefined, locale = "en"): string {
  return formatRequestCount(n, locale);
}
