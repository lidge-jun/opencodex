import type { CodexAccountMode, OcxConfig, OcxProviderConfig } from "../types";
import { OPENAI_PROVIDER_TIER_VERSION } from "../types";

export const OPENAI_CODEX_PROVIDER_ID = "openai";
export const LEGACY_OPENAI_MULTI_PROVIDER_ID = "openai-multi";
export const OPENAI_API_PROVIDER_ID = "openai-apikey";
export const LEGACY_CHATGPT_PROVIDER_ID = "chatgpt";

const CODEX_FORWARD_BASE_URL = "https://chatgpt.com/backend-api/codex";
const LEGACY_OPENAI_MULTI_PREFIX = `${LEGACY_OPENAI_MULTI_PROVIDER_ID}/`;

function canonicalCodexForwardProvider(mode: CodexAccountMode): OcxProviderConfig {
  return {
    adapter: "openai-responses",
    baseUrl: CODEX_FORWARD_BASE_URL,
    authMode: "forward",
    codexAccountMode: mode,
  };
}

function normalizedBaseUrl(value: string): string | undefined {
  try {
    const url = new URL(value.trim());
    if (url.username || url.password || url.search || url.hash) return undefined;
    const path = url.pathname.replace(/\/+$/, "");
    return `${url.origin}${path}`;
  } catch {
    return undefined;
  }
}

export function isCanonicalOpenAiForwardProvider(provider: OcxProviderConfig): boolean {
  return provider.adapter === "openai-responses"
    && provider.authMode === "forward"
    && normalizedBaseUrl(provider.baseUrl) === CODEX_FORWARD_BASE_URL;
}

export interface OpenAiTierMigrationProjection {
  config: OcxConfig;
  changed: boolean;
  resolvedMode: CodexAccountMode;
  warnings: string[];
}

export class OpenAiTierMigrationCollisionError extends Error {
  readonly providerName = LEGACY_OPENAI_MULTI_PROVIDER_ID;

  constructor() {
    super(`Reserved provider id "${LEGACY_OPENAI_MULTI_PROVIDER_ID}" is already configured with a noncanonical shape`);
    this.name = "OpenAiTierMigrationCollisionError";
  }
}

function managedLegacyMultiOverlay(provider: OcxProviderConfig): Pick<OcxProviderConfig, "disabled" | "selectedModels"> | null {
  const allowed = new Set(["adapter", "authMode", "baseUrl", "disabled", "selectedModels"]);
  if (!Object.keys(provider).every(key => allowed.has(key))) return null;
  if (!isCanonicalOpenAiForwardProvider(provider)) return null;
  if (provider.disabled !== undefined && typeof provider.disabled !== "boolean") return null;
  if (provider.selectedModels !== undefined && (
    !Array.isArray(provider.selectedModels)
    || provider.selectedModels.some(model => typeof model !== "string")
  )) return null;
  return {
    ...(provider.disabled !== undefined ? { disabled: provider.disabled } : {}),
    ...(provider.selectedModels !== undefined ? { selectedModels: [...provider.selectedModels] } : {}),
  };
}

function rewriteLegacyOpenAiSelectedId(value: string): string {
  return value.startsWith(LEGACY_OPENAI_MULTI_PREFIX)
    ? value.slice(LEGACY_OPENAI_MULTI_PREFIX.length)
    : value;
}

function rewriteLegacyOpenAiModelList(values: string[] | undefined): string[] | undefined {
  if (!values) return undefined;
  return [...new Set(values.map(rewriteLegacyOpenAiSelectedId))];
}

function mergeLegacyOpenAiProviderRows(
  openai: OcxProviderConfig | undefined,
  legacyMulti: OcxProviderConfig | undefined,
  mode: CodexAccountMode,
): OcxProviderConfig {
  const selectedModels = rewriteLegacyOpenAiModelList([
    ...(openai?.selectedModels ?? []),
    ...(legacyMulti?.selectedModels ?? []),
  ]);
  const formerRows = [openai, legacyMulti].filter((row): row is OcxProviderConfig => row !== undefined);
  const disabled = formerRows.length > 0 && formerRows.every(row => row.disabled === true);
  return {
    ...canonicalCodexForwardProvider(mode),
    ...(disabled ? { disabled: true } : {}),
    ...(selectedModels && selectedModels.length > 0 ? { selectedModels } : {}),
  };
}

