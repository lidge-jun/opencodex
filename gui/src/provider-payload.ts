export interface ProviderPayloadForm {
  name: string;
  adapter: string;
  baseUrl: string;
  authMode: "key" | "forward" | "oauth" | "local";
  apiKey: string;
  defaultModel: string;
}

export interface ProviderPostPreset {
  id: string;
  codexAccountMode?: "direct" | "pool";
  provider?: ProviderPayload;
}

export type CodexPresetDescriptionKey = "prov.openaiDirectDesc" | "prov.openaiMultiDesc";

export function isReservedCodexForwardPreset(preset: ProviderPostPreset): boolean {
  return preset.id === "openai" || preset.id === "openai-multi";
}

export function codexPresetDescriptionKey(preset: ProviderPostPreset): CodexPresetDescriptionKey | null {
  if (preset.id === "openai") return "prov.openaiDirectDesc";
  if (preset.id === "openai-multi") return "prov.openaiMultiDesc";
  if (preset.codexAccountMode === "direct") return "prov.openaiDirectDesc";
  if (preset.codexAccountMode === "pool") return "prov.openaiMultiDesc";
  return null;
}

export interface ProviderPayload {
  adapter: string;
  baseUrl: string;
  apiKey?: string;
  defaultModel?: string;
  authMode?: "key" | "forward" | "oauth";
}

export function buildProviderPayload(form: ProviderPayloadForm): ProviderPayload {
  const provider: ProviderPayload = {
    adapter: form.adapter.trim(),
    baseUrl: form.baseUrl.trim(),
  };

  if (form.authMode === "key" || form.authMode === "forward") {
    provider.authMode = form.authMode;
  }
  if (form.authMode === "key" && form.apiKey.trim()) {
    provider.apiKey = form.apiKey.trim();
  }
  if (form.defaultModel.trim()) {
    provider.defaultModel = form.defaultModel.trim();
  }

  return provider;
}

export function buildProviderPostBody(
  preset: ProviderPostPreset,
  form: ProviderPayloadForm,
): { name: string; provider: ProviderPayload } {
  if (isReservedCodexForwardPreset(preset)) {
    if (!preset.provider) throw new Error(`Missing canonical provider seed for ${preset.id}`);
    return {
      name: preset.id,
      provider: JSON.parse(JSON.stringify(preset.provider)) as ProviderPayload,
    };
  }
  return { name: form.name.trim(), provider: buildProviderPayload(form) };
}
