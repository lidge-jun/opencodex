/**
 * Pure view-model helpers for the Combos workspace.
 * No network — transforms GET /api/combos rows into rail groups + attention.
 */

import { SUPPORTED_NATIVE_OPENAI_SLUGS } from "../../src/codex/catalog/native-models";
import type { TKey } from "./i18n/shared";

export { SUPPORTED_NATIVE_OPENAI_SLUGS };

export type ComboStrategy = "failover" | "round-robin" | "random" | "least-used" | "reset-window";
export type ComboEffort = "low" | "medium" | "high" | "xhigh" | "max" | "ultra";

export const COMBO_EFFORTS: ComboEffort[] = ["low", "medium", "high", "xhigh", "max", "ultra"];
/** Mirrors OcxComboStrategy in src/types/config.ts. */
export const COMBO_STRATEGIES: readonly ComboStrategy[] = [
  "failover",
  "round-robin",
  "random",
  "least-used",
  "reset-window",
] as const;

export const COMBO_STRATEGY_LABEL_KEYS: Record<ComboStrategy, TKey> = {
  failover: "cws.strategy.failover",
  "round-robin": "cws.strategy.roundRobin",
  random: "cws.strategy.random",
  "least-used": "cws.strategy.leastUsed",
  "reset-window": "cws.strategy.resetWindow",
};

export const COMBO_STRATEGY_HINT_KEYS: Record<ComboStrategy, TKey> = {
  failover: "cws.strategy.failoverHint",
  "round-robin": "cws.strategy.roundRobinHint",
  random: "cws.strategy.randomHint",
  "least-used": "cws.strategy.leastUsedHint",
  "reset-window": "cws.strategy.resetWindowHint",
};

export const COMBO_TARGETS_HINT_KEYS: Record<ComboStrategy, TKey> = {
  failover: "cws.targets.failoverHint",
  "round-robin": "cws.targets.roundRobinHint",
  random: "cws.targets.randomHint",
  "least-used": "cws.targets.leastUsedHint",
  "reset-window": "cws.targets.resetWindowHint",
};

const COMBO_STRATEGY_SET = new Set<string>(COMBO_STRATEGIES);

/**
 * Intersection of advertised effort ladders for picker availability.
 * Unknown ladders are wildcards here only; runtime injection remains fail-closed.
 */
export function intersectComboEfforts(
  targets: readonly ComboTarget[],
  modelEfforts: ReadonlyMap<string, readonly string[] | undefined>,
  reasoningEffortMode: "strict" | "adaptive" = "strict",
): ComboEffort[] {
  const complete = targets.filter((t) => t.provider.trim() && t.model.trim());
  if (complete.length === 0) return [...COMBO_EFFORTS];
  const effortSet = new Set<string>(COMBO_EFFORTS);
  let common: string[] | null = null;
  for (const target of complete) {
    const key = `${target.provider.trim()}/${target.model.trim()}`;
    const listed = modelEfforts.get(key);
    if (listed === undefined) continue;
    // Adaptive mirrors the served catalog: a target advertising no effort control is
    // excluded from the intersection rather than collapsing it for every sibling.
    if (reasoningEffortMode === "adaptive" && listed.length === 0) continue;
    const member = listed.filter((effort) => effortSet.has(effort));
    if (common === null) {
      common = member;
    } else {
      const memberSet = new Set(member);
      common = common.filter((effort) => memberSet.has(effort));
    }
  }
  if (common === null) return [...COMBO_EFFORTS];
  const commonSet = new Set(common);
  return COMBO_EFFORTS.filter((effort) => commonSet.has(effort));
}

export interface ComboTarget {
  provider: string;
  model: string;
  weight?: number;
  /** UI-only stable key for React lists; never sent to the API. */
  clientKey?: string;
}

export type ComboQuotaState = "available" | "exhausted" | "unknown";
export type ProviderQuotaStates = Readonly<Record<string, ComboQuotaState>>;

/** Matches the management endpoint's bounded last-good quota lifetime. */
export const COMBO_QUOTA_MAX_AGE_MS = 30 * 60_000;

let comboTargetKeySeq = 0;

