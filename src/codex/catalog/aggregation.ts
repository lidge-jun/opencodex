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
import { CODEX_REASONING_LEVELS, codexEffortRank, configuredReasoningEfforts, modelRecordValue, resolveEffortAtOrBelow, sanitizeCodexReasoningEfforts } from "../../reasoning-effort";
import { getModelMetadata, getModelMetadataCaseInsensitive, listModelMetadata, resolveMetadataProvider } from "../../generated/model-metadata";
import { enrichProviderFromRegistry, shouldCaseFoldMetadataModelId } from "../../providers/derive";
import { getProviderRegistryEntry } from "../../providers/registry";
import { applyProviderContextCap, providerContextCap } from "../../providers/context-cap";
import { clampAutoCompactTokenLimit } from "../../providers/auto-compact-budget";
import { routedSlug, slugEquals, slugEquivalenceKey, slugsEquivalent } from "../../providers/slug-codec";
import { CODEX_GPT5_IDENTITY_LINE } from "../../adapters/identity";
import { filterCursorConfiguredModelsByLiveDiscovery } from "../../adapters/cursor/discovery";
import { fetchCursorUsableModels } from "../../adapters/cursor/live-models";
import { isCanonicalOpenAiForwardProvider, OPENAI_API_PROVIDER_ID, OPENAI_CODEX_PROVIDER_ID } from "../../providers/openai-tiers";
import {
  COMBO_NAMESPACE,
  comboDisabledModelSelectors,
  comboModelId,
  getCombo,
  listComboIds,
  targetKey,
} from "../../combos";
import type { NormalizedComboConfig } from "../../combos/types";
import { providerDestinationResolvedError } from "../../lib/destination-policy";
import { redactSecretString } from "../../lib/redact";
import upstreamModelsSnapshot from "../data/upstream-models.json";


import { catalogModelSlug } from "./parsing";
import type { CatalogModel } from "./parsing";

export const openAiApiCollisionWarnings = new Set<string>();

export const comboCatalogWarningSignatures = new Map<string, string>();

/**
 * Why `deriveComboCatalogModel` rejected a configured combo (#484 / #516).
 * Distinguishes unresolved/incomplete member metadata from a complete but empty
 * modality intersection so diagnostics do not send operators to the wrong fix.
 */
export type ComboCatalogOmissionReason =
  | "incomplete_metadata"
  | "incompatible_modalities";

/** Combos omitted from the catalog during the most recent `gatherRoutedModels` call (#484). */
export interface ComboCatalogOmission {
  id: string;
  targets: string[];
  reason: ComboCatalogOmissionReason;
  message: string;
}

let lastComboCatalogOmissions: ComboCatalogOmission[] = [];

export function clearLastComboCatalogOmissions(): void {
  lastComboCatalogOmissions = [];
}

export function getLastComboCatalogOmissions(): readonly ComboCatalogOmission[] {
  return lastComboCatalogOmissions;
}

export function replaceLastComboCatalogOmissions(items: readonly ComboCatalogOmission[]): void {
  lastComboCatalogOmissions = [...items];
}

export function intersectStrings(values: readonly string[][]): string[] {
  if (values.length === 0) return [];
  const rest = values.slice(1).map(value => new Set(value));
  return [...new Set(values[0])].filter(value => rest.every(set => set.has(value)));
}

/**
 * The catalog's view of a combo's default effort. Delegates to the shared leaf
 * resolver so the request path (src/combos/request.ts) cannot drift from what the
 * catalog advertised (#3108).
 */
export function effectiveComboDefault(
  configured: string | null | undefined,
  common: readonly string[],
): string | undefined {
  return resolveEffortAtOrBelow(configured, common);
}

/**
 * Classify a combo derivation failure. Returns `null` when the combo would catalog.
 * Callers that already know derivation failed can map the reason into diagnostics.
 */
export function comboCatalogOmissionReason(
  combo: NormalizedComboConfig,
  members: readonly CatalogModel[],
): ComboCatalogOmissionReason | null {
  if (combo.targets.length === 0) return "incomplete_metadata";
  if (new Set(combo.targets.map(targetKey)).size !== combo.targets.length) {
    return "incomplete_metadata";
  }
  if (members.length !== combo.targets.length) return "incomplete_metadata";
  if (!members.every((member, index) => (
    `${member.provider}/${member.id}` === targetKey(combo.targets[index]!)
  ))) {
    return "incomplete_metadata";
  }
  const contexts = members.map(member => member.contextWindow);
  if (contexts.some(value => typeof value !== "number" || value <= 0)) {
    return "incomplete_metadata";
  }

  const inputModalities = intersectStrings(
    members.map(member => member.inputModalities ?? ["text"]),
  );
  if (inputModalities.length === 0) return "incompatible_modalities";
  return null;
}

