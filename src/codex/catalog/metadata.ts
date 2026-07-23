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
import { getJawcodeModelMetadata, getJawcodeModelMetadataCaseInsensitive, listJawcodeModelMetadata, resolveJawcodeProvider } from "../../generated/jawcode-model-metadata";
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
  listComboIds,
  targetKey,
} from "../../combos";
import type { NormalizedComboConfig } from "../../combos/types";
import { providerDestinationResolvedError } from "../../lib/destination-policy";
import { redactSecretString } from "../../lib/redact";
import upstreamModelsSnapshot from "../data/upstream-models.json";


import { filterSupportedNativeSlugs } from "./parsing";
import type { RawEntry } from "./parsing";
import { readCurrentCatalogOrCache, unique } from "./bundled";
import { ensureGpt56ReasoningLevels, isGpt56NativeSlug } from "./effort";

export const NATIVE_OPENAI_MODELS = [
  "gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex-spark",
  "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna",
];

export const DOCUMENTED_NATIVE_OPENAI_ADDITIONS = [
  "gpt-5.3-codex-spark",
  "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna",
];

export const SUPPORTED_NATIVE_OPENAI_SLUGS = new Set(NATIVE_OPENAI_MODELS);

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

export function nativeOpenAiContextWindow(slug: string): number | undefined {
  return NATIVE_OPENAI_CONTEXT_OVERRIDES[slug]?.contextWindow
    ?? (typeof UPSTREAM_NATIVE_ENTRIES.get(slug)?.context_window === "number"
      ? UPSTREAM_NATIVE_ENTRIES.get(slug)!.context_window as number
      : undefined);
}

export function nativeInputModalities(slug: string): string[] {
  const upstream = UPSTREAM_NATIVE_ENTRIES.get(slug);
  if (Array.isArray(upstream?.input_modalities) && upstream!.input_modalities!.length > 0) {
    return [...upstream!.input_modalities as string[]];
  }
  // gpt-5.3-codex-spark is not in the upstream snapshot; all supported natives are
  // text+image capable, so default to the family baseline rather than text-only.
  return ["text", "image"];
}

export function nativeReasoningEfforts(slug: string): string[] {
  const upstream = UPSTREAM_NATIVE_ENTRIES.get(slug);
  const levels = Array.isArray(upstream?.supported_reasoning_levels)
    ? upstream!.supported_reasoning_levels as Array<{ effort?: string }>
    : [];
  if (levels.length > 0) {
    const efforts = levels.flatMap(l => typeof l.effort === "string" ? [l.effort] : []);
    // gpt-5.6 natives get max+ultra restored (ensureGpt56ReasoningLevels catalog path does
    // the same); older natives (gpt-5.5/5.4/5.4-mini/5.3-codex-spark) stop at xhigh per
    // upstream snapshot.
    if (isGpt56NativeSlug(slug)) {
      const set = new Set(efforts);
      for (const e of ["max", "ultra"]) set.add(e);
      return [...set];
    }
    return efforts;
  }
  // gpt-5.3-codex-spark is not in upstream snapshot — use the standard old-ladder default.
  return ["low", "medium", "high", "xhigh"];
}

export function nativeParallelToolCalls(slug: string): boolean {
  return UPSTREAM_NATIVE_ENTRIES.get(slug)?.supports_parallel_tool_calls === true
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

export function visibleNativeSlugs(config: Pick<OcxConfig, "disabledModels">): string[] {
  const disabled = disabledNativeSlugs(config);
  return nativeOpenAiSlugs().filter(slug => !disabled.has(slug));
}

export function nativeModelRows(config: Pick<OcxConfig, "disabledModels">): Array<{ slug: string; disabled: boolean; contextWindow?: number }> {
  const disabled = disabledNativeSlugs(config);
  return NATIVE_OPENAI_MODELS.map(slug => {
    const contextWindow = nativeOpenAiContextWindow(slug);
    return { slug, disabled: disabled.has(slug), ...(contextWindow !== undefined ? { contextWindow } : {}) };
  });
}

export function applyNativeVisibility(entries: RawEntry[], disabledNative: Set<string>): RawEntry[] {
  for (const entry of entries) {
    const slug = typeof entry.slug === "string" ? entry.slug : "";
    if (!slug || slug.includes("/") || !SUPPORTED_NATIVE_OPENAI_SLUGS.has(slug)) continue;
    entry.visibility = disabledNative.has(slug) ? "hide" : "list";
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
  const live = filterSupportedNativeSlugs(cat?.models ?? []);
  // Ensure documented additions (e.g. gpt-5.3-codex-spark) appear even when the bundled catalog
  // predates the slug — mirrors nativeOpenAiSlugs() which already merges them for /v1/models.
  return unique([...live, ...DOCUMENTED_NATIVE_OPENAI_ADDITIONS]);
}
