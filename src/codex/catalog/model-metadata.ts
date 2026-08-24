import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile, getConfigDir } from "../../config";
import { isModelCacheGenerationCurrent } from "../model-cache";
import type { GenerationContext } from "../../lib/state-store-sweeper";
import { captureConfigGeneration } from "../../lib/state-store-sweeper";
import { assertNotRealHomeUnderTest } from "../../lib/test-home-guard";
import { CURSOR_STATIC_MODELS } from "../../adapters/cursor/discovery";
import { cursorModelEffortLadder } from "../../adapters/cursor/effort-map";
import { generatedModelMetadata, type CatalogModel } from "./parsing";

/** Codex strict-parser placeholder; must never be treated as discovered evidence. */
export const COMPATIBILITY_CONTEXT_WINDOW = 128_000;

export type ModelMetadataSource =
  | "live"
  | "registry"
  | "snapshot"
  | "config_fallback"
  | "unknown"
  | "derived";

export interface ModelMetadataFields {
  contextWindow?: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  inputModalities?: string[];
  reasoningEfforts?: string[];
  capabilities?: string[];
}

export type ModelMetadataFieldSources = {
  contextWindow?: ModelMetadataSource;
  maxInputTokens?: ModelMetadataSource;
  maxOutputTokens?: ModelMetadataSource;
  inputModalities?: ModelMetadataSource;
  reasoningEfforts?: ModelMetadataSource;
  capabilities?: ModelMetadataSource;
};

export interface ModelMetadataLayer extends ModelMetadataFields {
  observedAt?: string;
}

export interface UserContextCaps {
  /** `providers.*.modelContextWindows[id]` */
  modelWindow?: number;
  /** `providers.*.contextWindow` */
  providerWindow?: number;
  /** `providerContextCaps[provider]` */
  providerCap?: number;
  /** `providers.*.modelMaxInputTokens[id]` */
  maxInputCap?: number;
}

export interface ResolveModelMetadataInput {
  live?: ModelMetadataLayer;
  liveFresh?: boolean;
  snapshot?: ModelMetadataLayer;
  registry?: ModelMetadataLayer;
  caps?: UserContextCaps;
}

export interface ResolvedModelMetadata extends ModelMetadataFields {
  source: ModelMetadataSource;
  observedAt?: string;
  stale: boolean;
  contextCapped?: boolean;
  contextCap?: number;
  /** Pre-cap discovered window, used by the Models UI when a cap lowered it. */
  detectedContextWindow?: number;
  fieldSources: ModelMetadataFieldSources;
}

const NUMERIC_FIELDS = ["contextWindow", "maxInputTokens", "maxOutputTokens"] as const;
const LIST_FIELDS = ["inputModalities", "reasoningEfforts", "capabilities"] as const;

function positiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function copyList(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const out = value.filter((item): item is string => typeof item === "string" && item.length > 0);
  return out.length > 0 ? [...out] : undefined;
}

/** Lowest explicit cap among the three user levers; never used to raise a known window. */
export function effectiveUserContextCap(caps: UserContextCaps | undefined): number | undefined {
  if (!caps) return undefined;
  const model = positiveInt(caps.modelWindow);
  const provider = positiveInt(caps.providerWindow);
  const providerCap = positiveInt(caps.providerCap);
  if (model !== undefined) return providerCap !== undefined ? Math.min(model, providerCap) : model;
  if (provider !== undefined) return providerCap !== undefined ? Math.min(provider, providerCap) : provider;
  return providerCap;
}

function layerHasFreshLive(input: ResolveModelMetadataInput): boolean {
  return input.liveFresh === true && input.live !== undefined;
}