export function newComboTarget(partial: Partial<ComboTarget> = {}): ComboTarget {
  return {
    provider: partial.provider ?? "",
    model: partial.model ?? "",
    ...(partial.weight !== undefined ? { weight: partial.weight } : {}),
    clientKey: partial.clientKey ?? `ct-${++comboTargetKeySeq}`,
  };
}


function normalizeImageInput(value: unknown): "auto" | "disabled" {
  return value === "disabled" ? "disabled" : "auto";
}

function normalizeReasoningEffortMode(value: unknown): "strict" | "adaptive" {
  return value === "adaptive" ? "adaptive" : "strict";
}

export interface ComboItem {
  id: string;
  /** Wire id shown to clients, e.g. combo/free */
  model: string;
  /** Optional public model name replacing the default combo/<id> slug; null = default. */
  alias: string | null;
  /** Explicit takeover of a bare OpenAI-native alias. */
  nativeAlias: boolean;
  /** Display-only catalog label used by native aliases. */
  displayName: string | null;
  strategy: ComboStrategy;
  stickyLimit: number;
  defaultEffort: ComboEffort | null;
  imageInput?: "auto" | "disabled";
  /**
   * Picker-ladder policy. `adaptive` lets targets that advertise no effort control drop
   * out of the intersection instead of emptying it for the whole group.
   */
  reasoningEffortMode?: "strict" | "adaptive";
  targets: ComboTarget[];
}

export interface ComboSections {
  failover: ComboItem[];
  roundRobin: ComboItem[];
  other: ComboItem[];
}

export interface ComboAttentionItem {
  id: string;
  model: string;
  reason: "few-targets" | "empty-targets" | "catalog-omitted" | "all-targets-exhausted";
}

export const COMBO_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
/** One optional "/" segment, each segment id-shaped — mirrors src/combos/types.ts. */
export const COMBO_ALIAS_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}(\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,63})?$/;
const NATIVE_OPENAI_FAMILY_RE = /^(?:gpt-|o1-|o3-|o4-|codex-)/;

export function isValidComboId(id: string): boolean {
  return COMBO_ID_RE.test(id.trim());
}

export function comboModelId(id: string): string {
  return `combo/${id.trim()}`;
}

/** Public model id clients request: the alias when set, else the default combo/<id>. */
export function comboPublicModelId(id: string, alias: string | null | undefined): string {
  const trimmed = typeof alias === "string" ? alias.trim() : "";
  return trimmed || comboModelId(id);
}

/** Apply an alias-field edit and discard hidden native-alias metadata once it becomes ordinary. */
export function updateComboAliasDraft(item: ComboItem, rawAlias: string): ComboItem {
  const trimmed = rawAlias.trim();
  const leavesNativeAliasFamily = item.nativeAlias
    && (!trimmed || trimmed.includes("/") || !NATIVE_OPENAI_FAMILY_RE.test(trimmed));
  return {
    ...item,
    alias: trimmed ? rawAlias : null,
    model: comboPublicModelId(item.id, rawAlias),
    ...(leavesNativeAliasFamily ? { nativeAlias: false, displayName: null } : {}),
  };
}

