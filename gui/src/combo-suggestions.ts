/**
 * Combo suggestions for the Combos overview: models that two or more providers serve under the
 * same name, offered as a ready-made failover combo, and existing combos that a provider serving
 * their model is missing from. Pure: no React, no fetch, no storage.
 *
 * The idea of merging one model across providers by a normalized name follows Magpie's found
 * groups (`internal/catalog/samemodel.go`, MIT, Copyright (c) 2026 yetone). No code is taken
 * from it. Unlike Magpie, a snapshot date stays part of the name (two snapshots can differ in
 * capability) and a trailing reasoning-effort suffix is dropped.
 */
import { COMBO_ID_RE, emptyDraft, newComboTarget, type ComboItem } from "./combo-workspace-data";

export interface SuggestionProvider {
  name: string;
  disabled?: boolean;
  hiddenFromPicker?: boolean;
  authMode?: string;
  adapter?: string;
  baseUrl?: string;
}

export interface SuggestionModel {
  provider: string;
  id: string;
}

/**
 * Order members are suggested in: a subscription from the model's own maker, any other
 * subscription, Vertex credit, then pay-per-use keys and relays.
 */
export type ChannelTier = "own-subscription" | "subscription" | "vertex" | "metered";
const TIER_RANK: Record<ChannelTier, number> = { "own-subscription": 0, subscription: 1, vertex: 2, metered: 3 };

export interface SuggestedMember {
  provider: string;
  model: string;
  tier: ChannelTier;
  /** Lowest remaining percent across the provider's reported windows for this model. */
  remainingPercent?: number;
}

export type ComboSuggestion =
  | {
    kind: "create";
    /** Dismissal key, stable across reloads. */
    key: string;
    /** Normalized model name the members share. */
    model: string;
    /** Free combo id for the draft. */
    comboId: string;
    members: SuggestedMember[];
    /** At least one member is listed in the model catalog rather than hidden from it. */
    listed: boolean;
  }
  | {
    kind: "extend";
    key: string;
    model: string;
    comboId: string;
    /** Providers serving the combo's model that the combo does not route to yet. */
    members: SuggestedMember[];
  };

const EFFORT_SUFFIX = /-(?:minimal|low|medium|high|xhigh|max)$/;

/**
 * One model's name across providers: no `provider/` prefix, lowercase, runs of spaces,
 * underscores and dashes as one dash, a version dot as a dash (`claude-opus-5.5` is
 * `claude-opus-5-5`), and no trailing effort suffix (`gpt-6.1-sol-high` is `gpt-6-1-sol`).
 */
export function normalizeModelName(id: string): string {
  let name = id.trim().toLowerCase();
  name = name.slice(name.lastIndexOf("/") + 1);
  name = name.replace(/[\s_-]+/g, "-").replace(/^-+|-+$/g, "");
  name = name.replace(/(\d)\.(?=\d)/g, "$1-");
  return name.replace(EFFORT_SUFFIX, "");
}

/** The id spelled as the provider writes it, minus prefix and effort suffix: the combo id candidate. */
function spelling(id: string): string {
  const bare = id.trim().slice(id.trim().lastIndexOf("/") + 1).toLowerCase();
  return bare.replace(EFFORT_SUFFIX, "");
}

const MODEL_MAKERS: ReadonlyArray<[RegExp, string]> = [
  [/^claude/, "anthropic"],
  [/^(?:gpt|o\d|codex|chatgpt)/, "openai"],
  [/^(?:gemini|gemma)/, "google"],
  [/^grok/, "xai"],
  [/^deepseek/, "deepseek"],
];

const PROVIDER_MAKERS: ReadonlyArray<[RegExp, string]> = [
  [/(?:^|\.)anthropic\.com$/, "anthropic"],
  [/(?:^|\.)(?:openai\.com|chatgpt\.com)$/, "openai"],
  [/(?:^|\.)googleapis\.com$/, "google"],
  [/(?:^|\.)x\.ai$/, "xai"],
  [/(?:^|\.)deepseek\.com$/, "deepseek"],
];

function hostOf(baseUrl: string | undefined): string {
  if (!baseUrl) return "";
  try {
    return new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return "";
  }
}

export function channelTier(provider: SuggestionProvider, model: string): ChannelTier {
  const host = hostOf(provider.baseUrl);
  if (host.startsWith("aiplatform.") || /vertex/i.test(provider.name)) return "vertex";
  if (provider.authMode !== "oauth" && provider.authMode !== "forward") return "metered";
  const modelMaker = MODEL_MAKERS.find(([re]) => re.test(normalizeModelName(model)))?.[1];
  const providerMaker = PROVIDER_MAKERS.find(([re]) => re.test(host))?.[1];
  return modelMaker !== undefined && modelMaker === providerMaker ? "own-subscription" : "subscription";
}

/** Tier first; within a tier more quota left first, unknown quota after; then catalog order. */
export function orderMembers(members: readonly SuggestedMember[]): SuggestedMember[] {
  return members
    .map((member, index) => ({ member, index }))
    .sort((a, b) => {
      const tier = TIER_RANK[a.member.tier] - TIER_RANK[b.member.tier];
      if (tier !== 0) return tier;
      const left = a.member.remainingPercent ?? -1;
      const right = b.member.remainingPercent ?? -1;
      return right - left || a.index - b.index;
    })
    .map(({ member }) => member);
}

/** The combo is about one model: its id names it, or every member serves it. */
function comboModel(combo: ComboItem): string | undefined {
  const byId = normalizeModelName(combo.id);
  const names = new Set(combo.targets.map((target) => normalizeModelName(target.model)));
  if (names.size === 1) return [...names][0];
  return names.has(byId) ? byId : undefined;
}