function pickNumeric(
  input: ResolveModelMetadataInput,
  field: (typeof NUMERIC_FIELDS)[number],
): { value: number; source: ModelMetadataSource; observedAt?: string } | undefined {
  const liveValue = positiveInt(input.live?.[field]);
  if (layerHasFreshLive(input) && liveValue !== undefined) {
    return { value: liveValue, source: "live", observedAt: input.live?.observedAt };
  }
  const snapshotValue = positiveInt(input.snapshot?.[field]);
  const registryValue = positiveInt(input.registry?.[field]);
  if (input.liveFresh === true) {
    if (snapshotValue !== undefined) {
      return { value: snapshotValue, source: "snapshot", observedAt: input.snapshot?.observedAt };
    }
    if (registryValue !== undefined) {
      return { value: registryValue, source: "registry", observedAt: input.registry?.observedAt };
    }
    return undefined;
  }
  if (registryValue !== undefined) {
    return { value: registryValue, source: "registry", observedAt: input.registry?.observedAt };
  }
  if (snapshotValue !== undefined) {
    return { value: snapshotValue, source: "snapshot", observedAt: input.snapshot?.observedAt };
  }
  return undefined;
}

function pickList(
  input: ResolveModelMetadataInput,
  field: (typeof LIST_FIELDS)[number],
): { value: string[]; source: ModelMetadataSource; observedAt?: string } | undefined {
  const liveValue = copyList(input.live?.[field]);
  if (layerHasFreshLive(input) && liveValue !== undefined) {
    return { value: liveValue, source: "live", observedAt: input.live?.observedAt };
  }
  const snapshotValue = copyList(input.snapshot?.[field]);
  const registryValue = copyList(input.registry?.[field]);
  if (input.liveFresh === true) {
    if (snapshotValue !== undefined) {
      return { value: snapshotValue, source: "snapshot", observedAt: input.snapshot?.observedAt };
    }
    if (registryValue !== undefined) {
      return { value: registryValue, source: "registry", observedAt: input.registry?.observedAt };
    }
    return undefined;
  }
  if (registryValue !== undefined) {
    return { value: registryValue, source: "registry", observedAt: input.registry?.observedAt };
  }
  if (snapshotValue !== undefined) {
    return { value: snapshotValue, source: "snapshot", observedAt: input.snapshot?.observedAt };
  }
  return undefined;
}

function clampToCap(value: number, cap: number | undefined): number {
  if (cap === undefined) return value;
  return value > cap ? cap : value;
}

export function resolveModelMetadata(input: ResolveModelMetadataInput): ResolvedModelMetadata {
  const cap = effectiveUserContextCap(input.caps);
  const maxInputCap = positiveInt(input.caps?.maxInputCap);
  const fieldSources: ModelMetadataFieldSources = {};
  let observedAt: string | undefined;
  let stale = false;

  const takeObserved = (layerAt?: string, source?: ModelMetadataSource) => {
    if (source === "snapshot") stale = true;
    if (!observedAt && typeof layerAt === "string" && layerAt.length > 0) observedAt = layerAt;
  };

  const contextPick = pickNumeric(input, "contextWindow");
  let contextWindow = contextPick?.value;
  let contextSource = contextPick?.source;
  takeObserved(contextPick?.observedAt, contextPick?.source);

  let contextCapped = false;
  if (contextWindow !== undefined) {
    const lowered = clampToCap(contextWindow, cap);
    contextCapped = cap !== undefined && lowered < contextPick!.value;
    contextWindow = lowered;
    fieldSources.contextWindow = contextSource;
  } else if (cap !== undefined) {
    contextWindow = cap;
    contextSource = "config_fallback";
    fieldSources.contextWindow = "config_fallback";
  }

  const maxInputPick = pickNumeric(input, "maxInputTokens");
  let maxInputTokens = maxInputPick?.value;
  takeObserved(maxInputPick?.observedAt, maxInputPick?.source);
  if (maxInputTokens !== undefined) {
    maxInputTokens = clampToCap(maxInputTokens, maxInputCap);
    if (contextWindow !== undefined) maxInputTokens = Math.min(maxInputTokens, contextWindow);
    fieldSources.maxInputTokens = maxInputPick!.source;
  } else if (maxInputCap !== undefined) {
    maxInputTokens = contextWindow !== undefined ? Math.min(maxInputCap, contextWindow) : maxInputCap;
    fieldSources.maxInputTokens = "config_fallback";
  } else if (contextWindow !== undefined && contextCapped) {
    maxInputTokens = contextWindow;
    fieldSources.maxInputTokens = fieldSources.contextWindow;
  }

  const maxOutputPick = pickNumeric(input, "maxOutputTokens");
  if (maxOutputPick) {
    fieldSources.maxOutputTokens = maxOutputPick.source;
    takeObserved(maxOutputPick.observedAt, maxOutputPick.source);
  }

  const modalitiesPick = pickList(input, "inputModalities");
  if (modalitiesPick) {
    fieldSources.inputModalities = modalitiesPick.source;
    takeObserved(modalitiesPick.observedAt, modalitiesPick.source);
  }
  const effortsPick = pickList(input, "reasoningEfforts");
  if (effortsPick) {
    fieldSources.reasoningEfforts = effortsPick.source;
    takeObserved(effortsPick.observedAt, effortsPick.source);
  }
  const capabilitiesPick = pickList(input, "capabilities");
  if (capabilitiesPick) {
    fieldSources.capabilities = capabilitiesPick.source;
    takeObserved(capabilitiesPick.observedAt, capabilitiesPick.source);
  }

  const source: ModelMetadataSource = contextSource
    ?? modalitiesPick?.source
    ?? maxOutputPick?.source
    ?? "unknown";
  const detectedContextWindow = contextPick?.value;

  return {
    source,
    stale,
    fieldSources,
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(maxInputTokens !== undefined ? { maxInputTokens } : {}),
    ...(maxOutputPick ? { maxOutputTokens: maxOutputPick.value } : {}),
    ...(modalitiesPick ? { inputModalities: modalitiesPick.value } : {}),
    ...(effortsPick ? { reasoningEfforts: effortsPick.value } : {}),
    ...(capabilitiesPick ? { capabilities: capabilitiesPick.value } : {}),
    ...(observedAt ? { observedAt } : {}),
    ...(cap !== undefined ? { contextCap: cap } : {}),
    ...(contextWindow !== undefined ? { contextCapped } : {}),
    ...(detectedContextWindow !== undefined ? { detectedContextWindow } : {}),
  };
}

