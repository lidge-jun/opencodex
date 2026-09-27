import { homedir } from "node:os";
import { join } from "node:path";
import { isLoopbackHostname, shouldInjectApiAuthHeader } from "../../codex/loopback-target";
import { formatSelectorConjunction } from "../../integrations/merge";
import type { ExportContext, ManagedContribution, OpencodeLaunchEnv } from "./contracts";
import { LOOPBACK_API_KEY_PLACEHOLDER, OPENCODE_PROVIDER_ID } from "./constants";
import { authoritativeContextWindow, normalizeExportModels } from "./model-metadata";

export function qoderConfigPath(_env: OpencodeLaunchEnv = process.env, home: string = homedir()): string {
  return join(home, ".qoder", "settings.json");
}

/** Qoder IDE and qodercli share this provider and custom-model catalog. */
export function buildQoderClientConfig(ctx: ExportContext) {
  if (shouldInjectApiAuthHeader(ctx.config) || !isLoopbackHostname(new URL(ctx.baseUrl).hostname)) {
    throw new Error("Qoder's placeholder API key requires a loopback-only listener.");
  }
  return qoderDocument(ctx);
}

function qoderDocument(ctx: ExportContext) {
  const models = normalizeExportModels(ctx.models);
  return {
    providers: {
      [OPENCODE_PROVIDER_ID]: {
        type: "openai-compatible",
        protocol: "openai",
        displayName: "opencodex",
        baseUrl: ctx.baseUrl,
        apiKey: LOOPBACK_API_KEY_PLACEHOLDER,
        ...(models[0] ? { defaultModel: models[0].namespaced } : {}),
        models: models.map(model => ({ model: model.namespaced })),
      },
    },
    modelConfigs: {
      customModels: models.map(model => ({
        provider: OPENCODE_PROVIDER_ID,
        apiKey: LOOPBACK_API_KEY_PLACEHOLDER,
        model: model.namespaced,
        baseURL: ctx.baseUrl,
        displayName: model.namespaced,
        maxInputTokens: authoritativeContextWindow(model.contextWindow) ?? 128000,
      })),
    },
  };
}

export type QoderGeneratedConfig = ReturnType<typeof buildQoderClientConfig>;

export function summarizeQoder(document: unknown): { modelCount: number; modelsWithoutLimits: number } {
  const models = (document as QoderGeneratedConfig | undefined)?.modelConfigs?.customModels ?? [];
  return { modelCount: models.length, modelsWithoutLimits: 0 };
}

export function buildQoderContribution(ctx: ExportContext): ManagedContribution {
  // The writer gates admission before applying. Classification and disable must
  // still work after the operator changes the proxy to a non-loopback bind.
  const doc = qoderDocument(ctx);
  return {
    clientId: "qoder",
    fragments: [
      { path: ["providers", OPENCODE_PROVIDER_ID], value: doc.providers[OPENCODE_PROVIDER_ID] },
      ...doc.modelConfigs.customModels.map(model => {
        const selector = formatSelectorConjunction([
          { field: "provider", value: OPENCODE_PROVIDER_ID },
          { field: "model", value: model.model },
        ]);
        if (selector === null) throw new Error("Qoder model ID cannot be represented by a managed array selector.");
        return { path: ["modelConfigs", "customModels", selector], value: model };
      }),
    ],
  };
}
