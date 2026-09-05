import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { atomicWriteFile, expandUserPath, getConfigDir, websocketsEnabled } from "../../config";
import { CODEX_CONFIG_PATH, CODEX_MODELS_CACHE_PATH, DEFAULT_CATALOG_PATH, readRootTomlString, resolveCodexConfigPath } from "../paths";
import { codexAccountNamespaceEntries, isMainCodexAccountTarget } from "../account-namespaces";
import { clearModelCache, DEFAULT_MODEL_CACHE_TTL_MS, getFreshCached, getStaleCached, isModelsFetchCoolingDown, markModelsFetchFailure, setCached } from "../model-cache";
import { buildModelsRequest, resolveModelsAuthToken } from "../../oauth";
import type { OcxConfig, OcxProviderConfig } from "../../types";
import { modelInList } from "../../types";
import { CODEX_REASONING_LEVELS, codexEffortRank, configuredReasoningEfforts, modelRecordValue, sanitizeCodexReasoningEfforts } from "../../reasoning-effort";
import { getModelMetadata, getModelMetadataCaseInsensitive, listModelMetadata, resolveMetadataProvider } from "../../generated/model-metadata";
import { enrichProviderFromRegistry, shouldCaseFoldMetadataModelId } from "../../providers/derive";
import { getProviderRegistryEntry, providerCodexAccountMode } from "../../providers/registry";
import { applyProviderContextCap, providerContextCap } from "../../providers/context-cap";
import { clampAutoCompactTokenLimit } from "../../providers/auto-compact-budget";
import { routedSlug, slugEquals, slugsEquivalent } from "../../providers/slug-codec";
import { identifyRoutedModel } from "../../adapters/identity";
import { filterCursorConfiguredModelsByLiveDiscovery } from "../../adapters/cursor/discovery";
import { fetchCursorUsableModels } from "../../adapters/cursor/live-models";
import { isCanonicalOpenAiForwardProvider, OPENAI_API_PROVIDER_ID, OPENAI_CODEX_PROVIDER_ID } from "../../providers/openai-tiers";
import {
  COMBO_NAMESPACE,
  comboModelId,
  getCombo,
  isNativeAliasCombo,
  listComboIds,
  targetKey,
} from "../../combos";
import type { NormalizedComboConfig } from "../../combos/types";
import { providerDestinationResolvedError } from "../../lib/destination-policy";
import { redactSecretString } from "../../lib/redact";
import upstreamModelsSnapshot from "../data/upstream-models.json";


import type { RawEntry } from "./parsing";
import { readCurrentCatalogOrCache, readCurrentCodexCatalog, readCurrentCodexModelsCache, unique } from "./bundled";
import { trustedAccountBoundNativeCatalogSlug, visibleCodexAccountSelectors } from "./account-models";
import { CODEX_NATIVE_ALIAS_CATALOG_KIND } from "./kinds";
import { RESERVE_METADATA_SOURCE_FIELD } from "./reserve";
import {
  ACCOUNT_GATED_NATIVE_OPENAI_MODELS,
  NATIVE_DAYBREAK_BLUE_MODEL,
  NATIVE_GPT6_ASTRA_MODEL,
  NATIVE_RESERVE_MODEL,
  NATIVE_OPENAI_CAPABILITY_ALIAS_MODELS,
  NATIVE_OPENAI_MODELS,
  SELF_DESCRIBED_NATIVE_OPENAI_MODELS,
  SUPPORTED_NATIVE_OPENAI_SLUGS,
  hasNativeOpenAiCapabilityMetadata,
  isNativeOpenAiCapabilityAliasModel,
  nativeOpenAiAliasPresentation,
  nativeOpenAiCapabilitySourceSlug,
} from "./native-models";
import { cachedAvailableAccountGatedNativeModels } from "../model-entitlements";
import { MAIN_CODEX_ACCOUNT_ID } from "../main-account";
export { CODEX_NATIVE_ALIAS_CATALOG_KIND } from "./kinds";
export {
  NATIVE_DAYBREAK_BLUE_MODEL,
  NATIVE_GPT6_ASTRA_MODEL,
  NATIVE_OPENAI_CAPABILITY_ALIAS_MODELS,
  NATIVE_OPENAI_MODELS,
  SELF_DESCRIBED_NATIVE_OPENAI_MODELS,
  SUPPORTED_NATIVE_OPENAI_SLUGS,
  hasNativeOpenAiCapabilityMetadata,
  isNativeOpenAiCapabilityAliasModel,
  nativeOpenAiAliasPresentation,
  nativeOpenAiCapabilitySourceSlug,
} from "./native-models";

export const DOCUMENTED_NATIVE_OPENAI_ADDITIONS = [
  "gpt-5.3-codex-spark",
  "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna",
  // The shipped pin also backfills older installed Codex catalogs that predate Astra.
  NATIVE_GPT6_ASTRA_MODEL,
];

export function configuredNativeAliasSlugs(
  config: Pick<OcxConfig, "combos">,
): Set<string> {
  const aliases = new Set<string>();
  for (const raw of Object.values(config.combos ?? {})) {
    if (!isNativeAliasCombo(raw)) continue;
    const alias = raw.alias!.trim();
    if (SUPPORTED_NATIVE_OPENAI_SLUGS.has(alias)) aliases.add(alias);
  }
  return aliases;
}

/**
 * Bare native rows that must be absent, rather than merely hidden, while Desktop native-alias
 * compatibility is active. Codex Desktop's remote allowlist can ignore `visibility: "hide"`;
 * omitting disabled native rows is therefore part of the explicit native-alias opt-in.
 */
