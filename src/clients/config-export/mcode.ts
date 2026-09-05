// MiniMax Code config export.
import type { ExportContext, ManagedContribution } from "./contracts";
import { normalizeExportModels, authoritativeContextWindow, singleFragment } from "./model-metadata";
import { sanitizeCodexReasoningEfforts } from "../../reasoning-effort";
import { OPENCODE_PROVIDER_ID, LOOPBACK_API_KEY_PLACEHOLDER } from "./constants";


export interface McodeProviderBlock {
  name: "OpenCodex";
  kind: "custom";
  enabled: true;
  api: "anthropic-messages";
  options: {
    apiKey: string;
    baseURL: string;
    authMode: "api-key";
  };
  models: Record<string, McodeModelEntry>;
}

export interface McodeModelEntry {
  /** MCode uses this value for context accounting and compaction. */
  limit?: { context: number };
  /** MCode exposes these exact levels in `/model` and sends the selected effort. */
  thinking?: { effortOptions: string[] };
}

export interface McodeGeneratedConfig {
  custom_provider: Record<string, McodeProviderBlock>;
}

/**
 * MiniMax Code's `provider add` command persists custom providers under
 * `custom_provider.<id>`. Its current model schema reads `limit.context` for
 * context accounting and `thinking.effortOptions` for the `/model` effort
 * control. Do not emit the removed `thinking.effort` / `defaultEffort` fields:
 * MCode 0.1.6 migrates those into options and keeps the selected effort in the
 * session. Do not emit `defaultModel` either: connecting a client must not
 * silently replace the user's current model selection.
 */
export function buildMcodeClientConfig(ctx: ExportContext): McodeGeneratedConfig {
  const models: Record<string, McodeModelEntry> = {};
  for (const model of normalizeExportModels(ctx.models)) {
    const entry: McodeModelEntry = {};
    const context = authoritativeContextWindow(model.contextWindow);
    if (context !== undefined) entry.limit = { context };
    // `none` is an internal Codex catalog sentinel, not an MCode effort. MCode
    // forwards every option as `output_config.effort` while keeping adaptive
    // thinking enabled, and the Anthropic ingress deliberately accepts only
    // minimal..ultra. Advertising `none` would therefore create a selectable
    // value that cannot disable reasoning and is not forwarded as an effort.
    const efforts = sanitizeCodexReasoningEfforts(model.reasoningEfforts)
      ?.filter(effort => effort !== "none");
    if (efforts && efforts.length > 0) entry.thinking = { effortOptions: efforts };
    models[model.namespaced] = entry;
  }
  return {
    custom_provider: {
      [OPENCODE_PROVIDER_ID]: {
        name: "OpenCodex",
        kind: "custom",
        enabled: true,
        api: "anthropic-messages",
        options: {
          apiKey: LOOPBACK_API_KEY_PLACEHOLDER,
          baseURL: ctx.baseUrl.replace(/\/v1\/?$/, ""),
          authMode: "api-key",
        },
        models,
      },
    },
  };
}

export function summarizeMcode(document: unknown): { modelCount: number; modelsWithoutLimits: number } {
  const models = Object.values((document as McodeGeneratedConfig | undefined)?.custom_provider?.[OPENCODE_PROVIDER_ID]?.models ?? {});
  return { modelCount: models.length, modelsWithoutLimits: models.filter(model => !model.limit).length };
}

export function buildMcodeContribution(ctx: ExportContext): ManagedContribution {
  const doc = buildMcodeClientConfig(ctx);
  return singleFragment("mcode", ["custom_provider", OPENCODE_PROVIDER_ID], doc.custom_provider[OPENCODE_PROVIDER_ID]);
}