function hasKnownLegacyOpenAiReference(config: OcxConfig): boolean {
  const matches = (value: unknown): boolean => typeof value === "string" && value.startsWith(LEGACY_OPENAI_MULTI_PREFIX);
  const matchesList = (value: unknown): boolean => Array.isArray(value) && value.some(matches);
  const claude = config.claudeCode;
  return config.defaultProvider === LEGACY_OPENAI_MULTI_PROVIDER_ID
    || matchesList(config.disabledModels)
    || matchesList(config.subagentModels)
    || matches(config.injectionModel)
    || matches(config.shadowCallIntercept?.model)
    || matches(config.webSearchSidecar?.model)
    || matches(config.visionSidecar?.model)
    || matches(claude?.webSearchSidecar?.model)
    || matches(claude?.visionSidecar?.model)
    || matches(claude?.model)
    || matches(claude?.smallFastModel)
    || Object.values(claude?.tierModels ?? {}).some(matches)
    || Object.values(claude?.modelMap ?? {}).some(matches)
    || matchesList(config.providers[OPENAI_CODEX_PROVIDER_ID]?.selectedModels)
    || matchesList(config.providers[LEGACY_OPENAI_MULTI_PROVIDER_ID]?.selectedModels)
    || config.providerContextCaps?.[LEGACY_OPENAI_MULTI_PROVIDER_ID] !== undefined;
}

function rewriteLegacyOpenAiReferences(config: OcxConfig, warnings: string[]): void {
  config.disabledModels = rewriteLegacyOpenAiModelList(config.disabledModels);
  config.subagentModels = rewriteLegacyOpenAiModelList(config.subagentModels);
  if (config.injectionModel) config.injectionModel = rewriteLegacyOpenAiSelectedId(config.injectionModel);
  if (config.shadowCallIntercept?.model) {
    config.shadowCallIntercept.model = rewriteLegacyOpenAiSelectedId(config.shadowCallIntercept.model);
  }
  if (config.webSearchSidecar?.model) config.webSearchSidecar.model = rewriteLegacyOpenAiSelectedId(config.webSearchSidecar.model);
  if (config.visionSidecar?.model) config.visionSidecar.model = rewriteLegacyOpenAiSelectedId(config.visionSidecar.model);

  const claude = config.claudeCode;
  if (claude?.webSearchSidecar?.model) claude.webSearchSidecar.model = rewriteLegacyOpenAiSelectedId(claude.webSearchSidecar.model);
  if (claude?.visionSidecar?.model) claude.visionSidecar.model = rewriteLegacyOpenAiSelectedId(claude.visionSidecar.model);
  if (claude?.model) claude.model = rewriteLegacyOpenAiSelectedId(claude.model);
  if (claude?.smallFastModel) claude.smallFastModel = rewriteLegacyOpenAiSelectedId(claude.smallFastModel);
  if (claude?.tierModels) {
    for (const tier of ["opus", "sonnet", "haiku", "fable"] as const) {
      const value = claude.tierModels[tier];
      if (value) claude.tierModels[tier] = rewriteLegacyOpenAiSelectedId(value);
    }
  }
  if (claude?.modelMap) {
    for (const key of Object.keys(claude.modelMap)) {
      claude.modelMap[key] = rewriteLegacyOpenAiSelectedId(claude.modelMap[key]!);
    }
  }

  const caps = config.providerContextCaps;
  const legacyCap = caps?.[LEGACY_OPENAI_MULTI_PROVIDER_ID];
  if (caps && legacyCap !== undefined) {
    const currentCap = caps[OPENAI_CODEX_PROVIDER_ID];
    if (currentCap !== undefined) {
      caps[OPENAI_CODEX_PROVIDER_ID] = Math.min(currentCap, legacyCap);
      warnings.push("providerContextCaps.openai + providerContextCaps.openai-multi: kept lower positive cap");
    } else {
      caps[OPENAI_CODEX_PROVIDER_ID] = legacyCap;
    }
    delete caps[LEGACY_OPENAI_MULTI_PROVIDER_ID];
  }
}

function isKnownLegacyValuePath(path: readonly string[]): boolean {
  const joined = path.join(".");
  if (joined === "defaultProvider") return true;
  if (/^(disabledModels|subagentModels)\.\d+$/.test(joined)) return true;
  if (/^providers\.(openai|openai-multi)\.selectedModels\.\d+$/.test(joined)) return true;
  return new Set([
    "injectionModel",
    "shadowCallIntercept.model",
    "webSearchSidecar.model",
    "visionSidecar.model",
    "claudeCode.webSearchSidecar.model",
    "claudeCode.visionSidecar.model",
    "claudeCode.model",
    "claudeCode.smallFastModel",
    "claudeCode.tierModels.opus",
    "claudeCode.tierModels.sonnet",
    "claudeCode.tierModels.haiku",
    "claudeCode.tierModels.fable",
  ]).has(joined) || /^claudeCode\.modelMap\..+$/.test(joined);
}

