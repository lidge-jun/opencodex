import { exportPresentationLabel } from "../model-presentation";
import { OPENCODE_PROVIDER_ID } from "./constants";
import type { ExportContext, ManagedContribution } from "./contracts";
import { authoritativeContextWindow, normalizeExportModels, singleFragment } from "./model-metadata";

export interface RaycastAbility {
  supported: boolean;
}

export type RaycastAbilityName =
  | "temperature"
  | "vision"
  | "system_message"
  | "tools"
  | "reasoning_effort";

export interface RaycastModelEntry {
  id: string;
  name: string;
  context?: number;
  abilities: Record<RaycastAbilityName, RaycastAbility>;
}

export interface RaycastProviderEntry {
  id: string;
  name: string;
  base_url: string;
  models: RaycastModelEntry[];
}

export interface RaycastGeneratedConfig {
  providers: RaycastProviderEntry[];
}

/**
 * Raycast appends `/chat/completions` to `base_url`, so the proxy's `/v1`
 * root is passed through unchanged. The format has no safe credential
 * interpolation, which is why the registry exposes it only on loopback.
 */
export function buildRaycastClientConfig(ctx: ExportContext): RaycastGeneratedConfig {
  const models: RaycastModelEntry[] = normalizeExportModels(ctx.models).map(model => {
    const hasLadder = (model.reasoningEfforts?.length ?? 0) > 0;
    const context = authoritativeContextWindow(model.contextWindow);
    return {
      id: model.namespaced,
      name: exportPresentationLabel(model),
      ...(context !== undefined ? { context } : {}),
      abilities: {
        temperature: { supported: !hasLadder },
        vision: { supported: model.inputModalities?.includes("image") ?? false },
        system_message: { supported: true },
        // Existing client-export convention, not a verified per-model capability:
        // ExportModel has no authoritative tool-support field.
        tools: { supported: true },
        reasoning_effort: { supported: hasLadder },
      },
    };
  });
  return {
    providers: [
      { id: OPENCODE_PROVIDER_ID, name: "OpenCodex", base_url: ctx.baseUrl, models },
    ],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function summarizeRaycast(
  document: unknown,
): { modelCount: number; modelsWithoutLimits: number } {
  const empty = { modelCount: 0, modelsWithoutLimits: 0 };
  if (!isRecord(document) || !Array.isArray(document.providers)) return empty;
  const providers = document.providers.filter(
    provider => isRecord(provider) && provider.id === OPENCODE_PROVIDER_ID,
  );
  // An ambiguous managed provider has no meaningful summary either.
  if (providers.length !== 1) return empty;
  const provider: unknown = providers[0];
  if (!isRecord(provider) || !Array.isArray(provider.models)) return empty;
  const models = provider.models.filter((model): model is Record<string, unknown> => (
    isRecord(model)
    && typeof model.id === "string" && model.id.trim().length > 0
    && typeof model.name === "string" && model.name.trim().length > 0
  ));
  return {
    modelCount: models.length,
    modelsWithoutLimits: models.filter(model => (
      typeof model.context !== "number" || authoritativeContextWindow(model.context) === undefined
    )).length,
  };
}

/**
 * Raycast stores providers in a sequence. The stable id selector owns only
 * OpenCodex's element, preserving user-defined providers around it.
 */
export function buildRaycastContribution(ctx: ExportContext): ManagedContribution {
  const doc = buildRaycastClientConfig(ctx);
  return singleFragment(
    "raycast",
    ["providers", `[id=${OPENCODE_PROVIDER_ID}]`],
    doc.providers[0]!,
  );
}
