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


import { readCatalog, readCodexCatalogPath } from "./parsing";
import type { CatalogModel, RawEntry } from "./parsing";
import { UPSTREAM_NATIVE_ENTRIES } from "./metadata";
import { loadBundledCodexCatalog } from "./bundled";
import type { BundledCatalogDeps } from "./bundled";
import { deriveEntry } from "./sync";
import {
  formatClampLogLines,
  formatRuntimeLogLine,
  displayCodexRuntimePath,
  persistEffortClamp,
  resolveAndPersistCodexRuntime,
  type EffortClampDiagnostic,
} from "../runtime";

export function nativeEffortClamp(slug: string, effort: string | undefined): string | null {
  if (!effort || (effort !== "max" && effort !== "ultra")) return null;
  if (slug.includes("/")) return null; // routed models map efforts in their adapters
  const entry = UPSTREAM_NATIVE_ENTRIES.get(slug);
  const levels = Array.isArray(entry?.supported_reasoning_levels)
    ? entry.supported_reasoning_levels as Array<{ effort?: string }>
    : [];
  if (levels.length === 0) {
    // Not snapshot-covered. gpt-5.6 natives have a REAL max rung (ensureGpt56ReasoningLevels
    // restores it even off-snapshot) -> never clamp. Every other bare native (gpt-5.5/5.4/
    // 5.4-mini/5.3-codex-spark and future old-ladder slugs) really stops at xhigh — the
    // ChatGPT backend error names exactly none..xhigh — so clamp the synthetic top tier.
    return isGpt56NativeSlug(slug) ? null : "xhigh";
  }
  const supported = levels.flatMap(l => typeof l.effort === "string" ? [l.effort] : []);
  if (supported.includes(effort)) return null;
  const rank = ["minimal", "low", "medium", "high", "xhigh", "max"];
  const highest = supported
    .filter(e => rank.includes(e))
    .sort((a, b) => rank.indexOf(a) - rank.indexOf(b))
    .at(-1);
  return highest ?? null;
}

export function shouldApplyNativeEffortClamp(
  providerName: string,
  provider: OcxProviderConfig,
  requestedModelId: string,
): boolean {
  return !requestedModelId.includes("/")
    && providerName === OPENAI_CODEX_PROVIDER_ID
    && isCanonicalOpenAiForwardProvider(provider);
}

export function catalogModelEfforts(slugs: readonly string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (slugs.length === 0) return out;
  const catalog = readCatalog(readCodexCatalogPath());
  if (!catalog) return out;
  for (const entry of catalog.models ?? []) {
    if (typeof entry.slug !== "string") continue;
    // Tolerate raw legacy config slugs (`provider/vendor/model`) against the
    // Codex-facing encoded catalog slug (`provider/vendor-model`).
    const callerSlug = slugs.find(s => slugsEquivalent(s, entry.slug as string));
    if (callerSlug === undefined) continue;
    const levels = Array.isArray(entry.supported_reasoning_levels)
      ? entry.supported_reasoning_levels as Array<{ effort?: string }>
      : [];
    const efforts = levels.flatMap(l => typeof l.effort === "string" ? [l.effort] : []);
    if (efforts.length > 0) out.set(callerSlug, efforts);
  }
  return out;
}

export function catalogEntryEfforts(entry: RawEntry): string[] {
  const levels = Array.isArray(entry.supported_reasoning_levels)
    ? entry.supported_reasoning_levels as Array<{ effort?: string }>
    : [];
  return levels.flatMap(level => typeof level.effort === "string" ? [level.effort] : []);
}

export const ROUTED_REASONING_LEVELS = [...CODEX_REASONING_LEVELS];

export function applyCatalogModelMetadata(entry: RawEntry, model?: CatalogModel): void {
  if (!model) return;
  // This marker survives strict catalog normalization and lets sync distinguish a stale
  // bare combo alias from a genuine native model row.
  if (model.provider === COMBO_NAMESPACE) entry.owned_by = model.owned_by ?? COMBO_NAMESPACE;
  // displayName is DISPLAY-ONLY: it relabels the picker row but never touches the routing
  // slug, alias, or provider. deriveEntry already stamped the slug as display_name; a
  // configured displayName overrides just the label. The `/` separator is rejected at every
  // input boundary (CLI `ocx models add`, management API), so the catalog trusts its source.
  // Combos carry no displayName, and natives never reach here (no CatalogModel), so genuine
  // upstream marketing names and combo alias labels are preserved untouched.
  const displayName = typeof model.displayName === "string" ? model.displayName.trim() : "";
  if (displayName) entry.display_name = displayName;
  if (typeof model.contextWindow === "number" && model.contextWindow > 0) {
    entry.context_window = model.contextWindow;
    entry.max_context_window = model.contextWindow;
    entry.auto_compact_token_limit = Math.min(
      Math.floor(model.contextWindow * 0.9),
      model.maxInputTokens ?? Number.POSITIVE_INFINITY,
    );
  }
  if (Array.isArray(model.inputModalities) && model.inputModalities.length > 0) {
    entry.input_modalities = model.inputModalities;
  }
  if (typeof model.supportsVerbosity === "boolean") {
    entry.support_verbosity = model.supportsVerbosity;
  }
  if (typeof model.supportsReasoningSummaries === "boolean") {
    entry.supports_reasoning_summaries = model.supportsReasoningSummaries;
  }
}