export function desktopAllowlistSuppressedNativeSlugs(
  config: Pick<OcxConfig, "combos" | "disabledModels">,
): Set<string> {
  const suppressed = configuredNativeAliasSlugs(config);
  if (suppressed.size === 0) return suppressed;
  const disabled = disabledNativeSlugs(config);
  for (const slug of NATIVE_OPENAI_MODELS) {
    if (disabled.has(slug)) suppressed.add(slug);
  }
  return suppressed;
}

export function isNativeAliasCatalogEntry(entry: RawEntry): boolean {
  return entry.opencodex_catalog_kind === CODEX_NATIVE_ALIAS_CATALOG_KIND;
}

export function isUnsupportedOpenAiNativeSlug(slug: string): boolean {
  if (slug.includes("/")) return false;
  if (SUPPORTED_NATIVE_OPENAI_SLUGS.has(slug)) return false;
  return /^(?:gpt|codex)-/.test(slug);
}

/**
 * Advertised context for the Codex-login native GPT-5.6 family.
 *
 * This is an OPERATING CAP, not the hard ceiling — the same shape upstream uses. The live
 * catalog reports `context_window: 272000` against a `max_context_window: 872000` for these
 * slugs, and gpt-5.4 runs 272,000 against 1,000,000: the advertised window is always well
 * inside what the model can take.
 *
 * The hard ceiling here was measured on 2026-08-17 against a real Codex-login account:
 * `POST /backend-api/codex/responses` admitted 921,508 input tokens and refused 922,013 with
 * `error.code: context_length_exceeded` on sol, terra and luna alike.
 *
 * Codex spends `context_window * effective_context_window_percent`, which defaults to 95%
 * (codex-rs `openai_models.rs` / `turn_context.rs`). So this value yields a 875,900-token
 * budget and leaves ~46k of headroom under the measured ceiling. An earlier release shipped
 * 1,050,000 here, which spent 997,500 — past what the upstream accepts.
 *
 * Do NOT back-solve this from the ceiling (970,000 would land the budget at 921,500, inside
 * the 1,840-token gap between the last success and the first refusal). The 95% is a safety
 * margin to keep, not a discount to cancel out.
 *
 * Evidence: devlog/_plan/260817_native_gpt56_1m_context/001_measurement_evidence.md
 * and 014_final_922k_with_margin.md.
 */
export const NATIVE_GPT56_CONTEXT_WINDOW = 272_000;

/**
 * Hard ceiling: the largest input the native GPT-5.6 family actually accepts (measured).
 *
 * Equal to the advertised window above rather than below it, because that window is already
 * capped under this ceiling. The clamp stays because routed and API-key rows carry the same
 * family at a 1,050,000 window, where 90% (945,000) WOULD overshoot this limit.
 */
export const NATIVE_GPT56_MAX_INPUT_TOKENS = 922_000;

/** User-facing 1M opt-in: the largest window the native 5.6 family may advertise. */
export const NATIVE_GPT56_OPT_IN_CONTEXT_WINDOW = NATIVE_GPT56_MAX_INPUT_TOKENS;

const NATIVE_GPT56_FAMILY = new Set<string>([
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  NATIVE_DAYBREAK_BLUE_MODEL,
]);

export const NATIVE_OPENAI_CONTEXT_OVERRIDES: Record<string, { contextWindow?: number; maxContextWindow?: number; maxInputTokens?: number }> = {
  "gpt-5.5": { contextWindow: 272_000, maxContextWindow: 272_000 },
  "gpt-5.4": { contextWindow: 1_000_000, maxContextWindow: 1_000_000 },
  "gpt-5.3-codex-spark": { contextWindow: 100_000, maxContextWindow: 100_000 },
  "gpt-5.6-sol": { contextWindow: NATIVE_GPT56_CONTEXT_WINDOW, maxContextWindow: NATIVE_GPT56_MAX_INPUT_TOKENS, maxInputTokens: NATIVE_GPT56_MAX_INPUT_TOKENS },
  "gpt-5.6-terra": { contextWindow: NATIVE_GPT56_CONTEXT_WINDOW, maxContextWindow: NATIVE_GPT56_MAX_INPUT_TOKENS, maxInputTokens: NATIVE_GPT56_MAX_INPUT_TOKENS },
  "gpt-5.6-luna": { contextWindow: NATIVE_GPT56_CONTEXT_WINDOW, maxContextWindow: NATIVE_GPT56_MAX_INPUT_TOKENS, maxInputTokens: NATIVE_GPT56_MAX_INPUT_TOKENS },
  // Daybreak Blue borrows Sol's capability metadata and rides the same family contract.
  // Unlike sol/terra/luna its window was NOT measured here: this account cannot reach it
  // (`400 "The 'gpt-daybreak-blue-latest' model is not supported when using Codex with a
  // ChatGPT account."`), so the promotion rests on a report from an account that has
  // access rather than on a probe. Treat it as the weaker evidence of the four.
  [NATIVE_DAYBREAK_BLUE_MODEL]: { contextWindow: NATIVE_GPT56_CONTEXT_WINDOW, maxContextWindow: NATIVE_GPT56_MAX_INPUT_TOKENS, maxInputTokens: NATIVE_GPT56_MAX_INPUT_TOKENS },
  // gpt-6-astra ships its own numbers (upstream models.json, #42607): a 272,000 default window
  // against an 872,000 ceiling. It is NOT in NATIVE_GPT56_FAMILY, so it must not inherit that
  // family's measured 922,000 clamp — advertising 922,000 here over-stated the ceiling by 50k.
  // maxInputTokens is clamped to the resolved window by nativeOpenAiMaxInputTokens, so this reads
  // 272,000 by default and 872,000 only under the long-window opt-in.
  [NATIVE_GPT6_ASTRA_MODEL]: { contextWindow: 272_000, maxContextWindow: 872_000, maxInputTokens: 872_000 },
};

const PINNED_UPSTREAM_MODELS: Map<string, RawEntry> = new Map(
  ((upstreamModelsSnapshot as unknown as { models?: RawEntry[] }).models ?? [])
    .flatMap(model => typeof model.slug === "string" ? [[model.slug, model] as const] : []),
);