export function shouldStampContextProvenance(
  model: Pick<CatalogModel, "contextWindow" | "metadataSource" | "metadataFieldSources">,
): boolean {
  if (typeof model.contextWindow !== "number" || model.contextWindow <= 0) return false;
  if (model.metadataSource === "unknown" || model.metadataSource === "config_fallback") return false;
  if (model.metadataFieldSources?.contextWindow === "config_fallback") return false;
  if (model.metadataSource === undefined && model.contextWindow === COMPATIBILITY_CONTEXT_WINDOW) {
    return false;
  }
  return model.metadataSource === "live"
    || model.metadataSource === "registry"
    || model.metadataSource === "snapshot"
    || model.metadataSource === "derived"
    || (model.metadataSource === undefined && model.contextWindow !== COMPATIBILITY_CONTEXT_WINDOW);
}

export function applyResolvedMetadataToCatalogModel(
  model: CatalogModel,
  resolved: ResolvedModelMetadata,
): CatalogModel {
  return {
    ...model,
    ...(resolved.contextWindow !== undefined ? { contextWindow: resolved.contextWindow } : {}),
    ...(resolved.maxInputTokens !== undefined ? { maxInputTokens: resolved.maxInputTokens } : {}),
    ...(resolved.maxOutputTokens !== undefined ? { maxOutputTokens: resolved.maxOutputTokens } : {}),
    ...(resolved.inputModalities ? { inputModalities: resolved.inputModalities } : {}),
    ...(resolved.reasoningEfforts ? { reasoningEfforts: resolved.reasoningEfforts } : {}),
    ...(resolved.capabilities ? { capabilities: resolved.capabilities } : {}),
    metadataSource: resolved.source,
    metadataStale: resolved.stale,
    ...(resolved.observedAt ? { metadataObservedAt: resolved.observedAt } : {}),
    ...(resolved.fieldSources ? { metadataFieldSources: resolved.fieldSources } : {}),
    ...(resolved.contextCap !== undefined ? { contextCap: resolved.contextCap } : {}),
    ...(resolved.contextCapped !== undefined ? { contextCapped: resolved.contextCapped } : {}),
    ...(resolved.detectedContextWindow !== undefined
      ? { detectedContextWindow: resolved.detectedContextWindow }
      : {}),
  };
}