/** `base`, else `base-2`, `base-3`, … that no combo id or alias already takes (case-insensitive). */
export function freeComboId(base: string, combos: readonly ComboItem[]): string {
  const taken = new Set(combos.flatMap((combo) => [combo.id, combo.alias ?? ""]).map((id) => id.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

export interface SuggestionInput {
  combos: readonly ComboItem[];
  /** Catalog rows, combos excluded, hidden rows included: hiding a model only hides it from pickers. */
  models: readonly SuggestionModel[];
  /** `provider/model` keys hidden from the model catalog (`disabledModels`). */
  hiddenModels?: ReadonlySet<string>;
  providers: readonly SuggestionProvider[];
  remainingPercent?: (provider: string, model: string) => number | undefined;
  dismissed?: ReadonlySet<string>;
  /** Providers the operator left out of suggestions: they join no suggested combo. */
  excludedProviders?: ReadonlySet<string>;
}

export function suggestionKey(kind: ComboSuggestion["kind"], model: string, comboId?: string): string {
  return kind === "create" ? `create:${model}` : `extend:${comboId}:${model}`;
}

export function buildComboSuggestions(input: SuggestionInput): ComboSuggestion[] {
  const providers = new Map(input.providers.map((provider) => [provider.name, provider]));
  /** model name → provider → that provider's id for it (the shortest spelling wins). */
  const byModel = new Map<string, Map<string, string>>();
  for (const row of input.models) {
    const provider = providers.get(row.provider);
    if (!provider || provider.disabled || provider.hiddenFromPicker || input.excludedProviders?.has(row.provider)) continue;
    const name = normalizeModelName(row.id);
    if (!name) continue;
    const served = byModel.get(name) ?? new Map<string, string>();
    const current = served.get(row.provider);
    if (current === undefined || row.id.length < current.length) served.set(row.provider, row.id);
    byModel.set(name, served);
  }

  const member = (provider: string, model: string): SuggestedMember => {
    const remaining = input.remainingPercent?.(provider, model);
    return {
      provider,
      model,
      tier: channelTier(providers.get(provider)!, model),
      ...(remaining !== undefined ? { remainingPercent: remaining } : {}),
    };
  };

  const covering = new Map<string, ComboItem>();
  for (const combo of input.combos) {
    const name = comboModel(combo);
    if (name !== undefined && !covering.has(name)) covering.set(name, combo);
  }

  const creates: Array<ComboSuggestion & { kind: "create" }> = [];
  const extends_: Array<ComboSuggestion & { kind: "extend" }> = [];
  for (const [name, served] of byModel) {
    const combo = covering.get(name);
    // An existing combo takes any eligible provider it is missing, even the only one left once
    // its own members are excluded; a new combo needs two providers to fail over between.
    if (combo) {
      const routed = new Set(combo.targets.map((target) => target.provider));
      const missing = [...served].filter(([provider]) => !routed.has(provider));
      const key = suggestionKey("extend", name, combo.id);
      if (missing.length === 0 || input.dismissed?.has(key)) continue;
      extends_.push({ kind: "extend", key, model: name, comboId: combo.id, members: orderMembers(missing.map(([p, m]) => member(p, m))) });
      continue;
    }
    if (served.size < 2) continue;
    const key = suggestionKey("create", name);
    if (input.dismissed?.has(key)) continue;
    const spellings = [...served.values()].map(spelling);
    const counts = new Map<string, number>();
    for (const value of spellings) counts.set(value, (counts.get(value) ?? 0) + 1);
    const preferred = spellings.reduce((best, value) => (counts.get(value)! > counts.get(best)! ? value : best));
    creates.push({
      kind: "create",
      key,
      model: name,
      comboId: freeComboId(COMBO_ID_RE.test(preferred) ? preferred : name, input.combos),
      members: orderMembers([...served].map(([p, m]) => member(p, m))),
      listed: [...served].some(([provider, model]) => !input.hiddenModels?.has(`${provider}/${model}`)),
    });
  }
  creates.sort((a, b) => Number(b.listed) - Number(a.listed) || b.members.length - a.members.length || a.model.localeCompare(b.model));
  extends_.sort((a, b) => a.comboId.localeCompare(b.comboId));
  // A model nobody lists in the catalog is usually an older version: after the hints for live combos.
  return [...creates.filter((s) => s.listed), ...extends_, ...creates.filter((s) => !s.listed)];
}

/** The failover combo a create suggestion saves, members in the order given. */
export function suggestionDraft(comboId: string, members: readonly SuggestedMember[]): ComboItem {
  return {
    ...emptyDraft(comboId),
    targets: members.map((entry) => newComboTarget({ provider: entry.provider, model: entry.model })),
  };
}

/**
 * The combo with each suggested member placed before the first of its own members in a lower
 * tier (a subscription goes ahead of pay-per-use keys), else last. Its own members keep their order.
 */
export function extendedCombo(
  combo: ComboItem,
  members: readonly SuggestedMember[],
  tierOf: (provider: string, model: string) => ChannelTier,
): ComboItem {
  const targets = [...combo.targets];
  for (const entry of members) {
    const at = targets.findIndex((target) => TIER_RANK[tierOf(target.provider, target.model)] > TIER_RANK[entry.tier]);
    targets.splice(at < 0 ? targets.length : at, 0, newComboTarget({ provider: entry.provider, model: entry.model }));
  }
  return { ...combo, targets };
}