function unknownLegacyOpenAiWarnings(config: OcxConfig): string[] {
  const warnings = new Set<string>();
  const visit = (value: unknown, path: string[]): void => {
    if (typeof value === "string") {
      if (value.includes(LEGACY_OPENAI_MULTI_PROVIDER_ID) && !isKnownLegacyValuePath(path)) {
        warnings.add(`${path.join(".")}: legacy OpenAI provider id left unchanged`);
      }
      return;
    }
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, [...path, String(index)]));
      return;
    }
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      visit(item, [...path, key]);
    }
  };
  visit(config, []);
  return [...warnings];
}

function resolvedOpenAiMode(
  config: OcxConfig,
  openai: OcxProviderConfig | undefined,
  legacyMulti: OcxProviderConfig | undefined,
  knownLegacyReference: boolean,
): CodexAccountMode {
  if (openai?.codexAccountMode === "pool" || openai?.codexAccountMode === "direct") {
    return openai.codexAccountMode;
  }
  if (
    (legacyMulti && legacyMulti.disabled !== true)
    || config.defaultProvider === LEGACY_OPENAI_MULTI_PROVIDER_ID
    || knownLegacyReference
  ) return "pool";
  if (config.openaiProviderTierVersion === 1 && openai) return "direct";
  if (config.openaiProviderTierVersion === 1 && legacyMulti) return "pool";
  return "pool";
}

export function projectOpenAiTierMigration(config: OcxConfig): OpenAiTierMigrationProjection {
  const projected = structuredClone(config);
  const legacyMulti = projected.providers[LEGACY_OPENAI_MULTI_PROVIDER_ID];
  if (legacyMulti && !managedLegacyMultiOverlay(legacyMulti)) {
    throw new OpenAiTierMigrationCollisionError();
  }

  const openai = projected.providers[OPENAI_CODEX_PROVIDER_ID];
  const knownLegacyReference = hasKnownLegacyOpenAiReference(projected);
  const resolvedMode = resolvedOpenAiMode(projected, openai, legacyMulti, knownLegacyReference);
  if (
    projected.openaiProviderTierVersion === OPENAI_PROVIDER_TIER_VERSION
    && !legacyMulti
    && !Object.hasOwn(projected.providers, LEGACY_CHATGPT_PROVIDER_ID)
    && projected.defaultProvider !== LEGACY_OPENAI_MULTI_PROVIDER_ID
    && !knownLegacyReference
  ) {
    return { config: projected, changed: false, resolvedMode, warnings: [] };
  }

  const warnings = unknownLegacyOpenAiWarnings(projected);
  const referencesCodexForward = !!openai
    || !!legacyMulti
    || Object.hasOwn(projected.providers, LEGACY_CHATGPT_PROVIDER_ID)
    || projected.defaultProvider === OPENAI_CODEX_PROVIDER_ID
    || projected.defaultProvider === LEGACY_OPENAI_MULTI_PROVIDER_ID
    || projected.defaultProvider === LEGACY_CHATGPT_PROVIDER_ID
    || knownLegacyReference;
  const mergedOpenAi = referencesCodexForward
    ? mergeLegacyOpenAiProviderRows(openai, legacyMulti, resolvedMode)
    : undefined;

  const nextProviders: Array<[string, OcxProviderConfig]> = [];
  let inserted = false;
  for (const [name, provider] of Object.entries(projected.providers)) {
    if (name === OPENAI_CODEX_PROVIDER_ID) {
      if (mergedOpenAi && !inserted) nextProviders.push([OPENAI_CODEX_PROVIDER_ID, mergedOpenAi]);
      inserted = true;
      continue;
    }
    if (name === LEGACY_OPENAI_MULTI_PROVIDER_ID || name === LEGACY_CHATGPT_PROVIDER_ID) {
      if (mergedOpenAi && !inserted && !openai) {
        nextProviders.push([OPENAI_CODEX_PROVIDER_ID, mergedOpenAi]);
        inserted = true;
      }
      continue;
    }
    nextProviders.push([name, provider]);
  }
  if (mergedOpenAi && !inserted) nextProviders.push([OPENAI_CODEX_PROVIDER_ID, mergedOpenAi]);
  projected.providers = Object.fromEntries(nextProviders);

  if (
    projected.defaultProvider === LEGACY_OPENAI_MULTI_PROVIDER_ID
    || projected.defaultProvider === LEGACY_CHATGPT_PROVIDER_ID
  ) projected.defaultProvider = OPENAI_CODEX_PROVIDER_ID;

  rewriteLegacyOpenAiReferences(projected, warnings);
  projected.openaiProviderTierVersion = OPENAI_PROVIDER_TIER_VERSION;
  return { config: projected, changed: true, resolvedMode, warnings: [...new Set(warnings)] };
}
