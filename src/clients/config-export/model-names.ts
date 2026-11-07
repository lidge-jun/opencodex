import type { ExportModel } from "./contracts";
import { UnrepresentableSelectorError } from "../../integrations/merge";

export type ExportModelNames = "routed" | "alias";

export function isExportModelNames(value: unknown): value is ExportModelNames {
  return value === "routed" || value === "alias";
}

export function supportsAliasModelNames(client: string): boolean {
  return client === "hermes" || client === "commandcode";
}

/** Resolve only after the caller binds an ownership record to its target file. */
export function resolveModelNames(client: string, requested: unknown, stored?: unknown): ExportModelNames {
  if ((requested !== undefined && !isExportModelNames(requested))
    || (stored !== undefined && !isExportModelNames(stored))) {
    throw new UnrepresentableSelectorError("modelNames must be routed or alias");
  }
  const mode = requested ?? stored ?? "routed";
  if (mode === "alias" && !supportsAliasModelNames(client)) {
    throw new UnrepresentableSelectorError("alias model names require Hermes or Command Code");
  }
  return mode;
}

/** The retained roster is canonical; candidates are proven by the shared row loader. */
export function selectExportModelNames(models: readonly ExportModel[], mode: ExportModelNames): readonly ExportModel[] {
  if (mode === "routed") return models;
  return models.map(model => model.aliasNamespaced === undefined ? model : { ...model, namespaced: model.aliasNamespaced });
}
