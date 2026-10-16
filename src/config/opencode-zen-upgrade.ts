import { openCodeZenBaseUrl } from "../types/opencode-zen";
import { declaredUnsupportedHostedTools, isHostedToolUnsupportedForModel } from "../responses/hosted-tool-policy";

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function isGeminiModel(model: string): boolean {
  return model.trim().toLowerCase().startsWith("gemini-");
}

/** Repair legacy Zen wire overrides and dependent preferences in file-backed reads only. */
export function sanitizeOpenCodeZenOverridesForLoad(parsed: unknown): void {
  const providers = record(record(parsed)?.providers);
  const provider = providers && Object.hasOwn(providers, "opencode-zen")
    ? record(providers["opencode-zen"]) : undefined;
  if (!provider || !openCodeZenBaseUrl(provider)) return;
  const overrides = record(provider.modelAdapters) ?? {};
  const preferences = record(provider.modelPreferHostedTools);
  let preferencesChanged = false;
  if (preferences) {
    const unsupported = declaredUnsupportedHostedTools(provider as { unsupportedHostedTools?: readonly string[] });
    for (const [model, tools] of Object.entries(preferences)) {
      // Capture the old wire before deleting overrides. An explicit non-Responses entry
      // must not inherit a provider-wide Responses default for this migration.
      const oldAdapter = Object.hasOwn(overrides, model) ? overrides[model] : provider.adapter;
      if (!isGeminiModel(model) || oldAdapter !== "openai-responses"
        || !Array.isArray(tools) || tools.length === 0 || tools.some(tool => tool !== "image_generation")
        || isHostedToolUnsupportedForModel(model, "image_generation", undefined, unsupported)) continue;
      delete preferences[model];
      preferencesChanged = true;
    }
    if (preferencesChanged && Object.keys(preferences).length === 0) delete provider.modelPreferHostedTools;
  }
  let overridesChanged = false;
  for (const [model, adapter] of Object.entries(overrides)) {
    // Retain invalid preference/wire pairs so repeated normalization cannot admit them.
    if (preferences && Object.hasOwn(preferences, model)) continue;
    if (isGeminiModel(model) && (adapter === "openai-chat" || adapter === "openai-responses")) {
      delete overrides[model];
      overridesChanged = true;
    }
  }
  if (overridesChanged) {
    if (Object.keys(overrides).length === 0) delete provider.modelAdapters;
    console.warn("OpenCode Zen Gemini models now use the native Google API; obsolete Chat/Responses overrides were ignored while loading config.json.");
  }
  if (preferencesChanged) {
    console.warn("OpenCode Zen Gemini models now use the native Google API; legacy Responses-only hosted-tool preferences were ignored while loading config.json.");
  }
}
