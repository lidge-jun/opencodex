import type { ExportContext, ManagedContribution } from "./contracts";
import { LOOPBACK_API_KEY_PLACEHOLDER, OPENCODE_PROVIDER_ID } from "./constants";
import { authoritativeContextWindow, exportModelLabel, inputModalitiesForClient, normalizeExportModels } from "./model-metadata";

/** Cline CLI/shared SDK schema at cline/cline cfe9cadab996 (2026-09-12). */
export interface ClineModel {
  name: string;
  contextWindow?: number;
  modalities?: { input: string[]; output: string[] };
  supportsVision?: boolean;
}

export function buildClineClientConfig(ctx: ExportContext) {
  const models: Record<string, ClineModel> = {};
  for (const model of normalizeExportModels(ctx.models)) {
    const input = inputModalitiesForClient("pi", model.inputModalities);
    if (input === null) continue;
    const contextWindow = authoritativeContextWindow(model.contextWindow);
    models[model.namespaced] = {
      name: exportModelLabel(model),
      ...(contextWindow === undefined ? {} : { contextWindow }),
      ...(model.inputModalities?.length ? {
        modalities: { input, output: ["text"] },
        supportsVision: input.includes("image"),
      } : {}),
    };
  }
  const connection = { baseUrl: ctx.baseUrl, protocol: "openai-responses", client: "openai" } as const;
  return {
    settings: {
      version: 1,
      modes: {},
      providers: {
        [OPENCODE_PROVIDER_ID]: {
          settings: { provider: OPENCODE_PROVIDER_ID, ...connection, apiKey: LOOPBACK_API_KEY_PLACEHOLDER },
          // Required by Cline's schema; a stable generation sentinel keeps export deterministic.
          // The operation's actual time belongs to the OpenCodex journal.
          updatedAt: "1970-01-01T00:00:00.000Z",
          tokenSource: "manual",
        },
      },
    },
    catalog: {
      version: 1,
      providers: {
        [OPENCODE_PROVIDER_ID]: {
          provider: { name: "OpenCodex", ...connection },
          models,
        },
      },
    },
  };
}

export type ClineGeneratedConfig = ReturnType<typeof buildClineClientConfig>;

export function summarizeCline(document: unknown) {
  const models = Object.values((document as ClineGeneratedConfig | undefined)?.catalog?.providers?.[OPENCODE_PROVIDER_ID]?.models ?? {});
  return { modelCount: models.length, modelsWithoutLimits: models.filter(model => model.contextWindow === undefined).length };
}

export function buildClineContribution(ctx: ExportContext): ManagedContribution {
  const document = buildClineClientConfig(ctx);
  return {
    clientId: "cline",
    fragments: [
      { path: ["settings", "providers", OPENCODE_PROVIDER_ID], value: document.settings.providers[OPENCODE_PROVIDER_ID] },
      { path: ["catalog", "providers", OPENCODE_PROVIDER_ID], value: document.catalog.providers[OPENCODE_PROVIDER_ID] },
    ],
  };
}
