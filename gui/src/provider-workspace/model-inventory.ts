import type { ModelRow } from "../pages/models-shared";
import type { ProviderModelCounts, ProviderAvailableModels, ProviderSelectedModels, ProviderLiveModelCounts } from "./usage";
import { parseSelectedModels } from "../model-visibility";

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid model response");
  return value as Record<string, unknown>;
}

function identity(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("Invalid model identity");
  return value;
}

/** Validate server DTOs, without deriving selector spelling or native membership. */
export function parseModelInventory(value: unknown): ModelRow[] {
  if (!Array.isArray(value)) throw new Error("Invalid model inventory");
  const groups = new Map<string, Map<string, ModelRow>>();
  const rows: ModelRow[] = [];
  for (const raw of value) {
    const row = record(raw);
    const provider = identity(row.provider);
    const id = identity(row.id);
    const namespaced = identity(row.namespaced);
    if (typeof row.disabled !== "boolean") throw new Error("Invalid model visibility");
    for (const flag of ["native", "custom", "initialSelectionPending", "contextCapped"]) {
      if (row[flag] !== undefined && typeof row[flag] !== "boolean") throw new Error("Invalid model flag");
    }
    if (row.custom === true) identity(row.customId);
    if (row.customId !== undefined && (row.custom !== true || typeof row.customId !== "string")) throw new Error("Invalid custom ownership");
    if (row.custom === true && row.native === true) throw new Error("Conflicting model ownership");
    if (row.displayName !== undefined && typeof row.displayName !== "string") throw new Error("Invalid model label");
    for (const field of ["inputModalities", "reasoningEfforts"]) {
      if (row[field] !== undefined && (!Array.isArray(row[field]) || row[field].some(v => typeof v !== "string"))) throw new Error("Invalid model metadata");
    }
    for (const field of ["contextWindow", "contextCap"]) {
      if (row[field] !== undefined && (typeof row[field] !== "number" || !Number.isFinite(row[field]))) throw new Error("Invalid model context");
    }
    // Identity/used metadata have been validated at this HTTP boundary. Keep additive DTO fields.
    const parsed = { ...row, provider, id, namespaced, disabled: row.disabled } as ModelRow;
    const group = groups.get(provider) ?? new Map<string, ModelRow>();
    const previous = group.get(namespaced);
    if (previous && (previous.id !== id || previous.disabled !== parsed.disabled
      || !!previous.native !== !!parsed.native || !!previous.custom !== !!parsed.custom
      || previous.customId !== parsed.customId || !!previous.initialSelectionPending !== !!parsed.initialSelectionPending)) {
      throw new Error("Conflicting model selector");
    }
    if (!previous) { group.set(namespaced, parsed); rows.push(parsed); }
    groups.set(provider, group);
  }
  return rows;
}

export function countModelInventory(rows: readonly ModelRow[]): ProviderModelCounts {
  const groups = new Map<string, Set<string>>();
  for (const row of rows) {
    const group = groups.get(row.provider) ?? new Set<string>();
    if (!row.disabled) group.add(row.namespaced);
    groups.set(row.provider, group);
  }
  return Object.fromEntries([...groups].map(([provider, ids]) => [provider, ids.size]));
}

/** Full selected-models response: available is not a visible-row projection. */
export function parseModelSelection(value: unknown): {
  available: ProviderAvailableModels; selected: ProviderSelectedModels; liveModelCounts: ProviderLiveModelCounts;
} {
  const data = record(value);
  const selected: ProviderSelectedModels = Object.assign(Object.create(null), parseSelectedModels(data));
  for (const [provider, ids] of Object.entries(selected)) { identity(provider); ids.forEach(identity); }
  const available = Object.fromEntries(Object.entries(record(data.available)).map(([provider, ids]) => {
    identity(provider);
    if (!Array.isArray(ids)) throw new Error("Invalid available models");
    return [provider, ids.map(identity)];
  }));
  // Older servers omit provenance. Missing means unknown, not an invalid action snapshot.
  // A present malformed field is still rejected; DTO/custom ownership remain independent gates.
  const liveCounts = Object.hasOwn(data, "liveModelCounts") ? record(data.liveModelCounts) : {};
  const liveModelCounts = Object.fromEntries(Object.entries(liveCounts).map(([provider, count]) => {
    identity(provider);
    if (typeof count !== "number" || !Number.isInteger(count) || count < 0) throw new Error("Invalid discovery count");
    return [provider, count];
  }));
  return { available: Object.assign(Object.create(null), available), selected, liveModelCounts: Object.assign(Object.create(null), liveModelCounts) };
}

export interface CustomModelRecord { id: string; provider: string; modelId: string }

function parseCustomRecord(value: unknown): CustomModelRecord {
  const row = record(value);
  return { id: identity(row.id), provider: identity(row.provider), modelId: identity(row.modelId) };
}

export function parseCustomModelInventory(value: unknown): CustomModelRecord[] {
  if (!Array.isArray(value)) throw new Error("Invalid custom model inventory");
  const ids = new Map<string, CustomModelRecord>();
  const selectors = new Set<string>();
  for (const raw of value) {
    const row = parseCustomRecord(raw);
    const key = JSON.stringify([row.provider, row.modelId]);
    if (ids.has(row.id) || selectors.has(key)) throw new Error("Duplicate custom ownership");
    ids.set(row.id, row);
    selectors.add(key);
  }
  return [...ids.values()];
}

export function parseCustomModelCreated(value: unknown, provider: string, modelId: string): CustomModelRecord {
  const row = parseCustomRecord(value);
  if (row.provider !== provider || row.modelId !== modelId) throw new Error("Unexpected created model");
  return row;
}

/** Save confirmation and catalog convergence are separate outcomes. */
export function catalogRefreshPending(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return true;
  const status = (value as Record<string, unknown>).catalogRefresh;
  if (!status || typeof status !== "object" || Array.isArray(status)) return true;
  const disposition = status as Record<string, unknown>;
  return disposition.status !== "committed" || typeof disposition.changed !== "boolean" || typeof disposition.degraded !== "boolean";
}