function pinnedNativeCapabilityEntry(slug: string): RawEntry | undefined {
  return PINNED_UPSTREAM_MODELS.get(nativeOpenAiCapabilitySourceSlug(slug));
}

/**
 * Pinned capability metadata is safe to use as a fallback for every supported native model.
 * Keep it separate from UPSTREAM_NATIVE_ENTRIES: that narrower map also authorizes replacing
 * persisted native rows during sync, which is currently intentional only for the GPT-5.6 family.
 */
const PINNED_NATIVE_CAPABILITY_ENTRIES: Map<string, RawEntry> = new Map(
  [...NATIVE_OPENAI_MODELS, ...NATIVE_OPENAI_CAPABILITY_ALIAS_MODELS].flatMap(slug => {
    const entry = pinnedNativeCapabilityEntry(slug);
    return entry ? [[slug, entry] as const] : [];
  }),
);

/**
 * The user-owned levers that set a native window, carried together.
 *
 * For the GPT-5.6 family these may raise the Codex 272k default up to the measured
 * 922k ceiling. Other native slugs still only ever lower.
 *
 * This travels as an ARGUMENT rather than module state on purpose. `grok/sync.ts` runs in
 * the `ocx ensure` parent process, outside the server, so an injected global would never
 * reach it — that failure is recorded in
 * devlog/_plan/260817_native_gpt56_1m_context/006_root_cause_replan.md. Every call site
 * already holds a config or a cap, so passing one more field costs nothing.
 *
 * A bare number is still accepted for the many call sites that only know the cap.
 */
export interface NativeContextLimits {
  /** `providerContextCaps.openai` */
  readonly cap?: number;
  /** `providers.openai.contextWindow` — a floor-wide user override. */
  readonly providerWindow?: number;
  /** `providers.openai.modelContextWindows` — per-model, wins over `providerWindow`. */
  readonly modelWindows?: Readonly<Record<string, number>>;
  /** `providers.openai.modelAutoCompactTokenLimits` — soft, lowering-only budgets. */
  readonly modelAutoCompactTokenLimits?: Readonly<Record<string, number>>;
}

export type NativeContextLimitsInput = NativeContextLimits | number | undefined;

function positiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function asLimits(input: NativeContextLimitsInput): NativeContextLimits {
  if (input === undefined) return {};
  return typeof input === "number" ? { cap: input } : input;
}

/** Read both levers out of a config once, for call sites that hold one. */
export function nativeContextLimits(
  config: Pick<OcxConfig, "providers" | "providerContextCaps">,
): NativeContextLimits {
  const provider = config.providers?.[OPENAI_CODEX_PROVIDER_ID];
  const modelWindows: Record<string, number> = {};
  for (const [slug, value] of Object.entries(provider?.modelContextWindows ?? {})) {
    const window = positiveInt(value);
    if (window !== undefined) modelWindows[slug] = window;
  }
  const modelAutoCompactTokenLimits: Record<string, number> = {};
  for (const [slug, value] of Object.entries(provider?.modelAutoCompactTokenLimits ?? {})) {
    const budget = positiveInt(value);
    if (budget !== undefined) modelAutoCompactTokenLimits[slug] = budget;
  }
  return {
    ...(positiveInt(providerContextCap(config, OPENAI_CODEX_PROVIDER_ID)) !== undefined
      ? { cap: providerContextCap(config, OPENAI_CODEX_PROVIDER_ID) }
      : {}),
    ...(positiveInt(provider?.contextWindow) !== undefined ? { providerWindow: provider!.contextWindow } : {}),
    ...(Object.keys(modelWindows).length > 0 ? { modelWindows } : {}),
    ...(Object.keys(modelAutoCompactTokenLimits).length > 0 ? { modelAutoCompactTokenLimits } : {}),
  };
}

/** Apply the user levers to an authoritative value. */
/**
 * The ceiling a native slug may be RAISED to by a user lever, or undefined when it has no
 * separate long window.
 *
 * This is what makes the dashboard's 1M opt-in work: without an opt-in ceiling a lever can only
 * ever narrow the advertised window, so the toggle would appear to do nothing. The GPT-5.6 family
 * shares one measured ceiling; a self-described native carries its own in
 * `NATIVE_OPENAI_CONTEXT_OVERRIDES.maxContextWindow` (`gpt-6-astra` ships 872,000 against a
 * 272,000 default), and reading it per-slug is what keeps the toggle honest for a model whose
 * ceiling is not the family's.
 */
function longWindowOptInCeiling(slug: string): number | undefined {
  if (NATIVE_GPT56_FAMILY.has(slug)) return NATIVE_GPT56_MAX_INPUT_TOKENS;
  const override = NATIVE_OPENAI_CONTEXT_OVERRIDES[slug];
  const defaultWindow = positiveInt(override?.contextWindow);
  const longWindow = positiveInt(override?.maxContextWindow);
  if (defaultWindow === undefined || longWindow === undefined || longWindow <= defaultWindow) {
    return undefined;
  }
  return longWindow;
}

function narrowToLimits(raw: number | undefined, slug: string, input: NativeContextLimitsInput): number | undefined {
  if (raw === undefined) return undefined;
  const limits = asLimits(input);
  const overlay = positiveInt(limits.modelWindows?.[slug]) ?? positiveInt(limits.providerWindow);
  const cap = positiveInt(limits.cap);
  const optInCeiling = longWindowOptInCeiling(slug);
  if (optInCeiling !== undefined) {
    const ceiling = optInCeiling;
    const chosen = overlay ?? cap ?? raw;
    const window = Math.min(chosen, ceiling);
    return overlay !== undefined && cap !== undefined ? Math.min(window, cap) : window;
  }
  const narrowed = overlay === undefined ? raw : Math.min(raw, overlay);
  return applyProviderContextCap(narrowed, cap) ?? narrowed;
}

