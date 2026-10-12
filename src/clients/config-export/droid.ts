import { win32, join } from "node:path";
import { homedir } from "node:os";
import { exportPresentationLabel } from "../model-presentation";
import type { DroidReasoningDefaults, ExportContext, ExportModel, ManagedContribution, OpencodeLaunchEnv } from "./contracts";
import { normalizeExportModels } from "./model-metadata";
import { formatSelectorConjunction, readPath } from "../../integrations/merge";

import { DROID_DEFAULT_EFFORT_HEADER } from "./contracts";

/** Factory personal settings: https://docs.factory.ai/model-independence/byok */
export interface DroidModelEntry {
  model: string;
  displayName: string;
  baseUrl: string;
  provider: "generic-chat-completion-api";
  noImageSupport: boolean;
  extraHeaders?: Record<string, string>;
}

export interface DroidGeneratedConfig { customModels: DroidModelEntry[] }

const isWindowsHome = (home: string) => /^[A-Za-z]:[\\/]|^\\\\/.test(home);

export function droidHomeDir(_env: OpencodeLaunchEnv = process.env, home: string = homedir()): string {
  return isWindowsHome(home) ? win32.join(home, ".factory") : join(home, ".factory");
}

export function droidConfigPath(env: OpencodeLaunchEnv = process.env, home: string = homedir()): string {
  const root = droidHomeDir(env, home);
  return isWindowsHome(root) ? win32.join(root, "settings.json") : join(root, "settings.json");
}

function buildDroidRows(ctx: ExportContext): Array<{ row: DroidModelEntry; selector: string }> {
  const rows: Array<{ row: DroidModelEntry; selector: string }> = [];
  for (const model of normalizeExportModels(ctx.models)) {
    const displayName = `OpenCodex: ${exportPresentationLabel(model)}`;
    const selector = formatSelectorConjunction([
      { field: "model", value: model.namespaced },
      { field: "displayName", value: displayName },
    ]);
    // A row we cannot address safely cannot be managed or exported.
    if (!selector) continue;
    rows.push({ selector, row: {
      model: model.namespaced,
      displayName,
      baseUrl: ctx.baseUrl,
      provider: "generic-chat-completion-api",
      noImageSupport: !model.inputModalities?.includes("image"),
      ...(ctx.droidReasoningDefaults && Object.hasOwn(ctx.droidReasoningDefaults, model.namespaced)
        ? { extraHeaders: { [DROID_DEFAULT_EFFORT_HEADER]: ctx.droidReasoningDefaults[model.namespaced]! } }
        : {}),
    } });
  }
  return rows;
}

export function droidReasoningModels(models: readonly ExportModel[]): Array<{ model: string; label: string; efforts: string[] }> {
  const effortsByModel = new Map(normalizeExportModels(models).map(model => [model.namespaced, model.reasoningEfforts ?? []]));
  return buildDroidRows({ baseUrl: "", models }).map(({ row }) => ({
    model: row.model,
    label: row.displayName.replace(/^OpenCodex: /, ""),
    efforts: effortsByModel.get(row.model) ?? [],
  }));
}

export function droidDefaultsFromOwnedRows(
  ctx: ExportContext,
  document: unknown,
  fragmentPaths: readonly (readonly string[])[],
): DroidReasoningDefaults {
  const exportableModels = new Map(droidReasoningModels(ctx.models).map(model => [model.model, model.efforts]));
  const defaults: DroidReasoningDefaults = {};
  for (const path of fragmentPaths) {
    if (path.length !== 2 || path[0] !== "customModels") continue;
    const value = readPath(document, path);
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const current = value as Record<string, unknown>;
    if (typeof current.model !== "string" || !exportableModels.has(current.model)) continue;
    const headers = current.extraHeaders;
    if (!headers || typeof headers !== "object" || Array.isArray(headers)) continue;
    const header = headers as Record<string, unknown>;
    const effort = header[DROID_DEFAULT_EFFORT_HEADER];
    if (typeof effort !== "string" || !exportableModels.get(current.model)?.includes(effort)) continue;
    defaults[current.model] = effort;
  }
  return defaults;
}

export function validateDroidReasoningDefaults(
  models: readonly ExportModel[],
  defaults: unknown,
): string | null {
  if (!defaults || typeof defaults !== "object" || Array.isArray(defaults)) return "droidReasoningDefaults must be an object";
  const addressable = new Map(droidReasoningModels(models).map(model => [model.model, model.efforts]));
  for (const [model, effort] of Object.entries(defaults)) {
    const efforts = addressable.get(model);
    if (!efforts) return `model ${model} is not currently exportable to Droid`;
    if (typeof effort !== "string" || !efforts.includes(effort)) return `effort for ${model} is not declared by that model`;
  }
  return null;
}

export function buildDroidClientConfig(ctx: ExportContext): DroidGeneratedConfig {
  const rows = buildDroidRows(ctx);
  if (ctx.models.length > 0 && rows.length === 0) {
    throw new Error("Factory Droid has no addressable models in the selected catalog");
  }
  return { customModels: rows.map(({ row }) => row) };
}

export function summarizeDroid(document: unknown) {
  const rows = (document as DroidGeneratedConfig | undefined)?.customModels;
  const count = Array.isArray(rows) ? rows.length : 0;
  // Droid's personal schema has no context-window field.
  return { modelCount: count, modelsWithoutLimits: count };
}

export function buildDroidContribution(ctx: ExportContext): ManagedContribution {
  return {
    clientId: "droid",
    fragments: buildDroidRows(ctx).map(({ row, selector }) => ({ path: ["customModels", selector], value: row })),
  };
}
