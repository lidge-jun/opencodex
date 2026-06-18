import type { OcxProviderConfig } from "../types";

/**
 * API-key "login" providers: not OAuth — the flow opens the provider's dashboard so the user can
 * create/copy a key, then validates + stores it as the provider's `apiKey` (authMode "key").
 * All use the OpenAI-compatible chat API with `Authorization: Bearer <key>` (the openai-chat adapter).
 */
export interface KeyLoginProvider {
  label: string;
  baseUrl: string;
  adapter: string;
  /** Where the user creates/copies the API key. */
  dashboardUrl: string;
  models?: string[];
  defaultModel?: string;
  /**
   * Model ids that do NOT accept image input (the vision sidecar describes images for them) / do NOT
   * accept a reasoning param. Copied into the created provider config by `enrichProviderFromCatalog`,
   * so the classification actually gates the sidecars (matching is tolerant of an Ollama ":size" tag).
   */
  noVisionModels?: string[];
  noReasoningModels?: string[];
}

export const KEY_LOGIN_PROVIDERS: Record<string, KeyLoginProvider> = {
  deepseek: { label: "DeepSeek", baseUrl: "https://api.deepseek.com", adapter: "openai-chat", dashboardUrl: "https://platform.deepseek.com/api_keys", models: ["deepseek-chat", "deepseek-reasoner"], defaultModel: "deepseek-chat" },
  cerebras: { label: "Cerebras", baseUrl: "https://api.cerebras.ai/v1", adapter: "openai-chat", dashboardUrl: "https://cloud.cerebras.ai/platform/apikeys", defaultModel: "llama-3.3-70b" },
  together: { label: "Together", baseUrl: "https://api.together.xyz/v1", adapter: "openai-chat", dashboardUrl: "https://api.together.xyz/settings/api-keys" },
  fireworks: { label: "Fireworks", baseUrl: "https://api.fireworks.ai/inference/v1", adapter: "openai-chat", dashboardUrl: "https://fireworks.ai/account/api-keys" },
  firepass: { label: "Fire Pass (Fireworks Kimi)", baseUrl: "https://api.fireworks.ai/inference/v1", adapter: "openai-chat", dashboardUrl: "https://fireworks.ai/account/api-keys" },
  moonshot: { label: "Moonshot (Kimi API)", baseUrl: "https://api.moonshot.ai/v1", adapter: "openai-chat", dashboardUrl: "https://platform.moonshot.ai/console/api-keys", defaultModel: "kimi-k2-0905-preview" },
  huggingface: { label: "Hugging Face", baseUrl: "https://router.huggingface.co/v1", adapter: "openai-chat", dashboardUrl: "https://huggingface.co/settings/tokens" },
  nvidia: { label: "NVIDIA NIM", baseUrl: "https://integrate.api.nvidia.com/v1", adapter: "openai-chat", dashboardUrl: "https://build.nvidia.com" },
  venice: { label: "Venice", baseUrl: "https://api.venice.ai/api/v1", adapter: "openai-chat", dashboardUrl: "https://venice.ai/settings/api" },
  zai: { label: "Z.AI (GLM Coding)", baseUrl: "https://api.z.ai/api/coding/paas/v4", adapter: "openai-chat", dashboardUrl: "https://z.ai/manage-apikey/apikey-list", defaultModel: "glm-4.6" },
  nanogpt: { label: "NanoGPT", baseUrl: "https://nano-gpt.com/api/v1", adapter: "openai-chat", dashboardUrl: "https://nano-gpt.com/api" },
  synthetic: { label: "Synthetic", baseUrl: "https://api.synthetic.new/openai/v1", adapter: "openai-chat", dashboardUrl: "https://synthetic.new" },
  "qwen-portal": { label: "Qwen Portal", baseUrl: "https://portal.qwen.ai/v1", adapter: "openai-chat", dashboardUrl: "https://portal.qwen.ai" },
  qianfan: { label: "Qianfan (Baidu)", baseUrl: "https://qianfan.baidubce.com/v2", adapter: "openai-chat", dashboardUrl: "https://console.bce.baidu.com/iam/#/iam/apikey/list" },
  alibaba: { label: "Alibaba Coding Plan", baseUrl: "https://coding-intl.dashscope.aliyuncs.com/v1", adapter: "openai-chat", dashboardUrl: "https://dashscope.console.aliyun.com/apiKey" },
  parallel: { label: "Parallel", baseUrl: "https://platform.parallel.ai", adapter: "openai-chat", dashboardUrl: "https://platform.parallel.ai" },
  zenmux: { label: "ZenMux", baseUrl: "https://zenmux.ai/api/v1", adapter: "openai-chat", dashboardUrl: "https://zenmux.ai" },
  litellm: { label: "LiteLLM (self-hosted)", baseUrl: "http://localhost:4000/v1", adapter: "openai-chat", dashboardUrl: "https://docs.litellm.ai/docs/proxy/quick_start" },
  // Ollama Cloud — hosted (not local), OpenAI-compatible at /v1, Bearer key from ollama.com.
  // models/noVisionModels reflect the live ollama.com cloud lineup (the proxy still fetches /v1/models
  // live; this is the seed + the vision/text classification, web-verified against ollama.com search
  // filters). Vision-capable cloud models are EXCLUDED from noVisionModels: kimi-k2.5/.6/.7-code,
  // minimax-m3, gemma3/gemma4, qwen3.5, gemini-3-flash-preview, ministral-3, devstral-small-2,
  // mistral-large-3. gpt-oss is text-only despite a stale third-party list claiming otherwise.
  "ollama-cloud": {
    label: "Ollama Cloud",
    baseUrl: "https://ollama.com/v1",
    adapter: "openai-chat",
    dashboardUrl: "https://ollama.com/settings/keys",
    models: ["glm-5.2", "deepseek-v4-pro", "qwen3-coder", "gpt-oss:120b", "kimi-k2.6", "minimax-m3", "qwen3.5", "gemma4"],
    defaultModel: "glm-5.2",
    noVisionModels: [
      "glm-5.2", "glm-5.1", "glm-5", "glm-4.7",
      "minimax-m2.7", "minimax-m2.5", "minimax-m2.1",
      "nemotron-3-ultra", "nemotron-3-super",
      "deepseek-v4-pro", "deepseek-v4-flash",
      "gpt-oss", "qwen3-coder",
    ],
  },
};

