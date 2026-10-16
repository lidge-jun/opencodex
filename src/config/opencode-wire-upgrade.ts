import { OPENCODE_GO_LEGACY_NAME_PINS } from "../types/opencode-go";
import { captureWireAdapterHardPins } from "../types/wire";
import { declaredUnsupportedHostedTools, isHostedToolUnsupportedForModel } from "../responses/hosted-tool-policy";
import { sanitizeOpenCodeZenOverridesForLoad } from "./opencode-zen-upgrade";

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

/** File reads alone repair overrides admitted before OpenCode's native-wire upgrade. */
export function sanitizeOpenCodeOverridesForLoad(parsed: unknown): void {
  sanitizeOpenCodeZenOverridesForLoad(parsed);
  const providers = record(record(parsed)?.providers);
  const provider = providers && Object.hasOwn(providers, "opencode-go")
    ? record(providers["opencode-go"]) : undefined;
  if (!provider) return;
  // Use validation's destination/auth rules, including the Go preset's fixed URL.
  const pins = captureWireAdapterHardPins("opencode-go", provider);
  const newlyPinned = (model: string): boolean => Object.hasOwn(pins, model)
    && !OPENCODE_GO_LEGACY_NAME_PINS.has(model);
  const overrides = record(provider.modelAdapters) ?? {};
  const preferences = record(provider.modelPreferHostedTools);
  let preferencesChanged = false;
  if (preferences) {
    const unsupported = declaredUnsupportedHostedTools(provider as { unsupportedHostedTools?: readonly string[] });
    for (const [model, tools] of Object.entries(preferences)) {
      // Go's registry owns the old provider-wide Chat wire. Only an explicit
      // Responses override could previously make these native models eligible.
      if (!newlyPinned(model.trim()) || overrides[model] !== "openai-responses"
        || !Array.isArray(tools) || tools.length === 0 || tools.some(tool => tool !== "image_generation")
        || isHostedToolUnsupportedForModel(model, "image_generation", undefined, unsupported)) continue;
      delete preferences[model];
      preferencesChanged = true;
    }
    if (preferencesChanged && Object.keys(preferences).length === 0) delete provider.modelPreferHostedTools;
  }
  let overridesChanged = false;
  for (const [model, adapter] of Object.entries(overrides)) {
    // Leave malformed or previously incompatible preferences visible on every pass.
    if (preferences && Object.hasOwn(preferences, model)) continue;
    if (newlyPinned(model.trim()) && (adapter === "openai-chat" || adapter === "openai-responses")) {
      delete overrides[model];
      overridesChanged = true;
    }
  }
  if (overridesChanged) {
    if (Object.keys(overrides).length === 0) delete provider.modelAdapters;
    console.warn("OpenCode Go native models now use their required APIs; obsolete Chat/Responses overrides were ignored while loading config.json.");
  }
  if (preferencesChanged) {
    console.warn("OpenCode Go native models now use their required APIs; legacy Responses-only hosted-tool preferences were ignored while loading config.json.");
  }
}
