import { homedir } from "node:os";
import { join } from "node:path";
import { isLoopbackHostname, shouldInjectApiAuthHeader } from "../../codex/loopback-target";
import { absoluteClientPath } from "../client-path";
import { parseSegment } from "../../integrations/merge";
import type { ExportContext, ExportClientId, ManagedContribution, OpencodeLaunchEnv } from "./contracts";
import { LOOPBACK_API_KEY_PLACEHOLDER } from "./constants";
import { normalizeExportModels, authoritativeContextWindow } from "./model-metadata";
import { buildQoderClientConfig, buildQoderContribution } from "./qoder";

export function agentHomeDir(client: "qoder-cn" | "workbuddy" | "workbuddy-ai", env: OpencodeLaunchEnv = process.env, home = homedir()): string {
  const key = client === "qoder-cn" ? "QODERCN_CONFIG_DIR" : "WORKBUDDY_CONFIG_DIR";
  // Both WorkBuddy editions use the same native override; the default roots stay separate.
  const override = env[key]?.trim() || (client === "qoder-cn" ? undefined : env.CODEBUDDY_CONFIG_DIR?.trim());
  if (!override) return join(home, `.${client}`);
  return absoluteClientPath(override, home, key);
}

export function agentConfigPath(client: "qoder-cn" | "workbuddy" | "workbuddy-ai", env: OpencodeLaunchEnv = process.env, home = homedir()): string {
  return join(agentHomeDir(client, env, home), client === "qoder-cn" ? "settings.json" : "models.json");
}

export function buildQoderCnClientConfig(ctx: ExportContext) {
  return buildQoderClientConfig(ctx);
}
export function buildQoderCnContribution(ctx: ExportContext): ManagedContribution {
  return { ...buildQoderContribution(ctx), clientId: "qoder-cn" };
}

function modelSelector(id: string): string | null {
  const selector = `[id=${id}]`;
  const parsed = parseSegment(selector);
  if (parsed.kind !== "select" || parsed.criteria[0]?.value !== id) {
    return null;
  }
  return selector;
}

function workbuddyRows(ctx: ExportContext) {
  return normalizeExportModels(ctx.models).map(model => {
    return {
      id: model.namespaced,
      name: `OpenCodex: ${model.displayName ?? model.namespaced}`,
      vendor: "OpenAI",
      url: `${ctx.baseUrl.replace(/\/+$/, "")}/chat/completions`,
      apiKey: LOOPBACK_API_KEY_PLACEHOLDER,
      ...(authoritativeContextWindow(model.maxInputTokens) ? { maxInputTokens: authoritativeContextWindow(model.maxInputTokens) } : {}),
      ...(authoritativeContextWindow(model.maxTokens) ? { maxOutputTokens: authoritativeContextWindow(model.maxTokens) } : {}),
      ...(model.supportsTools === undefined ? {} : { supportsToolCall: model.supportsTools }),
      ...(model.inputModalities === undefined ? {} : { supportsImages: model.inputModalities.includes("image") }),
      ...(model.supportsReasoning === undefined ? {} : { supportsReasoning: model.supportsReasoning }),
    };
  });
}

export function buildWorkbuddyClientConfig(ctx: ExportContext) {
  if (shouldInjectApiAuthHeader(ctx.config) || !isLoopbackHostname(new URL(ctx.baseUrl).hostname)) {
    throw new Error("WorkBuddy's placeholder API key requires a loopback-only listener.");
  }
  return { models: workbuddyRows(ctx) };
}

export function summarizeWorkbuddy(document: unknown) {
  const rows = Array.isArray(document) ? document : (document as { models?: unknown[] } | undefined)?.models ?? [];
  return { modelCount: rows.length, modelsWithoutLimits: rows.filter(row => !(row as { maxInputTokens?: number }).maxInputTokens).length };
}

/** Write-time validation must not prevent status, disable or snapshot recovery. */
export function workbuddyApplyRefusal(ctx: ExportContext): string | null {
  const models = workbuddyRows(ctx);
  if (models.some(model => modelSelector(model.id) === null)) {
    return "WorkBuddy model ID cannot be represented by a managed array selector.";
  }
  if (models.length === 0) return "WorkBuddy has no models in the selected OpenCodex catalog.";
  const available = (ctx.document as { availableModels?: unknown } | undefined)?.availableModels;
  if (Array.isArray(available) && available.length > 0 && models.some(model => !available.includes(model.id) && !available.includes(`custom-local:${model.id}`))) {
    return "WorkBuddy availableModels hides OpenCodex models; remove the restriction in WorkBuddy before enabling this connection.";
  }
  return null;
}

/** An unaddressable catalog contributes no desired rows; recorded ownership still protects recovery. */
export function buildWorkbuddyContribution(clientId: ExportClientId, ctx: ExportContext): ManagedContribution {
  const fragments: ManagedContribution["fragments"][number][] = [];
  for (const model of workbuddyRows(ctx)) {
    const selector = modelSelector(model.id);
    // Apply/refresh refuse in validateApply. Status/disable must classify the
    // saved fragment paths without depending on today's unaddressable catalog.
    if (selector === null) return { clientId, fragments: [] };
    fragments.push({ path: [...(Array.isArray(ctx.document) ? [] : ["models"]), selector], value: model });
  }
  return { clientId, fragments };
}
