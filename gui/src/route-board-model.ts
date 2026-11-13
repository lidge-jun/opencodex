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
  | { kind: "windows"; windows: QuotaWindowView[] }
  | { kind: "metered" }
  | { kind: "unknown" };

/** Accounts behind one provider; paused accounts take no traffic. */
export interface AccountCount {
  active: number;
  paused: number;
}

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
  accounts?: AccountCount;
}

/** What the catalog says one member can take. */
export interface MemberFacts {
  contextWindow?: number;
  inputModalities?: readonly string[];
  reasoningEfforts?: readonly string[];
}

export interface MemberModel extends MemberFacts {
  provider: string;
  id: string;
}

export type ContextBasis = "min" | "max" | "catalog";

/**
 * The combo's context window as the policy advertises it. Intersection is the server's own catalog
 * number (it already takes the smallest member and applies context caps the member rows do not
 * show); only without one does it fall back to the smallest member here. Union takes the largest
 * member (union over context lands with the T4c backend).
 */
export function comboContextWindow(
  members: readonly MemberFacts[],
  policy: CapabilityPolicy,
  catalog: number | undefined,
): { tokens?: number; basis: ContextBasis } {
  const known = members.flatMap((member) => typeof member.contextWindow === "number" && member.contextWindow > 0 ? [member.contextWindow] : []);
  if (policy === "union" && known.length > 0) return { tokens: Math.max(...known, catalog ?? 0), basis: "max" };
  if (policy === "intersection" && catalog !== undefined) return { tokens: catalog, basis: "min" };
  if (known.length > 0) return { tokens: Math.min(...known), basis: "min" };
  return catalog !== undefined ? { tokens: catalog, basis: "catalog" } : { basis: "catalog" };
}

/** Combined list under the policy: every member's (intersection) or any member's (union); undefined when no member reports one. */
export function combineLists(lists: ReadonlyArray<readonly string[] | undefined>, policy: CapabilityPolicy, order: readonly string[] = []): string[] | undefined {
  const known = lists.filter((list): list is readonly string[] => list !== undefined);
  if (known.length === 0) return undefined;
  const merged = policy === "union"
    ? [...new Set(known.flat())]
    : known.reduce<string[]>((common, list) => common.filter((value) => list.includes(value)), [...known[0]!]);
  const rank = (value: string) => { const index = order.indexOf(value); return index < 0 ? order.length : index; };
  return merged.sort((a, b) => rank(a) - rank(b));
}

export function memberFacts(models: readonly MemberModel[], provider: string, model: string): MemberFacts {
  return models.find((candidate) => candidate.provider === provider && candidate.id === model) ?? {};
}

export interface RouteRow {
  combo: ComboItem;
  publicId: string;
  displayName: string;
  channels: RouteChannel[];
  /** One entry per distinct provider, in first-use order. */
  quotas: ProviderQuotaLine[];
  contextWindow?: number;
  contextBasis: ContextBasis;
  enabled: boolean;
  lastResortCount: number;
}

/** Combo capability policy (T4c). Absent on the wire means the default. */
export type CapabilityPolicy = "intersection" | "union";
export type UnservablePolicy = "degrade" | "reject";
export interface ComboCapabilitySettings {
  capabilityPolicy: CapabilityPolicy;
  onUnservable: UnservablePolicy;
}
export const DEFAULT_CAPABILITY_SETTINGS: ComboCapabilitySettings = { capabilityPolicy: "intersection", onUnservable: "degrade" };

export function parseCapabilitySettings(raw: { capabilityPolicy?: unknown; onUnservable?: unknown }): ComboCapabilitySettings {
  return {
    capabilityPolicy: raw.capabilityPolicy === "union" ? "union" : "intersection",
    onUnservable: raw.onUnservable === "reject" ? "reject" : "degrade",
  };
}

/** Fields the inline editor writes besides the targets; each is sent only when changed. */
export type ComboSettingsPatch = Partial<ComboCapabilitySettings> & { cooldownWaitPolicy?: "before-last-resort" | null };

/** Only the fields that changed, so a server without them never sees them unless the operator asked. */
export function capabilityPatch(before: ComboCapabilitySettings, after: ComboCapabilitySettings): Partial<ComboCapabilitySettings> {
  return {
    ...(after.capabilityPolicy !== before.capabilityPolicy ? { capabilityPolicy: after.capabilityPolicy } : {}),
    ...(after.onUnservable !== before.onUnservable ? { onUnservable: after.onUnservable } : {}),
  };
}

/** Antigravity names its quota pools by family; spell them out like the provider does. */
const QUOTA_FAMILY_NAMES: Readonly<Record<string, string>> = {
  gem: "Gemini",
  cla: "Claude & GPT",
  argon: "Gemini 4 Argon",
};

