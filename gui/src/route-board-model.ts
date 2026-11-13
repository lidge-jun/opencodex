/**
 * Pure view model for the Combos overview (route board): one row per combo, its channels in
 * routing order, and what each channel's provider has left. No React, no fetch.
 *
 * The layout follows the "one row per model group" idea of Magpie's routing page
 * (MIT, Copyright (c) 2026 yetone). No code is taken from it.
 */
import {
  COMBO_STRATEGIES,
  type ComboDraftError,
  type ComboItem,
  type ComboStrategy,
  comboPublicModelId,
} from "./combo-workspace-data";
import type { TKey } from "./i18n/shared";
import { freshQuotaReportsFromResponse } from "./provider-workspace/report";
import { buildQuotaSummary, type QuotaSummaryWindow } from "./quota-summary";

/** What `/api/models` says about one combo row (`provider === "combo"`). */
export interface ComboCatalogMeta {
  displayName?: string;
  contextWindow?: number;
  disabled: boolean;
}

export interface RouteBoardProvider {
  name: string;
  disabled?: boolean;
  authMode?: string;
}

export type QuotaTone = "ok" | "warn" | "low";

export interface QuotaWindowView {
  id: string;
  /** Fixed window name; otherwise `label` is the provider's own window name. */
  labelKey?: TKey;
  label?: string;
  remainingPercent: number;
  tone: QuotaTone;
}

/** Subscription windows, a pay-per-use key, or nothing reported. */
export type ChannelQuota =
  | { kind: "windows"; windows: QuotaWindowView[]; accounts?: number }
  | { kind: "metered" }
  | { kind: "unknown" };

export interface RouteChannel {
  key: string;
  provider: string;
  model: string;
  lastResort: boolean;
  providerDisabled: boolean;
}

export interface ProviderQuotaLine {
  provider: string;
  quota: ChannelQuota;
}

export interface RouteRow {
  combo: ComboItem;
  publicId: string;
  displayName: string;
  channels: RouteChannel[];
  /** One entry per distinct provider, in first-use order. */
  quotas: ProviderQuotaLine[];
  contextWindow?: number;
  enabled: boolean;
  lastResortCount: number;
}

export const ROUTE_BOARD_STRATEGIES: readonly ComboStrategy[] = COMBO_STRATEGIES;

export function channelKey(provider: string, model: string): string {
  return `${provider}\u0000${model}`;
}

/** Remaining-percent colour: green above 50%, amber from 20% to 50%, red below 20%. */
export function quotaTone(remainingPercent: number): QuotaTone {
  if (remainingPercent > 50) return "ok";
  if (remainingPercent >= 20) return "warn";
  return "low";
}

const WINDOW_ORDER: TKey[] = ["quota.weeklyLimit", "quota.fiveHourLimit", "quota.monthlyLimit"];

