import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { atomicWriteFile, expandUserPath, getConfigDir, websocketsEnabled } from "../../config";
import { CODEX_CONFIG_PATH, CODEX_MODELS_CACHE_PATH, DEFAULT_CATALOG_PATH, readRootTomlString, resolveCodexConfigPath } from "../paths";
import { clearModelCache, DEFAULT_MODEL_CACHE_TTL_MS, getFreshCached, getStaleCached, isModelsFetchCoolingDown, markModelsFetchFailure, setCached } from "../model-cache";
import { buildModelsRequest, resolveModelsAuthToken } from "../../oauth";
import type { OcxConfig, OcxProviderConfig } from "../../types";
import { modelInList } from "../../types";
import { CODEX_REASONING_LEVELS, codexEffortRank, configuredReasoningEfforts, modelRecordValue, sanitizeCodexReasoningEfforts } from "../../reasoning-effort";
import { getModelMetadata, getModelMetadataCaseInsensitive, listModelMetadata, resolveMetadataProvider } from "../../generated/model-metadata";
import { enrichProviderFromRegistry, shouldCaseFoldMetadataModelId } from "../../providers/derive";
import { getProviderRegistryEntry } from "../../providers/registry";
import { applyProviderContextCap, providerContextCap } from "../../providers/context-cap";
import { routedSlug, slugEquals, slugsEquivalent } from "../../providers/slug-codec";
import { CODEX_GPT5_IDENTITY_LINE } from "../../adapters/identity";
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
import { readCurrentCatalogOrCache, unique } from "./bundled";
import { trustedAccountBoundNativeCatalogSlug } from "./account-models";
import { CODEX_NATIVE_ALIAS_CATALOG_KIND } from "./kinds";
import { NATIVE_OPENAI_MODELS, SUPPORTED_NATIVE_OPENAI_SLUGS } from "./native-models";
export { CODEX_NATIVE_ALIAS_CATALOG_KIND } from "./kinds";
export { NATIVE_OPENAI_MODELS, SUPPORTED_NATIVE_OPENAI_SLUGS } from "./native-models";

