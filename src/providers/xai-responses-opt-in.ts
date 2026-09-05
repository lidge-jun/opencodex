import { MODEL_ADAPTER_OVERRIDE_ALLOWED, type OcxConfig, type OcxProviderConfig } from "../types";
import { providerModelWireDefault } from "./registry";

export const XAI_RESPONSES_OPT_IN_MODELS = ["grok-4.6", "grok-4.5"] as const;
export const XAI_RESPONSES_DEFAULT_VERSION = 1;

export type XaiResponsesOptInState = boolean | "mixed";

/** Effective Responses-inbound wire; the legacy API field name remains compatible. */
export function xaiResponsesOptInState(provider: OcxProviderConfig): XaiResponsesOptInState {
  const enabled = XAI_RESPONSES_OPT_IN_MODELS.map(model => {
    const configured = provider.modelAdapters?.[model];
    const wire = configured && MODEL_ADAPTER_OVERRIDE_ALLOWED.has(configured)
      ? configured
      : providerModelWireDefault("xai", provider, model, MODEL_ADAPTER_OVERRIDE_ALLOWED, "responses")
        ?? provider.adapter;
    return wire === "openai-responses";
  });
  if (enabled.every(Boolean)) return true;
  if (enabled.some(Boolean)) return "mixed";
  return false;
}

/** Upgrade old Chat choices once; a later explicit Chat opt-in must survive restart. */
export function migrateXaiResponsesDefault(config: OcxConfig): boolean {
  const provider = config.providers.xai;
  if (!provider || (provider.xaiResponsesDefaultVersion ?? 0) >= XAI_RESPONSES_DEFAULT_VERSION) return false;
  if (!XAI_RESPONSES_OPT_IN_MODELS.every(model =>
    providerModelWireDefault("xai", provider, model, MODEL_ADAPTER_OVERRIDE_ALLOWED, "responses") === "openai-responses")) {
    return false;
  }
  const modelAdapters = { ...provider.modelAdapters };
  for (const model of XAI_RESPONSES_OPT_IN_MODELS) {
    if (modelAdapters[model] === "openai-chat") delete modelAdapters[model];
  }
  const next = { ...provider, xaiResponsesDefaultVersion: XAI_RESPONSES_DEFAULT_VERSION };
  if (Object.keys(modelAdapters).length) next.modelAdapters = modelAdapters;
  else delete next.modelAdapters;
  config.providers = { ...config.providers, xai: next };
  return true;
}
