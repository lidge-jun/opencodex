// Command Code config export.
import { existsSync } from "node:fs";
import type { ExportContext, ManagedContribution } from "./contracts";
import { normalizeExportModels, authoritativeContextWindow, singleFragment } from "./model-metadata";
import { OPENCODE_PROVIDER_ID, LOOPBACK_API_KEY_PLACEHOLDER } from "./constants";
import { serviceApiTokenFilePath } from "../../lib/service-secrets";
import { sanitizeCodexReasoningEfforts } from "../../reasoning-effort";

export interface CommandCodeModelEntry {
  reasoningEfforts?: string[];
  contextWindow?: number;
}

export interface CommandCodeProviderBlock {
  name: "OpenCodex";
  api: "openai-completions";
  baseURL: string;
  apiKey: string;
  models: Record<string, CommandCodeModelEntry>;
}

export interface CommandCodeGeneratedConfig {
  provider: Record<string, CommandCodeProviderBlock>;
}

export function buildCommandCodeClientConfig(ctx: ExportContext): CommandCodeGeneratedConfig {
  const models: Record<string, CommandCodeModelEntry> = {};
  for (const model of normalizeExportModels(ctx.models)) {
    const entry: CommandCodeModelEntry = {};
    const context = authoritativeContextWindow(model.contextWindow);
    if (context !== undefined) {
      entry.contextWindow = context;
    }
    const efforts = sanitizeCodexReasoningEfforts(model.reasoningEfforts)
      ?.filter(effort => ["low", "medium", "high", "xhigh", "max"].includes(effort));
    if (efforts && efforts.length > 0) {
      entry.reasoningEfforts = efforts;
    }
    models[model.namespaced] = entry;
  }
  const tokenPath = serviceApiTokenFilePath();
  const apiKey = existsSync(tokenPath) ? `!cat ${tokenPath}` : LOOPBACK_API_KEY_PLACEHOLDER;
  return {
    provider: {
      [OPENCODE_PROVIDER_ID]: {
        name: "OpenCodex",
        api: "openai-completions",
        baseURL: ctx.baseUrl.replace(/\/v1\/?$/, "") + "/v1",
        apiKey,
        models,
      },
    },
  };
}

export function summarizeCommandCode(document: unknown): { modelCount: number; modelsWithoutLimits: number } {
  const models = Object.values((document as CommandCodeGeneratedConfig | undefined)?.provider?.[OPENCODE_PROVIDER_ID]?.models ?? {});
  return { modelCount: models.length, modelsWithoutLimits: models.filter(model => model.contextWindow === undefined).length };
}

export function buildCommandCodeContribution(ctx: ExportContext): ManagedContribution {
  const doc = buildCommandCodeClientConfig(ctx);
  return singleFragment("commandcode", ["provider", OPENCODE_PROVIDER_ID], doc.provider[OPENCODE_PROVIDER_ID]);
}

