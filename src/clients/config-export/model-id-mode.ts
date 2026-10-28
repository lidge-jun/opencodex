import type { ExportModel } from "./contracts";

export const MODEL_ID_MODES = ["routed", "alias"] as const;
export type ModelIdMode = (typeof MODEL_ID_MODES)[number];
export const DEFAULT_MODEL_ID_MODE: ModelIdMode = "routed";

export function isModelIdMode(value: unknown): value is ModelIdMode {
  return typeof value === "string" && (MODEL_ID_MODES as readonly string[]).includes(value);
}

export type QualifiedAliasResolver = (model: ExportModel) => string | undefined;

export function modelIdKeyFor(
  model: ExportModel,
  mode: ModelIdMode,
  resolveQualifiedAlias: QualifiedAliasResolver | undefined,
): string {
  if (mode !== "alias" || resolveQualifiedAlias === undefined) return model.namespaced;
  return resolveQualifiedAlias(model) ?? model.namespaced;
}

export function modelIdKeysFor(
  models: readonly ExportModel[],
  mode: ModelIdMode,
  resolveQualifiedAlias: QualifiedAliasResolver | undefined,
): Map<string, string> {
  const candidates = models.map(model => ({
    routed: model.namespaced,
    key: modelIdKeyFor(model, mode, resolveQualifiedAlias),
  }));
  const counts = new Map<string, number>();
  for (const { key } of candidates) counts.set(key, (counts.get(key) ?? 0) + 1);
  const routedKeys = new Set(candidates.map(({ routed }) => routed));
  const keys = new Map<string, string>();
  for (const { routed, key } of candidates) {
    const collides = key !== routed && ((counts.get(key) ?? 0) > 1 || routedKeys.has(key));
    keys.set(routed, collides ? routed : key);
  }
  return keys;
}