export function deriveComboCatalogModel(
  id: string,
  combo: NormalizedComboConfig,
  members: readonly CatalogModel[],
): CatalogModel | null {
  if (comboCatalogOmissionReason(combo, members) !== null) return null;

  const derivedInputModalities = intersectStrings(
    members.map(member => member.inputModalities ?? ["text"]),
  );
  const inputModalities = combo.imageInput === "disabled"
    ? derivedInputModalities.filter(modality => modality !== "image")
    : derivedInputModalities;
  if (inputModalities.length === 0) return null;
  // Unknown ladders (`undefined`) are wildcards for catalog derivation — same
  // boundary as the GUI picker. Under the default `strict` mode an explicit empty
  // ladder still constrains, so one target that advertises no effort control empties
  // the whole combo's picker. `adaptive` is the opt-in for mixed-capability groups:
  // empty ladders drop out of the published intersection while non-empty ladders
  // still define it. Dispatch is unaffected either way — each concrete target
  // resolves its own effort at request time.
  const knownLadders = members
    .map(member => member.reasoningEfforts)
    .filter((ladder): ladder is string[] => ladder !== undefined);
  const advertisedLadders = combo.reasoningEffortMode === "adaptive"
    ? knownLadders.filter(ladder => ladder.length > 0)
    : knownLadders;
  const reasoningEfforts = advertisedLadders.length === 0
    ? []
    : intersectStrings(advertisedLadders);
  const contextWindow = Math.min(...members.map(member => member.contextWindow!));
  const limitingMembers = members.filter(member => member.contextWindow === contextWindow);
  const hasLimitingContextCapMetadata = limitingMembers.some(
    member => typeof member.contextCapped === "boolean",
  );
  // A combo is cap-limited only when every member defining its effective minimum was
  // itself reduced by a provider cap. An uncapped member at the same minimum means the
  // combo would have the same window even without the cap.
  const contextCapped = limitingMembers.every(member => member.contextCapped === true);
  const maxInputTokens = Math.min(
    contextWindow,
    ...members.map(member => member.maxInputTokens ?? member.contextWindow!),
  );
  const knownMaxOutputTokens = members
    .map(member => member.maxOutputTokens)
    .filter((value): value is number => typeof value === "number" && value > 0);
  const maxOutputTokens = knownMaxOutputTokens.length === members.length
    ? Math.min(...knownMaxOutputTokens)
    : undefined;
  const autoCompactTokenLimit = Math.min(
    ...members.map(member => clampAutoCompactTokenLimit(
      member.contextWindow!,
      member.maxInputTokens,
      member.autoCompactTokenLimit,
    )),
  );
  const defaultReasoningEffort = effectiveComboDefault(
    combo.defaultEffort,
    reasoningEfforts,
  );

  return {
    provider: COMBO_NAMESPACE,
    id,
    owned_by: COMBO_NAMESPACE,
    contextWindow,
    maxInputTokens,
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    autoCompactTokenLimit,
    ...(hasLimitingContextCapMetadata ? { contextCapped } : {}),
    inputModalities,
    reasoningEfforts,
    ...(combo.alias ? { alias: combo.alias } : {}),
    ...(combo.nativeAlias ? { nativeAlias: true } : {}),
    ...(combo.displayName ? { displayName: combo.displayName } : {}),
    ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
    ...(members.every(member => member.parallelToolCalls === true)
      ? { parallelToolCalls: true }
      : {}),
    ...(members.every(member => member.supportsServiceTier === true)
      ? { supportsServiceTier: true }
      : members.some(member => member.supportsServiceTier === false)
        ? { supportsServiceTier: false }
        : {}),
    ...(members.some(member => member.supportsReasoningSummaries === false) ? { supportsReasoningSummaries: false } : {}),
    // A combo is only as capable as its least capable member. One member that cannot honour
    // text.verbosity is enough to make the control a no-op for the whole combo, so the
    // conservative false propagates — the same rule supportsReasoningSummaries uses above.
    // Without this, routing a combo through an xAI or Kiro member re-advertised a control the
    // upstream accepts and ignores.
    ...(members.some(member => member.supportsVerbosity === false) ? { supportsVerbosity: false } : {}),
    ...(members.every(member => member.codexToolMode === "shell")
      ? { codexToolMode: "shell" as const }
      : {}),
  };
}

export function safeCatalogWarningLabel(value: string): string {
  return redactSecretString(value)
    .replace(/[\u0000-\u001f\u007f]/g, "?")
    .slice(0, 200);
}