export function nativeOpenAiContextWindow(slug: string, limits?: NativeContextLimitsInput): number | undefined {
  const raw = NATIVE_OPENAI_CONTEXT_OVERRIDES[slug]?.contextWindow
    ?? (typeof PINNED_NATIVE_CAPABILITY_ENTRIES.get(slug)?.context_window === "number"
      ? PINNED_NATIVE_CAPABILITY_ENTRIES.get(slug)!.context_window as number
      : undefined);
  return narrowToLimits(raw, slug, limits);
}

export function nativeOpenAiMaxOutputTokens(slug: string): number | undefined {
  const sourceSlug = nativeOpenAiCapabilitySourceSlug(slug);
  return positiveInt(getModelMetadata("openai", sourceSlug)?.maxTokens);
}

/**
 * Long-context tier for a native slug as a (default, long) pair, for clients that let the user
 * pick a window per request (Cursor's local-agent "Context" selector). The pair is the family's
 * pinned default window and its opt-in ceiling, independent of whether the operator has
 * already opted the proxy into the long window: the selector exists so the client can choose.
 * Any user lever below the long window removes the tier: a per-model window override, the
 * provider-level window override, or a provider context cap. A lever at or above it leaves the
 * tier intact (the 922k/1050k opt-in values are the levers, not a request to shrink). Undefined
 * when the family has no separate tier or when the two windows coincide.
 */
export function nativeOpenAiContextTier(
  slug: string,
  limits?: NativeContextLimitsInput,
): { defaultWindow: number; longWindow: number } | undefined {
  const override = NATIVE_OPENAI_CONTEXT_OVERRIDES[slug];
  const defaultWindow = positiveInt(override?.contextWindow);
  const longWindow = positiveInt(override?.maxContextWindow);
  if (defaultWindow === undefined || longWindow === undefined || longWindow <= defaultWindow) return undefined;
  const resolved = asLimits(limits);
  const levers = [
    positiveInt(resolved.modelWindows?.[slug]),
    positiveInt(resolved.providerWindow),
    positiveInt(resolved.cap),
  ];
  if (levers.some(lever => lever !== undefined && lever < longWindow)) return undefined;
  return { defaultWindow, longWindow };
}

/**
 * Largest input a native slug accepts, or undefined when no separate limit is known
 * (the caller then falls back to the context window).
 *
 * A provider context cap lowers this too: a capped 272k window must not keep advertising a
 * 922k input ceiling, or the cap would be cosmetic on every input-side surface.
 */
export function nativeOpenAiMaxInputTokens(slug: string, limits?: NativeContextLimitsInput): number | undefined {
  const raw = NATIVE_OPENAI_CONTEXT_OVERRIDES[slug]?.maxInputTokens;
  if (raw === undefined) return undefined;
  const window = nativeOpenAiContextWindow(slug, limits);
  const narrowed = narrowToLimits(raw, slug, limits) ?? raw;
  return window === undefined ? narrowed : Math.min(narrowed, window);
}

/** Effective native soft budget after every hard window/input limit is resolved. */
export function nativeOpenAiAutoCompactTokenLimit(
  slug: string,
  limits?: NativeContextLimitsInput,
): number | undefined {
  const contextWindow = nativeOpenAiContextWindow(slug, limits);
  if (contextWindow === undefined) return undefined;
  const configured = positiveInt(asLimits(limits).modelAutoCompactTokenLimits?.[slug]);
  return clampAutoCompactTokenLimit(
    contextWindow,
    nativeOpenAiMaxInputTokens(slug, limits),
    configured,
  );
}

export function nativeInputModalities(slug: string): string[] {
  const upstream = PINNED_NATIVE_CAPABILITY_ENTRIES.get(slug);
  if (Array.isArray(upstream?.input_modalities) && upstream!.input_modalities!.length > 0) {
    return [...upstream!.input_modalities as string[]];
  }
  // gpt-5.3-codex-spark is not in the upstream snapshot; all supported natives are
  // text+image capable, so default to the family baseline rather than text-only.
  return ["text", "image"];
}

export function nativeReasoningEfforts(slug: string): string[] {
  const upstream = PINNED_NATIVE_CAPABILITY_ENTRIES.get(slug);
  const levels = Array.isArray(upstream?.supported_reasoning_levels)
    ? upstream!.supported_reasoning_levels as Array<{ effort?: string }>
    : [];
  if (levels.length > 0) {
    // Preserve the exact pinned per-model ladder. In particular, GPT-5.6 Sol and Terra
    // include ultra while Luna intentionally ends at max.
    return levels.flatMap(l => typeof l.effort === "string" ? [l.effort] : []);
  }
  // gpt-5.3-codex-spark is not in upstream snapshot — use the standard old-ladder default.
  return ["low", "medium", "high", "xhigh"];
}

/** Upstream-pinned default for a native slug, when present and non-empty. */
export function nativeDefaultReasoningEffort(slug: string): string | undefined {
  const level = PINNED_NATIVE_CAPABILITY_ENTRIES.get(slug)?.default_reasoning_level;
  return typeof level === "string" && level.length > 0 ? level : undefined;
}

/** Upstream-pinned multi-agent surface for a supported native slug, when present. */
export function nativeMultiAgentVersion(slug: string): string | undefined {
  const version = PINNED_NATIVE_CAPABILITY_ENTRIES.get(slug)?.multi_agent_version;
  return typeof version === "string" && version.length > 0 ? version : undefined;
}

export function nativeParallelToolCalls(slug: string): boolean {
  return PINNED_NATIVE_CAPABILITY_ENTRIES.get(slug)?.supports_parallel_tool_calls === true
    || false;
}