function normalizeAlias(raw: unknown): string | null {
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

export function normalizeStrategy(raw: unknown): ComboStrategy {
  return typeof raw === "string" && COMBO_STRATEGY_SET.has(raw)
    ? raw as ComboStrategy
    : "failover";
}

export function normalizeStickyLimit(raw: unknown): number {
  return typeof raw === "number" && Number.isInteger(raw) && raw >= 1 && raw <= 100
    ? raw
    : 1;
}

export function normalizeDefaultEffort(raw: unknown): ComboEffort | null {
  return typeof raw === "string" && (COMBO_EFFORTS as string[]).includes(raw)
    ? (raw as ComboEffort)
    : null;
}

export function normalizeWeight(raw: unknown): number | undefined {
  return typeof raw === "number" && Number.isInteger(raw) && raw >= 1 && raw <= 10000
    ? raw
    : undefined;
}

export function parseComboList(payload: unknown): ComboItem[] {
  if (!payload || typeof payload !== "object") return [];
  const rows = (payload as { combos?: unknown }).combos;
  if (!Array.isArray(rows)) return [];
  const out: ComboItem[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const id = typeof r.id === "string" ? r.id.trim() : "";
    if (!id) continue;
    const targetsRaw = Array.isArray(r.targets) ? r.targets : [];
    const targets: ComboTarget[] = [];
    for (const t of targetsRaw) {
      if (!t || typeof t !== "object") continue;
      const tr = t as Record<string, unknown>;
      const provider = typeof tr.provider === "string" ? tr.provider.trim() : "";
      const model = typeof tr.model === "string" ? tr.model.trim() : "";
      if (!provider || !model) continue;
      const weight = normalizeWeight(tr.weight);
      targets.push(weight !== undefined ? newComboTarget({ provider, model, weight }) : newComboTarget({ provider, model }));
    }
    out.push({
      id,
      model: typeof r.model === "string" && r.model.trim()
        ? r.model.trim()
        : comboPublicModelId(id, normalizeAlias(r.alias)),
      alias: normalizeAlias(r.alias),
      nativeAlias: r.nativeAlias === true,
      displayName: normalizeAlias(r.displayName),
      strategy: normalizeStrategy(r.strategy),
      stickyLimit: normalizeStickyLimit(r.stickyLimit),
      defaultEffort: normalizeDefaultEffort(r.defaultEffort),
      imageInput: normalizeImageInput(r.imageInput),
      reasoningEffortMode: normalizeReasoningEffortMode(r.reasoningEffortMode),
      targets,
    });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id, undefined, { sensitivity: "base" }));
}

export function groupCombos(items: ComboItem[]): ComboSections {
  const failover: ComboItem[] = [];
  const roundRobin: ComboItem[] = [];
  const other: ComboItem[] = [];
  for (const item of items) {
    if (item.strategy === "failover") failover.push(item);
    else if (item.strategy === "round-robin") roundRobin.push(item);
    else other.push(item);
  }
  return { failover, roundRobin, other };
}

export function filterCombos(items: ComboItem[], query: string): ComboItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  return items.filter((item) => {
    if (item.id.toLowerCase().includes(q)) return true;
    if (item.model.toLowerCase().includes(q)) return true;
    return item.targets.some(
      (t) => t.provider.toLowerCase().includes(q) || t.model.toLowerCase().includes(q),
    );
  });
}