export function comboCatalogWarningSignature(
  combo: NormalizedComboConfig,
  members: readonly CatalogModel[],
): string {
  const discovered = new Map<string, CatalogModel>(members.map(member => [
    `${member.provider}/${member.id}`,
    member,
  ] as const));
  return JSON.stringify(combo.targets.map(target => {
    const key = targetKey(target);
    const member = discovered.get(key);
    return {
      key,
      contextWindow: member?.contextWindow ?? null,
      maxInputTokens: member?.maxInputTokens ?? null,
      autoCompactTokenLimit: member?.autoCompactTokenLimit ?? null,
      inputModalities: [...new Set(member?.inputModalities ?? [])].sort(),
      reasoningEfforts: [...new Set(member?.reasoningEfforts ?? [])].sort(),
      parallelToolCalls: member?.parallelToolCalls === true,
      supportsReasoningSummaries: member?.supportsReasoningSummaries !== false,
    };
  }).sort((a, b) => a.key.localeCompare(b.key)));
}

export function comboCatalogOmissionDetail(reason: ComboCatalogOmissionReason): string {
  return reason === "incompatible_modalities"
    ? "members have no common input modalities"
    : "member capabilities are incomplete";
}

/** One-line sync/CLI summary that respects the actual omission reason(s). */
export function summarizeComboCatalogOmissions(
  omissions: readonly Pick<ComboCatalogOmission, "reason">[],
): string {
  const n = omissions.length;
  const prefix = `${n} combo${n === 1 ? "" : "s"} omitted from the catalog`;
  if (n === 0) return prefix + ".";
  const reasons = new Set(omissions.map(item => item.reason));
  if (reasons.size === 1) {
    return `${prefix} because ${comboCatalogOmissionDetail([...reasons][0]!)}.`;
  }
  return `${prefix}.`;
}

export function buildComboCatalogOmission(
  id: string,
  combo: NormalizedComboConfig,
  members: readonly CatalogModel[],
): ComboCatalogOmission {
  const targets = combo.targets
    .map(target => safeCatalogWarningLabel(targetKey(target)))
    .sort((a, b) => a.localeCompare(b));
  const reason = comboCatalogOmissionReason(combo, members) ?? "incomplete_metadata";
  return {
    id,
    targets,
    reason,
    message: `[opencodex] Combo "${safeCatalogWarningLabel(id)}" is omitted from the catalog because ${comboCatalogOmissionDetail(reason)}: ${targets.join(", ")}.`,
  };
}

/**
 * Record a combo omitted from `/v1/models` + on-disk catalog and warn once per signature.
 * Callers that need a race-free list (catalog sync) pass a local `sink` from the same
 * gather invocation instead of reading process-global state afterward (#484 review).
 */
export function warnUncataloguedComboOnce(
  id: string,
  combo: NormalizedComboConfig,
  members: readonly CatalogModel[],
  sink: ComboCatalogOmission[] = lastComboCatalogOmissions,
): ComboCatalogOmission {
  const omission = buildComboCatalogOmission(id, combo, members);
  sink.push(omission);
  const signature = comboCatalogWarningSignature(combo, members);
  if (comboCatalogWarningSignatures.get(id) !== signature) {
    comboCatalogWarningSignatures.set(id, signature);
    console.warn(omission.message);
  }
  return omission;
}

export function exactComboCatalogSlugs(
  config: Pick<OcxConfig, "combos" | "disabledModels">,
): Set<string> {
  const disabled = new Set(config.disabledModels ?? []);
  return new Set(listComboIds(config).flatMap(id => {
    const raw = config.combos?.[id];
    const alias = typeof raw?.alias === "string"
      ? raw.alias.trim()
      : "";
    const canonical = comboModelId(id);
    const publicSlug = alias || canonical;
    const comboDisabled = comboDisabledModelSelectors(id, raw ?? {})
      .some(selector => disabled.has(selector));
    return comboDisabled ? [] : [publicSlug];
  }));
}

export function normalizedOpenAiApiSignature(model: CatalogModel): string {
  const normalized = {
    provider: model.provider,
    id: model.id,
    contextWindow: model.contextWindow ?? null,
    maxInputTokens: model.maxInputTokens ?? null,
    maxOutputTokens: model.maxOutputTokens ?? null,
    autoCompactTokenLimit: model.autoCompactTokenLimit ?? null,
    inputModalities: [...new Set(model.inputModalities ?? [])].sort(),
    reasoningEfforts: [...new Set(model.reasoningEfforts ?? [])].sort(),
    ownedBy: model.owned_by ?? null,
  };
  return JSON.stringify(normalized);
}

export function resetOpenAiApiCatalogWarningStateForTests(): void {
  openAiApiCollisionWarnings.clear();
}

export const slugAliasCollisionWarnings = new Set<string>();

export const comboMasqueradeCollisionWarnings = new Set<string>();

export const comboUnrestorableShadowWarnings = new Set<string>();

export const accountSelectorShadowCollisionWarnings = new Set<string>();
let lastWarningReconciledGeneration = 0;