export const DOCUMENTED_NATIVE_OPENAI_ADDITIONS = [
  "gpt-5.3-codex-spark",
  "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna",
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

export const NATIVE_GPT56_CONTEXT_WINDOW = 372_000;

export const NATIVE_OPENAI_CONTEXT_OVERRIDES: Record<string, { contextWindow?: number; maxContextWindow?: number }> = {
  "gpt-5.5": { contextWindow: 272_000, maxContextWindow: 272_000 },
  "gpt-5.4": { contextWindow: 1_000_000, maxContextWindow: 1_000_000 },
  "gpt-5.3-codex-spark": { contextWindow: 100_000, maxContextWindow: 100_000 },
  "gpt-5.6-sol": { contextWindow: NATIVE_GPT56_CONTEXT_WINDOW, maxContextWindow: NATIVE_GPT56_CONTEXT_WINDOW },
  "gpt-5.6-terra": { contextWindow: NATIVE_GPT56_CONTEXT_WINDOW, maxContextWindow: NATIVE_GPT56_CONTEXT_WINDOW },
  "gpt-5.6-luna": { contextWindow: NATIVE_GPT56_CONTEXT_WINDOW, maxContextWindow: NATIVE_GPT56_CONTEXT_WINDOW },
};

/**
 * Pinned capability metadata is safe to use as a fallback for every supported native model.
 * Keep it separate from UPSTREAM_NATIVE_ENTRIES: that narrower map also authorizes replacing
 * persisted native rows during sync, which is currently intentional only for the GPT-5.6 family.
 */
const PINNED_NATIVE_CAPABILITY_ENTRIES: Map<string, RawEntry> = new Map(
  ((upstreamModelsSnapshot as unknown as { models?: RawEntry[] }).models ?? [])
    .filter(m => typeof m.slug === "string"
      && SUPPORTED_NATIVE_OPENAI_SLUGS.has(m.slug as string))
    .map(m => [m.slug as string, m]),
);

export function nativeOpenAiContextWindow(slug: string): number | undefined {
  return NATIVE_OPENAI_CONTEXT_OVERRIDES[slug]?.contextWindow
    ?? (typeof PINNED_NATIVE_CAPABILITY_ENTRIES.get(slug)?.context_window === "number"
      ? PINNED_NATIVE_CAPABILITY_ENTRIES.get(slug)!.context_window as number
      : undefined);
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

/** Native slugs exposed to Claude Desktop show/export/apply (opt-out via claudeCode.desktopNativeModels). */
export function desktopVisibleNativeSlugs(config: Pick<OcxConfig, "claudeCode" | "disabledModels" | "combos">): string[] {
  if (config.claudeCode?.desktopNativeModels === false) return [];
  return visibleNativeSlugs(config);
}

export function nativeModelRows(config: Pick<OcxConfig, "disabledModels" | "combos">): Array<{ slug: string; disabled: boolean; contextWindow?: number }> {
  const disabled = disabledNativeSlugs(config);
  const shadowed = configuredNativeAliasSlugs(config);
  return NATIVE_OPENAI_MODELS.filter(slug => !shadowed.has(slug)).map(slug => {
    const contextWindow = nativeOpenAiContextWindow(slug);
    return { slug, disabled: disabled.has(slug), ...(contextWindow !== undefined ? { contextWindow } : {}) };
  });
}

export function applyNativeVisibility(
  entries: RawEntry[],
  disabledModels: ReadonlySet<string>,
  hideBareNative = false,
): RawEntry[] {
  for (const entry of entries) {
    if (isNativeAliasCatalogEntry(entry)) continue;
    const slug = typeof entry.slug === "string" ? entry.slug : "";
    const accountBoundSlug = trustedAccountBoundNativeCatalogSlug(entry);
    const nativeSlug = accountBoundSlug ?? slug;
    if (!nativeSlug
      || (!accountBoundSlug && slug.includes("/"))
      || !SUPPORTED_NATIVE_OPENAI_SLUGS.has(nativeSlug)) continue;
    const disabled = disabledModels.has(nativeSlug)
      || (accountBoundSlug !== undefined && disabledModels.has(slug));
    entry.visibility = disabled || (!accountBoundSlug && hideBareNative)
      ? "hide"
      : "list";
  }
  return entries;
}

export const UPSTREAM_NATIVE_ENTRIES: Map<string, RawEntry> = new Map(
  ((upstreamModelsSnapshot as unknown as { models?: RawEntry[] }).models ?? [])
    .filter(m => typeof m.slug === "string"
      && SUPPORTED_NATIVE_OPENAI_SLUGS.has(m.slug as string)
      && (m.slug as string).startsWith("gpt-5.6-"))
    .map(m => [m.slug as string, m]),
);

export function upstreamNativeEntry(slug: string): RawEntry | null {
  const entry = UPSTREAM_NATIVE_ENTRIES.get(slug);
  if (!entry) return null;
  const clone = JSON.parse(JSON.stringify(entry)) as RawEntry;
  delete clone.minimal_client_version;
  return clone;
}

export function shouldUpgradeToUpstreamEntry(entry: RawEntry): boolean {
  return typeof entry.slug === "string"
    && UPSTREAM_NATIVE_ENTRIES.has(entry.slug)
    && entry.display_name === entry.slug;
}

export function nativeOpenAiSlugs(): string[] {
  const live = listCatalogNativeSlugs();
  return live.length > 0 ? unique([...live, ...DOCUMENTED_NATIVE_OPENAI_ADDITIONS]) : NATIVE_OPENAI_MODELS;
}

export function listCatalogNativeSlugs(): string[] {
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
  // Ensure documented additions (e.g. gpt-5.3-codex-spark) appear even when the bundled catalog
  // predates the slug — mirrors nativeOpenAiSlugs() which already merges them for /v1/models.
  return unique([...live, ...accountBound, ...DOCUMENTED_NATIVE_OPENAI_ADDITIONS]);
}