export function applyReasoningLevels(
  entry: RawEntry,
  effortsOverride?: string[],
  defaultOverride?: string,
  preserveExact = false,
): void {
  let efforts = sanitizeCodexReasoningEfforts(effortsOverride) ?? ROUTED_REASONING_LEVELS.map(l => l.effort);
  // Mock top tiers (user decision 260709): every reasoning-capable model advertises `max`
  // even when the provider ladder stops lower — subagent spawns pass `max` DIRECTLY
  // (no ultra->max client conversion) and codex-rs validates it by catalog membership,
  // so a missing max rung hard-fails spawn_agent effort overrides. The wire stays honest:
  // routed adapters clamp via clampToSupportedCodexEffort and natives via
  // nativeEffortClamp (max -> the model's real top rung).
  if (!preserveExact && efforts.length > 0) {
    const additions: string[] = [];
    if (!efforts.includes("max")) additions.push("max");
    if (!efforts.includes("ultra")) additions.push("ultra");
    if (additions.length > 0) efforts = sanitizeCodexReasoningEfforts([...efforts, ...additions]) ?? efforts;
  }
  const byEffort = new Map(
    (Array.isArray(entry.supported_reasoning_levels) ? entry.supported_reasoning_levels : [])
      .map((l: { effort?: string }) => [l.effort, l]),
  );
  entry.supported_reasoning_levels = efforts.map(effort => {
    const native = byEffort.get(effort);
    if (native) return native;
    // Description lookup uses the FULL ladder so an opt-in effort outside the routed default
    // (e.g. "ultra") still renders its canonical description.
    return CODEX_REASONING_LEVELS.find(l => l.effort === effort) ?? { effort, description: `${effort} reasoning` };
  });
  if (efforts.length === 0) {
    delete entry.default_reasoning_level;
    return;
  }
  entry.default_reasoning_level = defaultOverride && efforts.includes(defaultOverride)
    ? defaultOverride
    : efforts.includes("medium") ? "medium" : efforts.includes("high") ? "high" : efforts[0];
}

export function isGpt56NativeSlug(slug: string): boolean {
  return !slug.includes("/") && slug.startsWith("gpt-5.6-");
}

export function ensureGpt56ReasoningLevels(entry: RawEntry): void {
  const levels = Array.isArray(entry.supported_reasoning_levels)
    ? entry.supported_reasoning_levels as Array<{ effort?: string }>
    : [];
  const out = [...levels];
  // max is a real native rung on the 5.6 family — always restored; ultra always advertised.
  for (const effort of ["max", "ultra"]) {
    if (out.some(level => level.effort === effort)) continue;
    out.push(CODEX_REASONING_LEVELS.find(level => level.effort === effort)
      ?? { effort, description: `${effort} reasoning` });
  }
  entry.supported_reasoning_levels = out;
}

export function ensureUltraReasoningLevel(entry: RawEntry): void {
  const levels = Array.isArray(entry.supported_reasoning_levels)
    ? entry.supported_reasoning_levels as Array<{ effort?: string }>
    : [];
  if (levels.length === 0) return;
  const wanted = ["max", "ultra"];
  for (const effort of wanted) {
    if (levels.some(level => level.effort === effort)) continue;
    levels.push(
      CODEX_REASONING_LEVELS.find(level => level.effort === effort)
        ?? { effort, description: `${effort} reasoning` },
    );
  }
  entry.supported_reasoning_levels = levels;
}

export function codexSupportedReasoningEfforts(deps: BundledCatalogDeps = {}): Set<string> | null {
  const bundled = loadBundledCodexCatalog(deps);
  if (!bundled) return null;
  const efforts = new Set<string>();
  for (const model of bundled.models ?? []) {
    if (typeof model.slug !== "string" || model.slug.includes("/")) continue;
    const levels = Array.isArray(model.supported_reasoning_levels) ? model.supported_reasoning_levels : [];
    for (const level of levels) {
      const effort = (level as { effort?: unknown })?.effort;
      if (typeof effort === "string") efforts.add(effort);
    }
    if (typeof model.default_reasoning_level === "string") efforts.add(model.default_reasoning_level);
  }
  return efforts.size > 0 ? efforts : null;
}