export function reconcileCatalogWarningMemos(generation: number): number {
  if (generation <= lastWarningReconciledGeneration) return 0;
  const removed = openAiApiCollisionWarnings.size
    + comboCatalogWarningSignatures.size
    + slugAliasCollisionWarnings.size
    + comboMasqueradeCollisionWarnings.size
    + comboUnrestorableShadowWarnings.size
    + accountSelectorShadowCollisionWarnings.size;
  openAiApiCollisionWarnings.clear();
  comboCatalogWarningSignatures.clear();
  slugAliasCollisionWarnings.clear();
  comboMasqueradeCollisionWarnings.clear();
  comboUnrestorableShadowWarnings.clear();
  accountSelectorShadowCollisionWarnings.clear();
  lastWarningReconciledGeneration = generation;
  return removed;
}

export function warnComboMasqueradeCollisionOnce(slug: string): void {
  if (comboMasqueradeCollisionWarnings.has(slug)) return;
  comboMasqueradeCollisionWarnings.add(slug);
  console.warn(
    `[opencodex] combo alias collision on "${safeCatalogWarningLabel(slug)}": the combo wins and the shadowed provider model is omitted from the catalog.`,
  );
}

export function warnComboUnrestorableShadowOnce(slug: string): void {
  const key = slugEquivalenceKey(slug);
  if (comboUnrestorableShadowWarnings.has(key)) return;
  comboUnrestorableShadowWarnings.add(key);
  console.warn(
    `[opencodex] combo alias collision on "${safeCatalogWarningLabel(slug)}": the existing user-managed or foreign catalog row is retained because no pristine backup can restore it. Rename the combo alias to expose both models.`,
  );
}

/** Warn once when a live provider row loses its reserved slug to an account selector. */
export function warnAccountSelectorShadowedProviderOnce(slug: string): void {
  if (accountSelectorShadowCollisionWarnings.has(slug)) return;
  accountSelectorShadowCollisionWarnings.add(slug);
  console.warn(
    `[opencodex] account selector collision on "${safeCatalogWarningLabel(slug)}": the account-bound native model wins and the shadowed provider model is omitted from the catalog. Rename the provider or account selector.`,
  );
}

export function resolveSlugAliasCollisions(goModels: CatalogModel[]): Set<CatalogModel> {
  const skipped = new Set<CatalogModel>();
  const winnerByAlias = new Map<string, CatalogModel>();
  for (const m of goModels) {
    // Combo aliases have their own collision policy below: they always shadow provider rows.
    if (m.provider === COMBO_NAMESPACE) continue;
    const key = catalogModelSlug(m);
    const winner = winnerByAlias.get(key);
    if (!winner) {
      winnerByAlias.set(key, m);
      continue;
    }
    const winnerIsPlainAlias = !winner.id.includes("/");
    const currentIsPlainAlias = !m.id.includes("/");
    if (currentIsPlainAlias && !winnerIsPlainAlias) {
      skipped.add(winner);
      winnerByAlias.set(key, m);
    } else {
      skipped.add(m);
    }
    if (!slugAliasCollisionWarnings.has(key)) {
      slugAliasCollisionWarnings.add(key);
      console.warn(
        `[opencodex] slug alias collision on "${key}": multiple native ids encode to the same Codex-facing slug; `
        + "the plain-hyphen native id is cataloged, the slash id remains callable via its raw selector.",
      );
    }
  }
  return skipped;
}

export function uniqueCatalogModelsForPublicList(goModels: CatalogModel[]): CatalogModel[] {
  const collisionSkipped = resolveSlugAliasCollisions(goModels);
  const comboPublicSlugs = new Set(goModels
    .filter(model => model.provider === COMBO_NAMESPACE)
    .map(catalogModelSlug));
  const seen = new Set<string>();
  const out: CatalogModel[] = [];
  for (const model of goModels) {
    if (collisionSkipped.has(model)) continue;
    const slug = catalogModelSlug(model);
    if (model.provider !== COMBO_NAMESPACE && comboPublicSlugs.has(slug)) {
      warnComboMasqueradeCollisionOnce(slug);
      continue;
    }
    if (seen.has(slug)) continue;
    seen.add(slug);
    out.push(model);
  }
  return out;
}

export function uniqueCatalogModelsForRawPublicList(goModels: CatalogModel[]): CatalogModel[] {
  const publicId = (model: CatalogModel): string => model.alias ?? `${model.provider}/${model.id}`;
  const comboPublicIds = new Set(goModels
    .filter(model => model.provider === COMBO_NAMESPACE)
    .map(publicId));
  const seen = new Set<string>();
  const out: CatalogModel[] = [];
  for (const model of goModels) {
    const id = publicId(model);
    if (model.provider !== COMBO_NAMESPACE && comboPublicIds.has(id)) {
      warnComboMasqueradeCollisionOnce(id);
      continue;
    }
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(model);
  }
  return out;
}