export function hasComboTargets(config: { combos?: Record<string, { targets?: unknown[] }> }): boolean {
  const combos = config.combos;
  if (!combos) return false;
  return Object.values(combos).some(c => Array.isArray(c?.targets) && c!.targets!.length > 0);
}

export function disabledNativeSlugs(config: Pick<OcxConfig, "disabledModels">): Set<string> {
  return new Set((config.disabledModels ?? []).filter(id => !id.includes("/")));
}

export function visibleNativeSlugs(config: Pick<OcxConfig, "disabledModels" | "combos">): string[] {
  const disabled = disabledNativeSlugs(config);
  const shadowed = configuredNativeAliasSlugs(config);
  return nativeOpenAiSlugs().filter(slug => !disabled.has(slug) && !shadowed.has(slug));
}

/** Whether an enabled canonical OpenAI provider can serve exact account-qualified routes. */
export function shouldIncludeAccountBoundNativeOpenAi(
  config: Pick<OcxConfig, "providers">,
): boolean {
  const provider = config.providers[OPENAI_CODEX_PROVIDER_ID];
  if (!provider || provider.disabled === true) return false;
  // Registry routing defaults an omitted authMode on the built-in OpenAI row to forward.
  const canonical = provider.authMode === undefined
    ? { ...provider, authMode: "forward" as const }
    : provider;
  return isCanonicalOpenAiForwardProvider(canonical);
}

/** Whether native ChatGPT/Codex rows belong in this provider configuration. */
export function shouldIncludeNativeOpenAi(config: Pick<OcxConfig, "providers">): boolean {
  const hasEnabledProvider = Object.values(config.providers)
    .some(provider => provider.disabled !== true);
  // Preserve the existing no-enabled-provider catalog bootstrap, but do not use that bootstrap
  // exception for account-qualified rows: exact-account routing requires a live OpenAI provider.
  return !hasEnabledProvider || shouldIncludeAccountBoundNativeOpenAi(config);
}

type AccountSelectorConfig = Pick<
  OcxConfig,
  "codexAccounts" | "codexAccountNamespaces" | "codexAccountPickerEnabled"
>;

function mainAccountSelectors(config: AccountSelectorConfig): string[] {
  const targets = new Map(codexAccountNamespaceEntries(config));
  return visibleCodexAccountSelectors(config).filter(selector =>
    isMainCodexAccountTarget(targets.get(selector) ?? ""));
}

/** Native slugs exposed to Claude Desktop show/export/apply (opt-out via claudeCode.desktopNativeModels). */
export function desktopVisibleNativeSlugs(
  config: Pick<OcxConfig, "claudeCode" | "disabledModels" | "combos" | "providers"
    | "codexAccounts" | "codexAccountNamespaces" | "codexAccountPickerEnabled">,
): string[] {
  if (config.claudeCode?.desktopNativeModels === false) return [];
  const visible = visibleNativeSlugs(config);
  if (!shouldIncludeAccountBoundNativeOpenAi(config)) return visible;
  const qualified = [...accountBoundNativeOpenAiSlugsBySelector(config).entries()].flatMap(([selector, slugs]) =>
    slugs
      .filter(slug => !SUPPORTED_NATIVE_OPENAI_SLUGS.has(slug))
      .map(slug => `${selector}/${slug}`),
  );
  const disabled = new Set(config.disabledModels ?? []);
  return unique([
    ...visible,
    ...qualified.filter(slug => !disabled.has(slug) && !disabled.has(slug.slice(slug.indexOf("/") + 1))),
  ]);
}

export function nativeModelRows(config: Pick<OcxConfig, "disabledModels" | "combos" | "providerContextCaps" | "providers">): Array<{ slug: string; disabled: boolean; contextWindow?: number; maxInputTokens?: number; autoCompactTokenLimit?: number }> {
  const disabled = disabledNativeSlugs(config);
  const shadowed = configuredNativeAliasSlugs(config);
  // Both user levers, not just the cap: a per-model window set from the dashboard has to show
  // up on the row the dashboard itself renders.
  const limits = nativeContextLimits(config);
  const bareEligibleAccountIds = providerCodexAccountMode(
    OPENAI_CODEX_PROVIDER_ID,
    config.providers?.[OPENAI_CODEX_PROVIDER_ID],
  ) === "direct" ? new Set([MAIN_CODEX_ACCOUNT_ID]) : undefined;
  const availableGated = cachedAvailableAccountGatedNativeModels(Date.now(), bareEligibleAccountIds);
  return NATIVE_OPENAI_MODELS
    .filter(slug => !ACCOUNT_GATED_NATIVE_OPENAI_MODELS.has(slug) || availableGated.has(slug))
    .filter(slug => !shadowed.has(slug)).map(slug => {
    const contextWindow = nativeOpenAiContextWindow(slug, limits);
    const maxInputTokens = nativeOpenAiMaxInputTokens(slug, limits);
    const autoCompactTokenLimit = nativeOpenAiAutoCompactTokenLimit(slug, limits);
    return {
      slug,
      disabled: disabled.has(slug),
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      ...(maxInputTokens !== undefined ? { maxInputTokens } : {}),
      ...(autoCompactTokenLimit !== undefined ? { autoCompactTokenLimit } : {}),
    };
  });
}

export function applyNativeVisibility(
  entries: RawEntry[],
  disabledModels: ReadonlySet<string>,
  hideBareNative = false,
  observedNativeSlugs: ReadonlySet<string> = new Set(),
): RawEntry[] {
  for (const entry of entries) {
    if (isNativeAliasCatalogEntry(entry)) continue;
    const slug = typeof entry.slug === "string" ? entry.slug : "";
    const accountBoundSlug = trustedAccountBoundNativeCatalogSlug(entry);
    const nativeSlug = accountBoundSlug ?? slug;
    if (!nativeSlug
      || (!accountBoundSlug && slug.includes("/"))
      || (!SUPPORTED_NATIVE_OPENAI_SLUGS.has(nativeSlug) && !observedNativeSlugs.has(nativeSlug))) continue;
    const disabled = disabledModels.has(nativeSlug)
      || (accountBoundSlug !== undefined && disabledModels.has(slug));
    entry.visibility = disabled || (!accountBoundSlug && hideBareNative)
      ? "hide"
      : "list";
  }
  return entries;
}