export const MODEL_METADATA_CACHE_FILENAME = "model-metadata-cache.json";
const SNAPSHOT_VERSION = 1;
const SNAPSHOT_MAX_ROWS = 8_192;
const SNAPSHOT_ID_MAX = 256;
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

export type LiveSnapshotRow = ModelMetadataLayer & { id: string };

type SnapshotFile = {
  version: number;
  models: Record<string, ModelMetadataLayer>;
};

let diskHydrated = false;
const snapshotRows = new Map<string, ModelMetadataLayer>();
let lastSnapshotReconciledGeneration = 0;

function trimSnapshotRowsToCap(): void {
  if (snapshotRows.size <= SNAPSHOT_MAX_ROWS) return;
  const ranked = [...snapshotRows.entries()].sort((a, b) => {
    const aAt = Date.parse(a[1].observedAt ?? "") || 0;
    const bAt = Date.parse(b[1].observedAt ?? "") || 0;
    return aAt - bAt;
  });
  const drop = ranked.length - SNAPSHOT_MAX_ROWS;
  for (let i = 0; i < drop; i += 1) snapshotRows.delete(ranked[i]![0]);
}

export function snapshotKey(provider: string, modelId: string): string {
  return `${provider}/${modelId}`;
}

function sanitizeIdentity(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > SNAPSHOT_ID_MAX) return undefined;
  if (CONTROL_CHARS.test(value)) return undefined;
  return value;
}

function sanitizeLayer(raw: unknown): ModelMetadataLayer | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const row = raw as Record<string, unknown>;
  const contextWindow = positiveInt(row.contextWindow);
  const maxInputTokens = positiveInt(row.maxInputTokens);
  const maxOutputTokens = positiveInt(row.maxOutputTokens);
  const inputModalities = copyList(row.inputModalities);
  const reasoningEfforts = copyList(row.reasoningEfforts);
  const capabilities = copyList(row.capabilities);
  const observedAt = typeof row.observedAt === "string" && !CONTROL_CHARS.test(row.observedAt)
    ? row.observedAt.slice(0, 40)
    : undefined;
  if (
    contextWindow === undefined
    && maxInputTokens === undefined
    && maxOutputTokens === undefined
    && !inputModalities
    && !reasoningEfforts
    && !capabilities
  ) {
    return undefined;
  }
  return {
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(maxInputTokens !== undefined ? { maxInputTokens } : {}),
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    ...(inputModalities ? { inputModalities } : {}),
    ...(reasoningEfforts ? { reasoningEfforts } : {}),
    ...(capabilities ? { capabilities } : {}),
    ...(observedAt ? { observedAt } : {}),
  };
}

function snapshotPath(): string {
  return join(getConfigDir(), MODEL_METADATA_CACHE_FILENAME);
}

function hydrateSnapshotFromDisk(): void {
  if (diskHydrated) return;
  diskHydrated = true;
  try {
    const path = snapshotPath();
    if (!existsSync(path)) return;
    const parsed = JSON.parse(readFileSync(path, "utf8")) as SnapshotFile;
    if (!parsed || parsed.version !== SNAPSHOT_VERSION || !parsed.models || typeof parsed.models !== "object") {
      return;
    }
    for (const [key, value] of Object.entries(parsed.models)) {
      if (typeof key !== "string" || CONTROL_CHARS.test(key) || key.length > SNAPSHOT_ID_MAX * 2) continue;
      const layer = sanitizeLayer(value);
      if (layer) snapshotRows.set(key, layer);
    }
    trimSnapshotRowsToCap();
  } catch {
    // Corrupt cache must never block discovery or catalog sync.
  }
}

function persistSnapshotToDisk(): void {
  const dir = getConfigDir();
  assertNotRealHomeUnderTest(dir);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  trimSnapshotRowsToCap();
  const models: Record<string, ModelMetadataLayer> = {};
  for (const [key, row] of snapshotRows) models[key] = row;
  const body: SnapshotFile = { version: SNAPSHOT_VERSION, models };
  atomicWriteFile(snapshotPath(), `${JSON.stringify(body)}\n`);
}

