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

export function summarizeRaycast(
  document: unknown,
): { modelCount: number; modelsWithoutLimits: number } {
  const providers = (document as RaycastGeneratedConfig | undefined)?.providers ?? [];
  const models = providers.find(provider => provider.id === OPENCODE_PROVIDER_ID)?.models ?? [];
  return {
    modelCount: models.length,
    modelsWithoutLimits: models.filter(model => model.context === undefined).length,
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