function upstreamNativeEntryForSlug(slug: string): RawEntry | undefined {
  const sourceSlug = nativeOpenAiCapabilitySourceSlug(slug);
  // A self-described native returns its OWN pinned row; the alias-cloning branch below stays
  // reserved for slugs that genuinely borrow another model's identity. The allowlist is explicit
  // rather than "has a pinned entry", which would also admit gpt-5.5/gpt-5.4/gpt-5.4-mini into
  // the sync-replacement authority this map carries.
  if (!sourceSlug.startsWith("gpt-5.6-") && !SELF_DESCRIBED_NATIVE_OPENAI_MODELS.has(slug)) {
    return undefined;
  }
  const source = PINNED_UPSTREAM_MODELS.get(sourceSlug);
  if (!source) return undefined;
  if (slug === sourceSlug) return withDerivedBaseInstructions(source);

  const alias = structuredClone(source) as RawEntry;
  alias.slug = slug;
  const presentation = nativeOpenAiAliasPresentation(slug);
  if (!presentation) return undefined; // an alias with no product identity must not ship a wrong one
  alias.display_name = presentation.displayName;
  alias.description = presentation.description;
  if (typeof alias.base_instructions === "string") {
    alias.base_instructions = identifyRoutedModel(alias.base_instructions, slug);
  }
  if (alias.model_messages && typeof alias.model_messages === "object" && !Array.isArray(alias.model_messages)) {
    const modelMessages = alias.model_messages as Record<string, unknown>;
    if (typeof modelMessages.instructions_template === "string") {
      alias.model_messages = {
        ...modelMessages,
        instructions_template: identifyRoutedModel(modelMessages.instructions_template, slug),
      };
    }
  }
  delete alias.availability_nux;
  return alias;
}

/**
 * Backfill `base_instructions` from `model_messages.instructions_template` when upstream ships
 * only the latter.
 *
 * `gpt-6-astra` is the first pinned row to arrive without a top-level `base_instructions`; every
 * other native carries both. That field is not decorative here — `hasNativeCatalogRowShape`,
 * `findNativeTemplate` and `findSupportedNativeTemplate` all test for it, so a row missing it is
 * not recognized as a native catalog row at all. The two fields hold the same prompt upstream, so
 * deriving one from the other preserves upstream's content while keeping this codebase's row
 * shape intact. The pinned JSON is left byte-identical to upstream; only the projection fills in.
 */
function withDerivedBaseInstructions(entry: RawEntry): RawEntry {
  if (typeof entry.base_instructions === "string" && entry.base_instructions.length > 0) return entry;
  const messages = entry.model_messages;
  const template = messages && typeof messages === "object" && !Array.isArray(messages)
    ? (messages as Record<string, unknown>).instructions_template
    : undefined;
  if (typeof template !== "string" || template.length === 0) return entry;
  return { ...entry, base_instructions: template };
}

export const UPSTREAM_NATIVE_ENTRIES: Map<string, RawEntry> = new Map(
  [...NATIVE_OPENAI_MODELS, ...NATIVE_OPENAI_CAPABILITY_ALIAS_MODELS].flatMap(slug => {
    const entry = upstreamNativeEntryForSlug(slug);
    return entry ? [[slug, entry] as const] : [];
  }),
);

export function upstreamNativeEntry(slug: string): RawEntry | null {
  const entry = UPSTREAM_NATIVE_ENTRIES.get(slug);
  if (!entry) return null;
  const clone = JSON.parse(JSON.stringify(entry)) as RawEntry;
  delete clone.minimal_client_version;
  return clone;
}

/**
 * Product label for a native slug whose custom row inherits native metadata.
 *
 * An alias carries a hand-written presentation because upstream never described it. A
 * self-described native gets its label from its own pinned row instead, so the two kinds answer
 * through one accessor and no caller has to know which it holds.
 */
export function nativeOpenAiCapabilityDisplayName(slug: string): string | undefined {
  const presentation = nativeOpenAiAliasPresentation(slug);
  if (presentation) return presentation.displayName;
  const pinned = UPSTREAM_NATIVE_ENTRIES.get(slug);
  return typeof pinned?.display_name === "string" ? pinned.display_name : undefined;
}

/**
 * Slugs whose persisted row may be replaced by the pinned snapshot even when it carries a real
 * display name — because THIS codebase wrote that name from a guess.
 *
 * `shouldUpgradeToUpstreamEntry`'s normal rule ("upgrade only fallback-quality rows, where
 * `display_name === slug`") assumes any row with a real label came from upstream and is therefore
 * authoritative. That assumption broke for `gpt-6-astra`: opencodex shipped a speculative row with
 * a hand-written "GPT-6 Astra" label and a provisional description while the slug was still a leak.
 * Those rows are already on disk in every install that ran that release, and they look genuine, so
 * without this list they would survive every future sync and permanently shadow the real shipped
 * metadata — the wrong label, the wrong 922k ceiling, the wrong priority.
 *
 * Membership is a statement about opencodex's own history, not about upstream. Add a slug only
 * when a released version of this project wrote a fabricated row for it.
 */
const SELF_AUTHORED_NATIVE_ROWS: ReadonlySet<string> = new Set([NATIVE_GPT6_ASTRA_MODEL]);