export function clampedDefaultEffort(original: string, surviving: readonly string[]): string {
  if (surviving.length === 0) return "medium";
  const ranked = [...surviving]
    .map(effort => ({ effort, rank: codexEffortRank(effort) }))
    .sort((a, b) => a.rank - b.rank);
  const originalRank = codexEffortRank(original);
  const atOrBelow = ranked.filter(item => item.rank >= 0 && item.rank <= originalRank);
  return (atOrBelow.at(-1) ?? ranked[0]!).effort;
}

export function clampEntryToCodexSupportedEfforts(entry: RawEntry, supported: Set<string> | null): void {
  if (!supported) return;
  const levels = Array.isArray(entry.supported_reasoning_levels)
    ? entry.supported_reasoning_levels as Array<{ effort?: string }>
    : null;
  if (levels && levels.length > 0) {
    const kept = levels.filter(level => typeof level?.effort === "string" && supported.has(level.effort));
    entry.supported_reasoning_levels = kept.length > 0
      ? kept
      : CODEX_REASONING_LEVELS
        .filter(level => level.effort === "low" || level.effort === "medium" || level.effort === "high")
        .map(level => ({ ...level }));
  }
  const currentDefault = entry.default_reasoning_level;
  if (typeof currentDefault === "string" && !supported.has(currentDefault)) {
    const surviving = (Array.isArray(entry.supported_reasoning_levels) ? entry.supported_reasoning_levels : [])
      .flatMap(level => typeof (level as { effort?: string })?.effort === "string"
        ? [(level as { effort: string }).effort]
        : []);
    entry.default_reasoning_level = clampedDefaultEffort(currentDefault, surviving);
  }
}

export function clampCatalogModelsToCodexSupport(models: RawEntry[], deps: BundledCatalogDeps = {}): RawEntry[] {
  const supported = codexSupportedReasoningEfforts(deps);
  if (!supported) {
    if (!deps.commandCandidates) persistEffortClamp(null);
    return models;
  }

  const removed = new Set<string>();
  const affected: string[] = [];
  for (const entry of models) {
    const before = new Set(
      (Array.isArray(entry.supported_reasoning_levels) ? entry.supported_reasoning_levels : [])
        .flatMap(level => typeof (level as { effort?: string })?.effort === "string"
          ? [(level as { effort: string }).effort]
          : []),
    );
    clampEntryToCodexSupportedEfforts(entry, supported);
    const after = new Set(
      (Array.isArray(entry.supported_reasoning_levels) ? entry.supported_reasoning_levels : [])
        .flatMap(level => typeof (level as { effort?: string })?.effort === "string"
          ? [(level as { effort: string }).effort]
          : []),
    );
    const lost = [...before].filter(effort => !after.has(effort));
    if (lost.length > 0) {
      for (const effort of lost) removed.add(effort);
      if (typeof entry.slug === "string") affected.push(entry.slug);
    }
  }

  let runtimePath = "codex";
  let runtimeVersion: string | null = null;
  if (!deps.commandCandidates) {
    try {
      const resolved = resolveAndPersistCodexRuntime({
        execFileSync: deps.execFileSync as never,
      });
      runtimePath = resolved.runtime.command;
      runtimeVersion = resolved.runtime.version;
      console.warn(formatRuntimeLogLine(resolved.runtime));
      if (
        resolved.replacedConfigured
        && resolved.replacedConfigured.from.command !== resolved.runtime.command
      ) {
        console.warn(`[opencodex] Preferred Codex runtime is unavailable.`);
        console.warn(
          `[opencodex] Falling back from ${displayCodexRuntimePath(resolved.replacedConfigured.from.command)} to ${displayCodexRuntimePath(runtimePath)}.`,
        );
      }
    } catch { /* best-effort */ }
  }

  if (removed.size > 0) {
    const diagnostic: EffortClampDiagnostic = {
      runtimePath,
      runtimeVersion,
      removedEfforts: [...removed].sort(),
      affectedModels: affected,
    };
    for (const line of formatClampLogLines(diagnostic)) console.warn(line);
    if (!deps.commandCandidates) persistEffortClamp(diagnostic);
    deps.onEffortClamp?.(diagnostic);
  } else if (!deps.commandCandidates) {
    persistEffortClamp(null);
  }

  return models;
}