export function persistLiveModelMetadata(
  provider: string,
  rows: LiveSnapshotRow[],
  options?: { writerGeneration?: string | number; observedAt?: string },
): void {
  if (options?.writerGeneration !== undefined) {
    if (typeof options.writerGeneration === "string") {
      if (!isModelCacheGenerationCurrent(provider, options.writerGeneration)) return;
    } else if (options.writerGeneration < captureConfigGeneration()) {
      return;
    }
  }
  const providerId = sanitizeIdentity(provider);
  if (!providerId) return;
  hydrateSnapshotFromDisk();
  const observedAt = options?.observedAt ?? new Date().toISOString();
  let changed = false;
  for (const row of rows) {
    const id = sanitizeIdentity(row.id);
    if (!id) continue;
    const layer = sanitizeLayer({ ...row, observedAt: row.observedAt ?? observedAt });
    if (!layer) continue;
    snapshotRows.set(snapshotKey(providerId, id), layer);
    changed = true;
  }
  if (!changed) return;
  try {
    persistSnapshotToDisk();
  } catch {
    // Best-effort persistence only.
  }
}

export function readSnapshotLayer(provider: string, modelId: string): ModelMetadataLayer | undefined {
  hydrateSnapshotFromDisk();
  return snapshotRows.get(snapshotKey(provider, modelId));
}

export function resetModelMetadataCacheForTests(options?: { hydrateFromDisk?: boolean }): void {
  snapshotRows.clear();
  diskHydrated = false;
  lastSnapshotReconciledGeneration = 0;
  if (options?.hydrateFromDisk) hydrateSnapshotFromDisk();
}

export function reconcileModelMetadataSnapshot(context: GenerationContext): number {
  if (context.generation <= lastSnapshotReconciledGeneration) return 0;
  hydrateSnapshotFromDisk();
  let removed = 0;
  for (const key of [...snapshotRows.keys()]) {
    const slash = key.indexOf("/");
    if (slash <= 0) {
      snapshotRows.delete(key);
      removed += 1;
      continue;
    }
    const provider = key.slice(0, slash);
    if (!context.providerNames.has(provider)) {
      snapshotRows.delete(key);
      removed += 1;
    }
  }
  if (removed > 0) {
    try {
      persistSnapshotToDisk();
    } catch {
      // Best-effort persistence only.
    }
  }
  lastSnapshotReconciledGeneration = context.generation;
  return removed;
}

export function registryLayerForModel(provider: string, modelId: string): ModelMetadataLayer | undefined {
  const meta = generatedModelMetadata(provider, modelId);
  if (meta) {
    return {
      ...(typeof meta.contextWindow === "number" && meta.contextWindow > 0
        ? { contextWindow: meta.contextWindow }
        : {}),
      ...(typeof meta.maxTokens === "number" && meta.maxTokens > 0
        ? { maxOutputTokens: meta.maxTokens }
        : {}),
      ...(Array.isArray(meta.input) && meta.input.length > 0 ? { inputModalities: [...meta.input] } : {}),
    };
  }
  if (provider === "cursor") {
    const cursorModel = CURSOR_STATIC_MODELS.find(m => m.id === modelId || m.id.toLowerCase() === modelId.toLowerCase());
    if (cursorModel) {
      return {
        contextWindow: cursorModel.contextWindow,
        ...(cursorModel.inputModalities ? { inputModalities: [...cursorModel.inputModalities] } : {}),
        ...(cursorModel.supportsReasoningEffort
          ? { reasoningEfforts: cursorModelEffortLadder(cursorModel.id) ?? [] }
          : {}),
      };
    }
  }
  return undefined;
}

function layerFromCatalogModel(model: CatalogModel): ModelMetadataLayer | undefined {
  return sanitizeLayer({
    contextWindow: model.contextWindow,
    maxInputTokens: model.maxInputTokens,
    maxOutputTokens: model.maxOutputTokens,
    inputModalities: model.inputModalities,
    reasoningEfforts: model.reasoningEfforts,
    capabilities: model.capabilities,
    observedAt: model.metadataObservedAt,
  });
}