export function shouldUpgradeToUpstreamEntry(entry: RawEntry): boolean {
  if (typeof entry.slug !== "string" || !UPSTREAM_NATIVE_ENTRIES.has(entry.slug)) return false;
  if (entry.display_name === entry.slug) return true;
  // A row this project authored from a guess is not evidence of upstream truth, however genuine
  // its display name looks. Replace it once, from the pin.
  return SELF_AUTHORED_NATIVE_ROWS.has(entry.slug)
    && entry.display_name !== UPSTREAM_NATIVE_ENTRIES.get(entry.slug)?.display_name;
}

export function nativeOpenAiSlugs(): string[] {
  const live = catalogNativeSlugs();
  const availableGated = cachedAvailableAccountGatedNativeModels();
  const candidates = live.length > 0 ? unique([...live, ...DOCUMENTED_NATIVE_OPENAI_ADDITIONS]) : NATIVE_OPENAI_MODELS;
  return candidates.filter(slug => (
    !ACCOUNT_GATED_NATIVE_OPENAI_MODELS.has(slug) || availableGated.has(slug)
  ));
}

const ACCOUNT_BOUND_OPENAI_NATIVE_PREFIX = /^(?:gpt-|o1-|o3-|o4-)/;
const ACCOUNT_BOUND_OBSERVED_NATIVE_MARKER = "opencodex_account_observed_native";
const ACCOUNT_BOUND_OBSERVED_SELECTORS_MARKER = "opencodex_account_observed_selectors";

function isAccountBoundOpenAiNativeSlug(slug: string): boolean {
  return !slug.includes("/") && ACCOUNT_BOUND_OPENAI_NATIVE_PREFIX.test(slug);
}

/**
 * Shape/plausibility filter for a candidate account-native row. **This is not a trust control.**
 *
 * It checks that a row carries the field shape a real Codex catalog row has, which rejects
 * malformed and minimal hand-written rows. It cannot distinguish a genuine upstream observation
 * from a complete row typed by hand into `$CODEX_HOME/models_cache.json`: there is no signature,
 * source identity, or server attestation to check. A full-shape forged row is accepted, and
 * `observedFullShapeRowIsAccepted` in tests/codex-integration/native-model-toggle.test.ts pins that so nobody
 * later mistakes this predicate for a security boundary.
 *
 * That is acceptable here because the file is user-owned and written by Codex itself: anyone
 * able to rewrite it can already edit `config.json` or run `ocx` directly, and `router.ts`
 * accepts any bare `gpt-*` id under an account namespace regardless of this catalog. What the
 * filter buys is that garbage rows do not get advertised through discovery — not that an
 * advertised row is proven genuine.
 */
function hasNativeCatalogRowShape(entry: RawEntry): boolean {
  const levels = entry.supported_reasoning_levels;
  const messages = entry.model_messages;
  return typeof entry.base_instructions === "string"
    && entry.base_instructions.length > 0
    && (typeof entry.comp_hash === "string" || entry.comp_hash === null)
    && (entry.shell_type === "unified_exec" || entry.shell_type === "shell_command")
    && Array.isArray(levels)
    && levels.length > 0
    && levels.every(level => typeof level === "object" && level !== null
      && typeof (level as { effort?: unknown }).effort === "string")
    && typeof messages === "object"
    && messages !== null
    && !Array.isArray(messages);
}

function observedAccountBoundNativeSlug(entry: RawEntry): string | undefined {
  const accountBound = trustedAccountBoundNativeCatalogSlug(entry);
  const slug = accountBound ?? (typeof entry.slug === "string" ? entry.slug : "");
  if (!isAccountBoundOpenAiNativeSlug(slug)
    || (entry.supported_in_api !== true && !(slug === NATIVE_RESERVE_MODEL && entry.supported_in_api === false))
    || (slug === NATIVE_RESERVE_MODEL && entry[RESERVE_METADATA_SOURCE_FIELD] !== undefined
      && entry[RESERVE_METADATA_SOURCE_FIELD] !== NATIVE_RESERVE_MODEL)
    || !hasNativeCatalogRowShape(entry)
    || (entry.visibility !== "list" && entry[ACCOUNT_BOUND_OBSERVED_NATIVE_MARKER] !== true
      && !(slug === NATIVE_RESERVE_MODEL && entry.visibility === "hide"))) {
    return undefined;
  }
  return slug;
}

/** Prefer a genuine bare observation; an adapted OCX row must never become native evidence. */
export function observedReserveCatalogSource(
  entries: readonly RawEntry[],
  mainSelectors: readonly string[],
): RawEntry | null {
  const actual = entries.filter(entry => observedAccountBoundNativeSlug(entry) === NATIVE_RESERVE_MODEL);
  const bare = actual.find(entry => entry.slug === NATIVE_RESERVE_MODEL);
  const qualified = actual.find(entry => entry[RESERVE_METADATA_SOURCE_FIELD] === NATIVE_RESERVE_MODEL
    && typeof entry.slug === "string"
    && mainSelectors.includes(entry.slug.slice(0, entry.slug.indexOf("/"))));
  const selected = bare ?? qualified;
  if (!selected) return null;
  const source = structuredClone(selected);
  if (!bare) {
    const prefix = `${String(source.slug).split("/")[0]} / `;
    if (typeof source.display_name === "string" && source.display_name.startsWith(prefix)) {
      source.display_name = source.display_name.slice(prefix.length);
    }
  }
  source.slug = NATIVE_RESERVE_MODEL;
  delete source.opencodex_catalog_kind;
  delete source[RESERVE_METADATA_SOURCE_FIELD];
  delete source[ACCOUNT_BOUND_OBSERVED_NATIVE_MARKER];
  delete source[ACCOUNT_BOUND_OBSERVED_SELECTORS_MARKER];
  return source;
}

/**
 * Return exact, previously observed account-native rows that are not in the static release set.
 * The result is used only to carry a hidden observation across startup cache invalidation.
 */