function windowFamily(window: QuotaSummaryWindow): string {
  return (window.label ?? "").toLowerCase().split(/[\s(]/)[0] ?? "";
}

/**
 * The windows that matter for this provider's models in this combo, at most two.
 *
 * A provider such as Antigravity reports one window per model family ("Gem", "Cla (Weekly)").
 * A Claude channel must not show the Gemini window, so a window that names a family or a model
 * is kept only when a channel's model belongs to it.
 */
function pickWindows(windows: QuotaSummaryWindow[], models: readonly string[]): QuotaSummaryWindow[] {
  const measured = windows.filter((window) => window.percent !== undefined);
  const lowered = models.map((model) => model.toLowerCase());
  const relevant = measured.filter((window) => {
    if (window.modelId !== undefined) return lowered.includes(window.modelId.toLowerCase());
    if (window.labelKey !== undefined) return true;
    const family = windowFamily(window);
    return family.length >= 3 && lowered.some((model) => model.startsWith(family));
  });
  const generic = measured.filter((window) => window.labelKey !== undefined || window.modelId === undefined);
  const pool = relevant.length > 0 ? relevant : generic;
  const rank = (window: QuotaSummaryWindow) => {
    if (window.modelId !== undefined) return -1;
    const fixed = window.labelKey ? WINDOW_ORDER.indexOf(window.labelKey) : -1;
    if (fixed >= 0) return fixed;
    return /week/i.test(window.label ?? "") ? 0.5 : WINDOW_ORDER.length;
  };
  return [...pool].sort((a, b) => rank(a) - rank(b)).slice(0, 2);
}

function accountCount(aggregation: unknown): number | undefined {
  if (!aggregation || typeof aggregation !== "object") return undefined;
  const { includedAccounts, excludedAccounts } = aggregation as Record<string, unknown>;
  if (typeof includedAccounts !== "number") return undefined;
  const total = includedAccounts + (typeof excludedAccounts === "number" ? excludedAccounts : 0);
  return total > 1 ? total : undefined;
}

/** Parse `/api/provider-quotas` `reports` once per render into provider → windows. */
export function quotaWindowsByProvider(
  reports: unknown,
  now = Date.now(),
): Map<string, { windows: QuotaSummaryWindow[]; accounts?: number }> {
  const fresh = freshQuotaReportsFromResponse(reports, now);
  const out = new Map<string, { windows: QuotaSummaryWindow[]; accounts?: number }>();
  for (const row of buildQuotaSummary(fresh, (provider) => provider)) {
    if (row.passive) continue;
    const accounts = accountCount(fresh[row.provider]?.aggregation);
    out.set(row.provider, { windows: row.windows, ...(accounts !== undefined ? { accounts } : {}) });
  }
  return out;
}

export function channelQuota(
  provider: RouteBoardProvider | undefined,
  reported: { windows: QuotaSummaryWindow[]; accounts?: number } | undefined,
  models: readonly string[],
): ChannelQuota {
  const windows = reported ? pickWindows(reported.windows, models) : [];
  if (windows.length > 0) {
    return {
      kind: "windows",
      windows: windows.map((window) => {
        const remainingPercent = Math.max(0, Math.min(100, 100 - (window.percent ?? 0)));
        return {
          id: window.id,
          ...(window.labelKey ? { labelKey: window.labelKey } : { label: window.label ?? window.id }),
          remainingPercent,
          tone: quotaTone(remainingPercent),
        };
      }),
      ...(reported?.accounts !== undefined ? { accounts: reported.accounts } : {}),
    };
  }
  if (provider?.authMode === "key") return { kind: "metered" };
  return { kind: "unknown" };
}

export function buildRouteRows(input: {
  combos: readonly ComboItem[];
  catalog: Readonly<Record<string, ComboCatalogMeta>>;
  lastResort: Readonly<Record<string, readonly string[]>>;
  providers: readonly RouteBoardProvider[];
  quotaReports: unknown;
  now?: number;
}): RouteRow[] {
  const providers = new Map(input.providers.map((provider) => [provider.name, provider]));
  const reported = quotaWindowsByProvider(input.quotaReports, input.now);
  return input.combos.map((combo) => {
    const lastResort = new Set(input.lastResort[combo.id] ?? []);
    const channels = combo.targets.map((target) => {
      const key = channelKey(target.provider, target.model);
      return {
        key,
        provider: target.provider,
        model: target.model,
        lastResort: lastResort.has(key),
        providerDisabled: providers.get(target.provider)?.disabled === true,
      };
    });
    const quotas: ProviderQuotaLine[] = [];
    for (const channel of channels) {
      if (quotas.some((line) => line.provider === channel.provider)) continue;
      const models = channels.filter((c) => c.provider === channel.provider).map((c) => c.model);
      quotas.push({
        provider: channel.provider,
        quota: channelQuota(providers.get(channel.provider), reported.get(channel.provider), models),
      });
    }
    const meta = input.catalog[combo.id];
    const publicId = comboPublicModelId(combo.id, combo.alias);
    return {
      combo,
      publicId,
      displayName: combo.displayName?.trim() || meta?.displayName?.trim() || combo.id,
      channels,
      quotas,
      ...(meta?.contextWindow !== undefined ? { contextWindow: meta.contextWindow } : {}),
      enabled: meta ? !meta.disabled : true,
      lastResortCount: channels.filter((channel) => channel.lastResort).length,
    };
  });
}

/**
 * Provider labels for one row. Two providers can share a display name (`anthropic` and
 * `anthropic-apikey` are both "Anthropic Claude"); the later one gets its id appended.
 */
export function distinctProviderLabels(
  providers: readonly string[],
  display: (provider: string) => string,
): Map<string, string> {
  const labels = new Map<string, string>();
  const taken = new Set<string>();
  for (const provider of providers) {
    if (labels.has(provider)) continue;
    const name = display(provider);
    labels.set(provider, taken.has(name) ? `${name} (${provider})` : name);
    taken.add(name);
  }
  return labels;
}

/** `1M`, `200K`, `128K`. */
export function formatContextWindow(tokens: number): string {
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000;
    return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`;
  }
  return `${Math.round(tokens / 1000)}K`;
}

/**
 * What picking a strategy in the row menu does.
 *
 * JEV never saves from the row: with no decision service chosen it hands requests to the
 * hosted TypeSafe JEV service, so the operator picks it in the full editor where that is shown.
 */
export type StrategyChange =
  | { kind: "unchanged" }
  | { kind: "open-advanced" }
  | { kind: "invalid"; error: ComboDraftError }
  | { kind: "save"; item: ComboItem };

export function planStrategyChange(
  combo: ComboItem,
  next: ComboStrategy,
  validate: (item: ComboItem) => ComboDraftError | null,
): StrategyChange {
  if (next === combo.strategy) return { kind: "unchanged" };
  if (next === "jev") return { kind: "open-advanced" };
  const item = { ...combo, strategy: next };
  const error = validate(item);
  return error ? { kind: "invalid", error } : { kind: "save", item };
}

/** Move one channel; out-of-range moves leave the list as it was. */
export function moveChannel<T>(list: readonly T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return [...list];
  const next = [...list];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved!);
  return next;
}

/** `PUT /api/combos` target list for an edited channel list: `lastResort` sent explicitly. */
export function channelTargetsForPut(
  putTargets: ReadonlyArray<Record<string, unknown> & { provider: string; model: string }>,
  channels: readonly Pick<RouteChannel, "provider" | "model" | "lastResort">[],
): Array<Record<string, unknown>> {
  return putTargets.map((target) => {
    const channel = channels.find((c) => c.provider === target.provider && c.model === target.model);
    return { ...target, lastResort: channel?.lastResort === true };
  });
}