function recordFromUnknown(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function quotaTimestampIsFresh(value: unknown, now: number): boolean {
  const timestamp = finiteNumber(value);
  return timestamp !== null && now - timestamp < COMBO_QUOTA_MAX_AGE_MS;
}

function nonNegativeInteger(value: unknown): number | null {
  const number = finiteNumber(value);
  return number !== null && Number.isInteger(number) && number >= 0 ? number : null;
}

function aggregateWindowIsComplete(value: unknown, now: number): boolean {
  const window = recordFromUnknown(value);
  const usedPercent = finiteNumber(window?.usedPercent);
  return !!window
    && usedPercent !== null
    && usedPercent >= 0
    && nonNegativeInteger(window.includedAccounts) !== null
    && (nonNegativeInteger(window.includedAccounts) ?? 0) > 0
    && nonNegativeInteger(window.excludedAccounts) === 0
    && window.incomplete === false
    && quotaTimestampIsFresh(window.updatedAt, now);
}

function aggregateEvidenceIsComplete(value: unknown, now: number): boolean {
  const aggregation = recordFromUnknown(value);
  if (
    !aggregation
    || aggregation.kind !== "capacity-weighted-v1"
    || aggregation.scope !== "routable-known"
    || aggregation.presentation !== "aggregate"
    || aggregation.incomplete !== false
  ) return false;

  for (const key of [
    "includedAccounts",
    "excludedAccounts",
    "unknownPlanAccounts",
    "missingQuotaAccounts",
    "pausedAccounts",
    "reauthAccounts",
    "staleQuotaAccounts",
    "partialWindowAccounts",
  ] as const) {
    if (nonNegativeInteger(aggregation[key]) === null) return false;
  }
  if ((nonNegativeInteger(aggregation.includedAccounts) ?? 0) === 0) return false;
  for (const key of [
    "excludedAccounts",
    "unknownPlanAccounts",
    "missingQuotaAccounts",
    "pausedAccounts",
    "reauthAccounts",
    "staleQuotaAccounts",
    "partialWindowAccounts",
  ] as const) {
    if (aggregation[key] !== 0) return false;
  }

  let hasWindow = false;
  for (const key of ["fiveHour", "weekly", "monthly"] as const) {
    if (!Object.hasOwn(aggregation, key)) continue;
    if (!aggregateWindowIsComplete(aggregation[key], now)) return false;
    hasWindow = true;
  }
  if (Object.hasOwn(aggregation, "customWindows")) {
    if (!Array.isArray(aggregation.customWindows)) return false;
    for (const value of aggregation.customWindows) {
      const custom = recordFromUnknown(value);
      if (!custom || typeof custom.label !== "string" || !custom.label.trim()) return false;
      if (!aggregateWindowIsComplete(custom, now)) return false;
      hasWindow = true;
    }
  }
  return hasWindow;
}

function quotaStateFromReport(raw: Record<string, unknown>, now: number): ComboQuotaState {
  if (!quotaTimestampIsFresh(raw.updatedAt, now)) return "unknown";
  const quota = recordFromUnknown(raw.quota);
  if (!quota || !quotaTimestampIsFresh(quota.updatedAt, now)) return "unknown";
  if (raw.aggregation !== undefined && !aggregateEvidenceIsComplete(raw.aggregation, now)) return "unknown";

  let hasEvidence = false;
  let exhausted = false;
  for (const key of ["fiveHourPercent", "weeklyPercent", "monthlyPercent"] as const) {
    if (!Object.hasOwn(quota, key)) continue;
    const percent = finiteNumber(quota[key]);
    if (percent === null || percent < 0) return "unknown";
    hasEvidence = true;
    if (percent >= 100) exhausted = true;
  }
  for (const key of ["fiveHourResetAt", "weeklyResetAt", "monthlyResetAt"] as const) {
    if (Object.hasOwn(quota, key) && finiteNumber(quota[key]) === null) return "unknown";
  }

  if (Object.hasOwn(quota, "customWindows")) {
    if (!Array.isArray(quota.customWindows)) return "unknown";
    for (const value of quota.customWindows) {
      const window = recordFromUnknown(value);
      const percent = finiteNumber(window?.percent);
      if (!window || typeof window.label !== "string" || !window.label.trim() || percent === null || percent < 0) {
        return "unknown";
      }
      if (Object.hasOwn(window, "resetAt") && finiteNumber(window.resetAt) === null) return "unknown";
      hasEvidence = true;
      if (percent >= 100) exhausted = true;
    }
  }

  if (Object.hasOwn(quota, "creditsUsd")) {
    const credits = recordFromUnknown(quota.creditsUsd);
    if (!credits) return "unknown";
    const used = finiteNumber(credits.used);
    const limit = finiteNumber(credits.limit);
    const remaining = finiteNumber(credits.remaining);
    const percent = finiteNumber(credits.percent);
    if (used === null || used < 0 || limit === null || limit < 0 || remaining === null || percent === null || percent < 0) {
      return "unknown";
    }
    if (credits.unlimited !== undefined && typeof credits.unlimited !== "boolean") return "unknown";
    if (Object.hasOwn(credits, "expiresAt") && finiteNumber(credits.expiresAt) === null) return "unknown";
    hasEvidence = true;
    if (credits.unlimited !== true && remaining <= 0) exhausted = true;
  }

  if (!hasEvidence) return "unknown";
  return exhausted ? "exhausted" : "available";
}

/** Fail-unknown parser for the live `/api/provider-quotas` report array. */
export function providerQuotaStatesFromReports(
  reports: unknown,
  now = Date.now(),
): Record<string, ComboQuotaState> {
  if (!Array.isArray(reports)) return {};
  const states: Record<string, ComboQuotaState> = {};
  for (const value of reports) {
    const report = recordFromUnknown(value);
    const provider = typeof report?.provider === "string" ? report.provider.trim() : "";
    if (!report || !provider) continue;
    const next = quotaStateFromReport(report, now);
    states[provider] = Object.hasOwn(states, provider) && states[provider] !== next
      ? "unknown"
      : next;
  }
  return states;
}

/**
 * A combo is exhausted only when it has at least one configured, enabled,
 * complete target and every such target has known exhausted quota evidence.
 */
export function comboQuotaState(
  targets: readonly ComboTarget[],
  providerQuotaStates: ProviderQuotaStates,
  providers: Readonly<Record<string, { disabled?: boolean }>>,
): ComboQuotaState {
  const usableProviders = targets.flatMap((target) => {
    const provider = target.provider.trim();
    if (!provider || !target.model.trim()) return [];
    if (!Object.hasOwn(providers, provider) || providers[provider]?.disabled === true) return [];
    return [provider];
  });
  if (usableProviders.length === 0) return "unknown";

  let sawUnknown = false;
  for (const provider of usableProviders) {
    const state = providerQuotaStates[provider] ?? "unknown";
    if (state === "available") return "available";
    if (state === "unknown") sawUnknown = true;
  }
  return sawUnknown ? "unknown" : "exhausted";
}

export function buildComboAttention(
  items: ComboItem[],
  options: {
    cataloguedComboIds?: ReadonlySet<string>;
    providerQuotaStates?: ProviderQuotaStates;
    providers?: Readonly<Record<string, { disabled?: boolean }>>;
  } = {},
): ComboAttentionItem[] {
  const out: ComboAttentionItem[] = [];
  const catalogued = options.cataloguedComboIds;
  for (const item of items) {
    if (item.targets.length === 0) {
      out.push({ id: item.id, model: item.model, reason: "empty-targets" });
    } else if (item.targets.length < 2) {
      out.push({ id: item.id, model: item.model, reason: "few-targets" });
    }
    // Configured combos missing from the live catalog (usually incomplete member
    // contextWindow / modality intersection) still route by alias, but never appear
    // in Codex's picker — flag that gap (#484).
    if (catalogued && item.targets.length > 0 && !catalogued.has(item.id)) {
      out.push({ id: item.id, model: item.model, reason: "catalog-omitted" });
    }
    if (
      options.providerQuotaStates
      && options.providers
      && comboQuotaState(item.targets, options.providerQuotaStates, options.providers) === "exhausted"
    ) {
      out.push({ id: item.id, model: item.model, reason: "all-targets-exhausted" });
    }
  }
  return out;
}

export function draftEquals(a: ComboItem, b: ComboItem): boolean {
  if (
    a.id !== b.id
    || a.alias !== b.alias
    || a.nativeAlias !== b.nativeAlias
    || a.displayName !== b.displayName
    || a.strategy !== b.strategy
    || a.stickyLimit !== b.stickyLimit
    || a.defaultEffort !== b.defaultEffort
    || (a.imageInput ?? "auto") !== (b.imageInput ?? "auto")
    || (a.reasoningEffortMode ?? "strict") !== (b.reasoningEffortMode ?? "strict")
  ) return false;
  if (a.targets.length !== b.targets.length) return false;
  return a.targets.every((t, i) => {
    const o = b.targets[i]!;
    return t.provider === o.provider && t.model === o.model && (t.weight ?? 1) === (o.weight ?? 1);
  });
}

export function toPutBody(item: ComboItem, options: { renameFrom?: string } = {}): {
  id: string;
  renameFrom?: string;
  combo: {
    targets: ComboTarget[];
    strategy: ComboStrategy;
    stickyLimit?: number;
    defaultEffort: ComboEffort | null;
    imageInput?: "disabled";
    reasoningEffortMode?: "adaptive";
    alias?: string;
    nativeAlias?: true;
    displayName?: string;
  };
} {
  const weighted = item.strategy === "round-robin" || item.strategy === "random";
  return {
    id: item.id.trim(),
    ...(options.renameFrom ? { renameFrom: options.renameFrom } : {}),
    combo: {
      targets: item.targets.map((target) => weighted
        ? { provider: target.provider.trim(), model: target.model.trim(), weight: target.weight ?? 1 }
        : { provider: target.provider.trim(), model: target.model.trim() }),
      strategy: item.strategy,
      defaultEffort: item.defaultEffort,
      ...(item.imageInput === "disabled" ? { imageInput: "disabled" as const } : {}),
      ...(item.reasoningEffortMode === "adaptive" ? { reasoningEffortMode: "adaptive" as const } : {}),
      ...(item.strategy === "round-robin" ? { stickyLimit: item.stickyLimit } : {}),
      ...(item.alias && item.alias.trim() ? { alias: item.alias.trim() } : {}),
      ...(item.nativeAlias ? { nativeAlias: true } : {}),
      ...(item.displayName && item.displayName.trim() ? { displayName: item.displayName.trim() } : {}),
    },
  };
}

export type ComboDraftError =
  | "missingId"
  | "invalidId"
  | "duplicateId"
  | "reservedNamespace"
  | "providerCollision"
  | "invalidAlias"
  | "aliasReservedNamespace"
  | "aliasNativeFamily"
  | "unsupportedNativeAlias"
  | "missingNativeAliasDisplayName"
  | "invalidDisplayName"
  | "duplicateAlias"
  | "noTargets"
  | "incompleteTarget"
  | "unknownProvider"
  | "duplicateTarget"
  | "invalidStickyLimit"
  | "invalidWeight"
  | "noEnabledTarget";

export function validateComboDraft(
  item: ComboItem,
  options: {
    existingIds: readonly string[];
    /** Aliases already taken by OTHER combos (callers exclude the edited combo). */
    existingAliases?: readonly string[];
    isCreate: boolean;
    providers: Readonly<Record<string, { disabled?: boolean }>>;
  },
): ComboDraftError | null {
  const id = item.id.trim();
  if (!id) return "missingId";
  if (!isValidComboId(id)) return "invalidId";
  // Callers pass other combos' ids (create: all; edit: all but self), so a rename
  // into an occupied id is caught here too.
  if (options.existingIds.includes(id)) return "duplicateId";
  if (Object.hasOwn(options.providers, "combo")) return "reservedNamespace";
  if (Object.hasOwn(options.providers, id)) return "providerCollision";

  const alias = item.alias?.trim() ?? "";
  const displayName = item.displayName?.trim() ?? "";
  if (alias) {
    if (!COMBO_ALIAS_RE.test(alias)) return "invalidAlias";
    if (alias === "combo" || alias.startsWith("combo/")) return "aliasReservedNamespace";
    if (!alias.includes("/") && NATIVE_OPENAI_FAMILY_RE.test(alias) && !item.nativeAlias) return "aliasNativeFamily";
    if ((options.existingAliases ?? []).includes(alias)) return "duplicateAlias";
  }
  const displayNameHasControlCharacter = [...(item.displayName ?? "")].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
  if (item.displayName !== null
    && (displayName.length > 128 || displayNameHasControlCharacter)) {
    return "invalidDisplayName";
  }
  if (item.nativeAlias && !SUPPORTED_NATIVE_OPENAI_SLUGS.has(alias)) return "unsupportedNativeAlias";
  if (item.nativeAlias && !displayName) return "missingNativeAliasDisplayName";
  if (item.targets.length < 1) return "noTargets";

  for (const t of item.targets) {
    if (!t.provider.trim() || !t.model.trim()) return "incompleteTarget";
    if (!Object.hasOwn(options.providers, t.provider.trim())) return "unknownProvider";
  }

  const targets = new Set<string>();
  for (const target of item.targets) {
    const key = `${target.provider.trim()}/${target.model.trim()}`;
    if (targets.has(key)) return "duplicateTarget";
    targets.add(key);
  }

  if (item.strategy === "round-robin") {
    if (!Number.isInteger(item.stickyLimit) || item.stickyLimit < 1 || item.stickyLimit > 100) {
      return "invalidStickyLimit";
    }
  }
  if (item.strategy === "round-robin" || item.strategy === "random") {
    for (const target of item.targets) {
      const weight = target.weight ?? 1;
      if (!Number.isInteger(weight) || weight < 1 || weight > 10000) return "invalidWeight";
    }
  }

  if (!item.targets.some((target) => options.providers[target.provider.trim()]?.disabled !== true)) {
    return "noEnabledTarget";
  }
  return null;
}

export function emptyDraft(id = ""): ComboItem {
  return {
    id,
    model: id ? comboModelId(id) : "combo/",
    alias: null,
    nativeAlias: false,
    displayName: null,
    strategy: "failover",
    stickyLimit: 1,
    defaultEffort: null,
    imageInput: "auto",
    reasoningEffortMode: "strict",
    targets: [newComboTarget()],
  };
}