export function observedAccountBoundNativeEntries(
  observedEntries: readonly RawEntry[],
): RawEntry[] {
  const seen = new Set<string>();
  return observedEntries.flatMap(entry => {
    const slug = observedAccountBoundNativeSlug(entry);
    // Only carry bare upstream observations across cache replacement. Account-qualified rows are
    // already a projection of the current selector map and must not preserve private/stale labels.
    if (!slug
      || typeof entry.slug !== "string"
      || entry.slug.includes("/")
      || SUPPORTED_NATIVE_OPENAI_SLUGS.has(slug)
      || seen.has(slug)) return [];
    seen.add(slug);
    return [structuredClone(entry)];
  });
}

/**
 * Native ids observed in the user's Codex catalog/cache for account-qualified discovery.
 *
 * Unknown ids are deliberately returned only to callers that build selector-qualified rows. The
 * static bare set remains the source of truth for global/API-key discovery, while this preserves
 * exact account-scoped ids such as `gpt-daybreak-blue-latest` until the static set catches up.
 */
export function accountBoundNativeOpenAiSlugs(
  observedEntries: readonly RawEntry[] = [
    ...(readCurrentCodexModelsCache()?.models ?? []),
    // Existing generated rows are also safe to reuse after a process starts without a cache
    // invalidation pass; bare user-authored catalog rows are intentionally not trusted here.
    ...(readCurrentCodexCatalog()?.models ?? []).filter(entry =>
      trustedAccountBoundNativeCatalogSlug(entry) !== undefined),
  ],
): string[] {
  const observed = observedEntries.flatMap(entry => {
    const slug = observedAccountBoundNativeSlug(entry);
    // Reserve belongs only to the Codex-specific opt-in builder, not generic native exports.
    return slug === undefined || slug === NATIVE_RESERVE_MODEL ? [] : [slug];
  });
  return unique([...NATIVE_OPENAI_MODELS, ...observed]);
}

/**
 * Resolve account-native ids per public selector. Bare observations come from Codex's main
 * catalog/cache, so they are eligible only for selectors that target the main account. A
 * generated qualified row carries its own selector and never gets copied to an unrelated pool
 * account. An explicit observation marker is public selector metadata only; private account ids
 * never enter the catalog or cache.
 */
export function accountBoundNativeOpenAiSlugsBySelector(
  config: AccountSelectorConfig,
  observedEntries: readonly RawEntry[] = [
    ...(readCurrentCodexModelsCache()?.models ?? []),
    ...(readCurrentCodexCatalog()?.models ?? []).filter(entry =>
      trustedAccountBoundNativeCatalogSlug(entry) !== undefined),
  ],
): ReadonlyMap<string, readonly string[]> {
  const selectors = visibleCodexAccountSelectors(config);
  const mainSelectors = new Set(mainAccountSelectors(config));
  const result = new Map<string, Set<string>>(
    selectors.map(selector => [selector, new Set(NATIVE_OPENAI_MODELS)]),
  );
  for (const entry of observedEntries) {
    const slug = observedAccountBoundNativeSlug(entry);
    if (slug === undefined || slug === NATIVE_RESERVE_MODEL || SUPPORTED_NATIVE_OPENAI_SLUGS.has(slug)) continue;
    const generated = trustedAccountBoundNativeCatalogSlug(entry);
    const generatedSelector = generated === undefined || typeof entry.slug !== "string"
      ? undefined
      : entry.slug.slice(0, entry.slug.indexOf("/"));
    const markedSelectors = Array.isArray(entry[ACCOUNT_BOUND_OBSERVED_SELECTORS_MARKER])
      ? entry[ACCOUNT_BOUND_OBSERVED_SELECTORS_MARKER].filter((value): value is string => typeof value === "string")
      : [];
    const eligible = generatedSelector !== undefined
      ? (mainSelectors.has(generatedSelector) ? [generatedSelector] : [])
      : markedSelectors.length > 0
        ? markedSelectors.filter(selector => mainSelectors.has(selector))
        : [...mainSelectors];
    for (const selector of eligible) {
      const rows = result.get(selector);
      if (rows) rows.add(slug);
    }
  }
  return new Map([...result.entries()].map(([selector, slugs]) => [selector, [...slugs]]));
}

/** Unknown native ids observed from Codex, excluding the static release set. */
export function observedAccountBoundNativeOpenAiSlugs(
  observedEntries?: readonly RawEntry[],
): string[] {
  const all = accountBoundNativeOpenAiSlugs(observedEntries);
  return all.filter(slug => !SUPPORTED_NATIVE_OPENAI_SLUGS.has(slug));
}

function catalogNativeSlugs(): string[] {
  const cat = readCurrentCatalogOrCache();
  const models = cat?.models ?? [];
  const live = models.flatMap(entry => {
    const slug = typeof entry.slug === "string" ? entry.slug : "";
    return !slug.includes("/") && SUPPORTED_NATIVE_OPENAI_SLUGS.has(slug) ? [slug] : [];
  });
  const accountBound = models.flatMap(entry => {
    const slug = trustedAccountBoundNativeCatalogSlug(entry);
    return slug !== undefined && SUPPORTED_NATIVE_OPENAI_SLUGS.has(slug) ? [slug] : [];
  });
  // Deliberately ignore `visibility`: it is a rendered projection of disabledModels and account
  // selectors, so treating it as fresh availability would shrink the supported set between syncs.
  // visibleNativeSlugs applies the current disabledModels source of truth for public consumers.
  return unique([...live, ...accountBound]);
}

export function listCatalogNativeSlugs(): string[] {
  // Ensure documented additions (e.g. gpt-5.3-codex-spark) appear even when the bundled catalog
  // predates the slug — mirrors nativeOpenAiSlugs() which already merges them for /v1/models.
  return unique([...catalogNativeSlugs(), ...DOCUMENTED_NATIVE_OPENAI_ADDITIONS]);
}
