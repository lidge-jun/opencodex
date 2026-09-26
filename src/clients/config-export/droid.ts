import { exportPresentationLabel } from "../model-presentation";
import type { ExportContext, ExportModel, ManagedContribution } from "./contracts";
import { authoritativeContextWindow, normalizeExportModels } from "./model-metadata";

export interface DroidModelEntry {
  id: string;
  model: string;
  displayName: string;
  baseUrl: string;
  provider: "generic-chat-completion-api";
  maxOutputTokens: 16_384;
  maxContextLimit?: number;
  noImageSupport: boolean;
  enableThinking?: true;
  supportedReasoningEfforts?: string[];
  defaultReasoningEffort?: string;
  reasoningEffort?: string;
}

export interface DroidGeneratedConfig {
  customModels: DroidModelEntry[];
}

function buildDroidModel(model: ExportModel, baseUrl: string): DroidModelEntry {
  const contextWindow = authoritativeContextWindow(model.contextWindow);
  const reasoningEfforts = model.reasoningEfforts && model.reasoningEfforts.length > 0
    ? [...new Set(model.reasoningEfforts)]
    : undefined;
  const entry: DroidModelEntry = {
    id: `custom:opencodex:${model.namespaced}`,
    model: model.namespaced,
    displayName: `OpenCodex: ${exportPresentationLabel(model)}`,
    baseUrl,
    provider: "generic-chat-completion-api",
    maxOutputTokens: 16_384,
    noImageSupport: !(model.inputModalities?.includes("image") ?? false),
    ...(contextWindow !== undefined
      ? { maxContextLimit: contextWindow }
      : {}),
  };
  if (reasoningEfforts) {
    entry.enableThinking = true;
    entry.supportedReasoningEfforts = reasoningEfforts;
    if (model.defaultReasoningEffort && reasoningEfforts.includes(model.defaultReasoningEffort)) {
      entry.defaultReasoningEffort = model.defaultReasoningEffort;
      entry.reasoningEffort = model.defaultReasoningEffort;
    }
  }
  return entry;
}

export function buildDroidClientConfig(ctx: ExportContext): DroidGeneratedConfig {
  return {
    customModels: normalizeExportModels(ctx.models).map(model => buildDroidModel(model, ctx.baseUrl)),
  };
}

export function summarizeDroid(document: unknown): { modelCount: number; modelsWithoutLimits: number } {
  const models = document && typeof document === "object" && Array.isArray((document as DroidGeneratedConfig).customModels)
    ? (document as DroidGeneratedConfig).customModels
    : [];
  return {
    modelCount: models.length,
    modelsWithoutLimits: models.filter(model => typeof model.maxContextLimit !== "number").length,
  };
}

export function buildDroidContribution(ctx: ExportContext): ManagedContribution {
  return {
    clientId: "droid",
    fragments: buildDroidClientConfig(ctx).customModels.map(model => ({
      path: ["customModels", `[id=${model.id}]`],
      value: model,
    })),
  };
}
