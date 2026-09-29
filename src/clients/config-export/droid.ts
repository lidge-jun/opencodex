import { win32, join } from "node:path";
import { homedir } from "node:os";
import { exportPresentationLabel } from "../model-presentation";
import type { ExportContext, ManagedContribution, OpencodeLaunchEnv } from "./contracts";
import { normalizeExportModels } from "./model-metadata";
import { formatSelectorConjunction } from "../../integrations/merge";

/** Factory personal settings: https://docs.factory.ai/model-independence/byok */
export interface DroidModelEntry {
  model: string;
  displayName: string;
  baseUrl: string;
  provider: "generic-chat-completion-api";
  noImageSupport: boolean;
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
    } });
  }
  return rows;
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
