export interface ProviderPayloadForm {
  name: string;
  adapter: string;
  baseUrl: string;
  authMode: "key" | "forward" | "oauth" | "local";
  apiKey: string;
  defaultModel: string;
  allowPrivateNetwork?: boolean;
}

export interface ProviderPostPreset {
  id: string;
  codexAccountMode?: "direct" | "pool";
  provider?: ProviderPayload;
}

export type CodexPresetDescriptionKey = "prov.openaiPoolDesc" | "prov.openaiDirectDesc";

export function isReservedCodexForwardPreset(preset: ProviderPostPreset): boolean {
  return preset.id === "openai";
}

export function codexPresetDescriptionKey(preset: ProviderPostPreset): CodexPresetDescriptionKey | null {
  if (preset.id !== "openai") return null;
  return preset.codexAccountMode === "direct" ? "prov.openaiDirectDesc" : "prov.openaiPoolDesc";
}

export interface ProviderPayload {
  adapter: string;
  baseUrl: string;
  apiKey?: string;
  defaultModel?: string;
  authMode?: "key" | "forward" | "oauth";
  codexAccountMode?: "pool" | "direct";
  allowPrivateNetwork?: boolean;
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
  if (form.allowPrivateNetwork) {
    provider.allowPrivateNetwork = true;
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
