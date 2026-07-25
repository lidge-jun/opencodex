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

export function codexAccountProviderNames(
  providers: Record<string, { authMode?: string }>,
): string[] {
  const configuredForward = Object.entries(providers)
    .filter(([, provider]) => provider.authMode === "forward")
    .map(([name]) => name)
    .filter(name => name !== "openai")
    .sort((a, b) => a.localeCompare(b));
  return ["openai", ...configuredForward];
}

export function openAiAccountProviderState(
  provider: { adapter?: string; authMode?: string; disabled?: boolean } | undefined,
): "absent" | "disabled" | "ready" | "invalid" {
  if (!provider) return "absent";
  if (provider.adapter !== "openai-responses" || provider.authMode !== "forward") return "invalid";
  return provider.disabled === true ? "disabled" : "ready";
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
    return buildReservedProviderPostBody(preset);
  }
  return { name: form.name.trim(), provider: buildProviderPayload(form) };
}

function buildReservedProviderPostBody(
  preset: ProviderPostPreset,
): { name: string; provider: ProviderPayload } {
  if (!preset.provider) throw new Error(`Missing canonical provider seed for ${preset.id}`);
  return {
    name: preset.id,
    provider: JSON.parse(JSON.stringify(preset.provider)) as ProviderPayload,
  };
}

export async function ensureOpenAiProvider(
  apiBase: string,
  state: "absent" | "disabled",
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  if (state === "disabled") {
    const response = await fetchImpl(`${apiBase}/api/providers?name=openai`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ disabled: false }),
    });
    if (response.ok) return;
    const body = await response.json().catch(() => ({})) as { error?: unknown };
    throw new Error(typeof body.error === "string" ? body.error : "Failed to enable the OpenAI provider");
  }

  const presetsResponse = await fetchImpl(`${apiBase}/api/provider-presets`);
  if (!presetsResponse.ok) throw new Error("Failed to load the OpenAI provider preset");
  const data = await presetsResponse.json() as { providers?: ProviderPostPreset[] };
  const preset = data.providers?.find(provider => provider.id === "openai");
  if (!preset) throw new Error("OpenAI provider preset is unavailable");

  const response = await fetchImpl(`${apiBase}/api/providers`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(buildReservedProviderPostBody(preset)),
  });
  if (response.ok) return;
  const body = await response.json().catch(() => ({})) as { error?: unknown };
  throw new Error(typeof body.error === "string" ? body.error : "Failed to enable the OpenAI provider");
}