export function capsFromProvider(
  provider: { contextWindow?: number; modelContextWindows?: Record<string, number>; modelMaxInputTokens?: Record<string, number> } | undefined,
  modelId: string,
  providerCap?: number,
): UserContextCaps | undefined {
  if (!provider && providerCap === undefined) return undefined;
  const modelWindow = provider?.modelContextWindows?.[modelId];
  const maxInputCap = provider?.modelMaxInputTokens?.[modelId];
  return {
    ...(typeof modelWindow === "number" ? { modelWindow } : {}),
    ...(typeof provider?.contextWindow === "number" ? { providerWindow: provider.contextWindow } : {}),
    ...(providerCap !== undefined ? { providerCap } : {}),
    ...(typeof maxInputCap === "number" ? { maxInputCap } : {}),
  };
}

function mergeLayers(
  preferred?: ModelMetadataLayer,
  fallback?: ModelMetadataLayer,
): ModelMetadataLayer | undefined {
  if (!preferred && !fallback) return undefined;
  return {
    ...fallback,
    ...preferred,
    observedAt: preferred?.observedAt ?? fallback?.observedAt,
  };
}

export function enrichCatalogModelMetadata(
  model: CatalogModel,
  options?: {
    caps?: UserContextCaps;
    liveFresh?: boolean;
    snapshot?: ModelMetadataLayer;
  },
): CatalogModel {
  // Combo rows already min() member evidence; re-resolving would relabel them as snapshot.
  if (model.metadataSource === "derived") return model;
  const disk = options?.snapshot ?? readSnapshotLayer(model.provider, model.id);
  const fromModel = layerFromCatalogModel(model);
  const liveFresh = options?.liveFresh ?? (model.metadataSource === "live" && model.metadataStale !== true);
  // A cached row may already contain the operator cap. Keep the raw last-known-good
  // snapshot as the evidence layer when rebuilding it after a failed refresh; otherwise
  // the capped value overwrites its own detected window on every convergence pass.
  const staleModelPreferred = model.contextCapped !== true;
  const snapshot = liveFresh
    ? disk
    : (staleModelPreferred ? mergeLayers(fromModel, disk) : mergeLayers(disk, fromModel));
  const liveLayer = liveFresh && fromModel && model.contextCapped === true
    && typeof model.detectedContextWindow === "number"
    && model.detectedContextWindow > (model.contextWindow ?? 0)
    ? { ...fromModel, contextWindow: model.detectedContextWindow }
    : fromModel;
  const registry = registryLayerForModel(model.provider, model.id);
  // Cursor's GetUsableModels RPC returns ids only. Any capability lists already present on a
  // Cursor row therefore come from explicit provider configuration; keep them ahead of the static
  // registry backfill, including an intentional empty reasoning ladder.
  const effectiveRegistry = registry && model.provider === "cursor"
    ? {
      ...registry,
      ...(Array.isArray(model.inputModalities) ? { inputModalities: undefined } : {}),
      ...(Array.isArray(model.reasoningEfforts) ? { reasoningEfforts: undefined } : {}),
    }
    : registry;
  const resolved = resolveModelMetadata({
    ...(liveFresh && liveLayer ? { live: liveLayer } : {}),
    liveFresh,
    ...(snapshot ? { snapshot } : {}),
    ...(effectiveRegistry
      ? { registry: effectiveRegistry }
      : {}),
    ...(options?.caps ? { caps: options.caps } : {}),
  });
  const enriched = applyResolvedMetadataToCatalogModel(model, resolved);
  // A provider-cap marker can be lost when a later convergence pass resolves the
  // already-capped value as its new baseline. Preserve the marker from the prior
  // pass; explicit smaller model windows are never marked by applyProviderConfigHints.
  return model.contextCapped === true && enriched.contextWindow === model.contextWindow
    ? { ...enriched, contextCapped: true }
    : enriched;
}
