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


import { catalogModelSlug } from "./parsing";
import type { CatalogModel } from "./parsing";

export const openAiApiCollisionWarnings = new Set<string>();

export const comboCatalogWarningSignatures = new Map<string, string>();

export function intersectStrings(values: readonly string[][]): string[] {
  if (values.length === 0) return [];
  const rest = values.slice(1).map(value => new Set(value));
  return [...new Set(values[0])].filter(value => rest.every(set => set.has(value)));
}

export function effectiveComboDefault(
  configured: string | null | undefined,
  common: readonly string[],
): string | undefined {
  if (!configured) return undefined;
  if (configured && common.includes(configured)) return configured;
  const requestedRank = codexEffortRank(configured);
  const ranked = common
    .map(effort => ({ effort, rank: codexEffortRank(effort) }))
    .filter(item => item.rank >= 0)
    .sort((a, b) => a.rank - b.rank);
  if (ranked.length === 0) return undefined;
  const atOrBelow = ranked.filter(item => item.rank <= requestedRank);
  return atOrBelow.at(-1)?.effort ?? ranked[0]!.effort;
}

export function deriveComboCatalogModel(
  id: string,
  combo: NormalizedComboConfig,
  members: readonly CatalogModel[],
): CatalogModel | null {
  if (combo.targets.length === 0) return null;
  if (new Set(combo.targets.map(targetKey)).size !== combo.targets.length) return null;
  if (members.length !== combo.targets.length) return null;
  if (!members.every((member, index) => (
    `${member.provider}/${member.id}` === targetKey(combo.targets[index]!)
  ))) return null;
  const contexts = members.map(member => member.contextWindow);
  if (contexts.some(value => typeof value !== "number" || value <= 0)) return null;

  const inputModalities = intersectStrings(
    members.map(member => member.inputModalities ?? ["text"]),
  );
  if (inputModalities.length === 0) return null;
  const reasoningEfforts = intersectStrings(
    members.map(member => member.reasoningEfforts ?? []),
  );
  const contextWindow = Math.min(...contexts as number[]);
  const maxInputTokens = Math.min(
    ...members.map(member => member.maxInputTokens ?? member.contextWindow!),
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
    inputModalities,
    reasoningEfforts,
    ...(combo.alias ? { alias: combo.alias } : {}),
    ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
    ...(members.every(member => member.parallelToolCalls === true)
      ? { parallelToolCalls: true }
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
      inputModalities: [...new Set(member?.inputModalities ?? [])].sort(),
      reasoningEfforts: [...new Set(member?.reasoningEfforts ?? [])].sort(),
      parallelToolCalls: member?.parallelToolCalls === true,
    };
  }).sort((a, b) => a.key.localeCompare(b.key)));
}

export function warnUncataloguedComboOnce(
  id: string,
  combo: NormalizedComboConfig,
  members: readonly CatalogModel[],
): void {
  const signature = comboCatalogWarningSignature(combo, members);
  if (comboCatalogWarningSignatures.get(id) === signature) return;
  comboCatalogWarningSignatures.set(id, signature);
  const targets = combo.targets
    .map(target => safeCatalogWarningLabel(targetKey(target)))
    .sort((a, b) => a.localeCompare(b));
  console.warn(
    `[opencodex] Combo "${safeCatalogWarningLabel(id)}" is omitted from the catalog because member capabilities are incomplete: ${targets.join(", ")}.`,
  );
}

export function exactComboCatalogSlugs(
  config: Pick<OcxConfig, "combos" | "disabledModels">,
): Set<string> {
  const disabled = new Set(config.disabledModels ?? []);
  return new Set(listComboIds(config).flatMap(id => {
    const alias = typeof config.combos?.[id]?.alias === "string"
      ? config.combos[id]!.alias!.trim()
      : "";
    const canonical = comboModelId(id);
    const publicSlug = alias || canonical;
    return disabled.has(publicSlug) || disabled.has(canonical) ? [] : [publicSlug];
  }));
}

export function normalizedOpenAiApiSignature(model: CatalogModel): string {
  const normalized = {
    provider: model.provider,
    id: model.id,
    contextWindow: model.contextWindow ?? null,
    maxInputTokens: model.maxInputTokens ?? null,
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

export function warnComboMasqueradeCollisionOnce(slug: string): void {
  if (comboMasqueradeCollisionWarnings.has(slug)) return;
  comboMasqueradeCollisionWarnings.add(slug);
  console.warn(
    `[opencodex] combo alias collision on "${safeCatalogWarningLabel(slug)}": the combo wins and the shadowed provider model is omitted from the catalog.`,
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