/** `Cla (Weekly)` → family "Claude & GPT", weekly window; anything else is left alone. */
export function quotaFamilyWindow(label: string): { family: string; weekly: boolean } | null {
  const match = /^([A-Za-z]+)( \(Weekly\))?$/.exec(label.trim());
  const family = match ? QUOTA_FAMILY_NAMES[match[1]!.toLowerCase()] : undefined;
  return family ? { family, weekly: match![2] !== undefined } : null;
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

function accountCount(aggregation: unknown): AccountCount | undefined {
  if (!aggregation || typeof aggregation !== "object") return undefined;
  const { includedAccounts, excludedAccounts, pausedAccounts } = aggregation as Record<string, unknown>;
  if (typeof includedAccounts !== "number") return undefined;
  const total = includedAccounts + (typeof excludedAccounts === "number" ? excludedAccounts : 0);
  const paused = typeof pausedAccounts === "number" ? Math.min(pausedAccounts, total) : 0;
  return { active: total - paused, paused };
}

/** `GET /api/oauth/accounts` → active and paused counts; null when the body is not an account list. */
export function accountCountFromList(body: unknown): AccountCount | null {
  const accounts = body && typeof body === "object" ? (body as { accounts?: unknown }).accounts : undefined;
  if (!Array.isArray(accounts)) return null;
  const paused = accounts.filter((account) => (account as { paused?: unknown } | null)?.paused === true).length;
  return { active: accounts.length - paused, paused };
}

/** Parse `/api/provider-quotas` `reports` once per render into provider → windows. */
export function quotaWindowsByProvider(
  reports: unknown,
  now = Date.now(),
): Map<string, { windows: QuotaSummaryWindow[]; accounts?: AccountCount }> {
  const fresh = freshQuotaReportsFromResponse(reports, now);
  const out = new Map<string, { windows: QuotaSummaryWindow[]; accounts?: AccountCount }>();
  for (const row of buildQuotaSummary(fresh, (provider) => provider)) {
    if (row.passive) continue;
    const accounts = accountCount(fresh[row.provider]?.aggregation);
    out.set(row.provider, { windows: row.windows, ...(accounts !== undefined ? { accounts } : {}) });
  }
  return out;
}

export function channelQuota(
  provider: RouteBoardProvider | undefined,
  reported: { windows: QuotaSummaryWindow[]; accounts?: AccountCount } | undefined,
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
  /** Per-provider account counts read from the account list, for providers whose quota has no aggregate. */
  accountCounts?: Readonly<Record<string, AccountCount>>;
  models?: readonly MemberModel[];
  capability?: Readonly<Record<string, ComboCapabilitySettings>>;
  now?: number;
}): RouteRow[] {
  const providers = new Map(input.providers.map((provider) => [provider.name, provider]));
  const reported = quotaWindowsByProvider(input.quotaReports, input.now);
  const rows = input.combos.map((combo) => {
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
      const accounts = reported.get(channel.provider)?.accounts ?? input.accountCounts?.[channel.provider];
      quotas.push({
        provider: channel.provider,
        quota: channelQuota(providers.get(channel.provider), reported.get(channel.provider), models),
        ...(accounts !== undefined ? { accounts } : {}),
      });
    }
    const meta = input.catalog[combo.id];
    const policy = input.capability?.[combo.id]?.capabilityPolicy ?? "intersection";
    const context = comboContextWindow(
      channels.map((channel) => memberFacts(input.models ?? [], channel.provider, channel.model)),
      policy,
      meta?.contextWindow,
    );
    const publicId = comboPublicModelId(combo.id, combo.alias);
    return {
      combo,
      publicId,
      displayName: combo.displayName?.trim() || meta?.displayName?.trim() || combo.id,
      channels,
      quotas,
      ...(context.tokens !== undefined ? { contextWindow: context.tokens } : {}),
      contextBasis: context.basis,
      enabled: meta ? !meta.disabled : true,
      lastResortCount: channels.filter((channel) => channel.lastResort).length,
    };
  });
  // Switched-off combos go last so the live ones lead; the sort is stable within each group.
  return [...rows.filter((row) => row.enabled), ...rows.filter((row) => !row.enabled)];
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
    return `${Number(millions.toFixed(1))}M`;
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
  | { kind: "invalid"; error: ComboDraftError; item: ComboItem }
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
  return error ? { kind: "invalid", error, item } : { kind: "save", item };
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
export function channelTargetsForPut<T extends { provider: string; model: string }>(
  putTargets: readonly T[],
  channels: readonly Pick<RouteChannel, "provider" | "model" | "lastResort">[],
): Array<T & { lastResort: boolean }> {
  return putTargets.map((target) => {
    const channel = channels.find((c) => c.provider === target.provider && c.model === target.model);
    return { ...target, lastResort: channel?.lastResort === true };
  });
}
