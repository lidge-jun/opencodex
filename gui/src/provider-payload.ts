export interface ProviderPayloadForm {
  name: string;
  adapter: string;
  baseUrl: string;
  responsesPath?: string;
  authMode: "key" | "forward" | "oauth" | "local";
  apiKey: string;
  apiKeyTransport?: "x-api-key" | "bearer";
  defaultModel: string;
  allowPrivateNetwork?: boolean;
}

export interface ProviderPostPreset {
  id: string;
  codexAccountMode?: "direct" | "pool";
  provider?: ProviderPayload;
}

/** Mirrors `isCanonicalOpenAiForwardProvider` (src/providers/openai-tiers.ts). */
const CODEX_FORWARD_BASE_URL = "https://chatgpt.com/backend-api/codex";

function normalizedBaseUrl(value: string): string | undefined {
  try {
    const url = new URL(value.trim());
    if (url.username || url.password || url.search || url.hash) return undefined;
    const path = url.pathname.replace(/\/+$/, "");
    return `${url.origin}${path}`;
  } catch {
    return undefined;
  }
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
  provider: { adapter?: string; authMode?: string; baseUrl?: string; disabled?: boolean } | undefined,
): "absent" | "disabled" | "ready" | "invalid" {
  if (!provider) return "absent";
  // Disabled and enabled rows share one canonical gate: adapter + authMode + baseUrl.
  if (
    provider.adapter !== "openai-responses"
    || provider.authMode !== "forward"
    || typeof provider.baseUrl !== "string"
    || normalizedBaseUrl(provider.baseUrl) !== CODEX_FORWARD_BASE_URL
  ) {
    return "invalid";
  }
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
  responsesPath?: string;
  apiKey?: string;
  apiKeyTransport?: "x-api-key" | "bearer";
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

  if (form.responsesPath?.trim()) {
    provider.responsesPath = form.responsesPath.trim();
  }
  if (form.authMode === "key" || form.authMode === "forward") {
    provider.authMode = form.authMode;
  }
  if (form.authMode === "key" && form.apiKey.trim()) {
    provider.apiKey = form.apiKey.trim();
  }
  if (form.adapter.trim() === "anthropic" && form.authMode === "key" && form.apiKeyTransport === "bearer") {
    provider.apiKeyTransport = "bearer";
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
    provider: structuredClone(preset.provider) as ProviderPayload,
  };
}

/** Stable i18n keys for OpenAI enable failures (no hardcoded UI English). */
export type OpenAiEnableErrorKey =
  | "codexAuth.enableOpenaiFailed"
  | "codexAuth.openaiPresetLoadFailed"
  | "codexAuth.openaiPresetUnavailable";

export class OpenAiEnableError extends Error {
  readonly i18nKey: OpenAiEnableErrorKey;

  constructor(i18nKey: OpenAiEnableErrorKey) {
    super(i18nKey);
    this.name = "OpenAiEnableError";
    this.i18nKey = i18nKey;
  }
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
    throw new OpenAiEnableError("codexAuth.enableOpenaiFailed");
  }

  const presetsResponse = await fetchImpl(`${apiBase}/api/provider-presets`);
  if (!presetsResponse.ok) throw new OpenAiEnableError("codexAuth.openaiPresetLoadFailed");
  const data = await presetsResponse.json() as { providers?: ProviderPostPreset[] };
  const preset = data.providers?.find(provider => provider.id === "openai");
  if (!preset?.provider) throw new OpenAiEnableError("codexAuth.openaiPresetUnavailable");

  const response = await fetchImpl(`${apiBase}/api/providers`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(buildReservedProviderPostBody(preset)),
  });
  if (response.ok) return;
  throw new OpenAiEnableError("codexAuth.enableOpenaiFailed");
}