/**
 * Copy a key-login catalog entry's seed/classification (`models`, `noVisionModels`,
 * `noReasoningModels`, `defaultModel`) onto a provider config being created, for any field the caller
 * didn't already supply. Lets the vision/reasoning classification actually reach the saved config
 * (the GUI/API only send adapter/baseUrl/apiKey/defaultModel). No-op for non-catalog provider names.
 */
export function enrichProviderFromCatalog(name: string, prov: OcxProviderConfig): void {
  const e = KEY_LOGIN_PROVIDERS[name];
  if (!e) return;
  if (!prov.models && e.models) prov.models = [...e.models];
  if (!prov.defaultModel && e.defaultModel) prov.defaultModel = e.defaultModel;
  if (!prov.noVisionModels && e.noVisionModels) prov.noVisionModels = [...e.noVisionModels];
  if (!prov.noReasoningModels && e.noReasoningModels) prov.noReasoningModels = [...e.noReasoningModels];
}

export function isKeyLoginProvider(name: string): boolean {
  return name in KEY_LOGIN_PROVIDERS;
}

export function listKeyLoginProviders(): Array<{ id: string } & KeyLoginProvider> {
  return Object.entries(KEY_LOGIN_PROVIDERS).map(([id, p]) => ({ id, ...p }));
}

/** Best-effort key validation: GET {baseUrl}/models with the key. Returns true/false/unknown. */
export async function validateApiKey(baseUrl: string, key: string): Promise<boolean | "unknown"> {
  try {
    const res = await fetch(`${baseUrl}/models`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) return true;
    if (res.status === 401 || res.status === 403) return false;
    return "unknown";
  } catch {
    return "unknown";
  }
}
