import type { OcxProviderConfig } from "../types";
import { KIRO_MODELS, KIRO_MODEL_CONTEXT_WINDOWS, KIRO_MODEL_REASONING_EFFORTS } from "./kiro-models";
import { ANTIGRAVITY_MODELS, ANTIGRAVITY_MODEL_CONTEXT_WINDOWS } from "./antigravity-models";

export type ProviderAuthKind = "forward" | "oauth" | "key" | "local";
export type MetadataModelIdNormalize = "case-insensitive";

export interface ProviderRegistryEntry {
  id: string;
  label: string;
  adapter: string;
  baseUrl: string;
  authKind: ProviderAuthKind;
  featured?: boolean;
  note?: string;
  dashboardUrl?: string;
  defaultModel?: string;
  models?: string[];
  contextWindow?: number;
  modelContextWindows?: Record<string, number>;
  modelInputModalities?: Record<string, string[]>;
  reasoningEfforts?: string[];
  modelReasoningEfforts?: Record<string, string[]>;
  reasoningEffortMap?: Record<string, string>;
  modelReasoningEffortMap?: Record<string, Record<string, string>>;
  noVisionModels?: string[];
  noReasoningModels?: string[];
  noTemperatureModels?: string[];
  noTopPModels?: string[];
  noPenaltyModels?: string[];
  autoToolChoiceOnlyModels?: string[];
  preserveReasoningContentModels?: string[];
  escapeBuiltinToolNames?: boolean;
  oauthId?: string;
  jawcodeBundle?: string;
  extraMetadataAliases?: string[];
  metadataModelIdNormalize?: MetadataModelIdNormalize;
  googleMode?: "ai-studio" | "vertex" | "cloud-code-assist";
  project?: string;
  location?: string;
}

export type ProviderConfigSeed = Pick<
  OcxProviderConfig,
  "adapter" | "baseUrl" | "authMode" | "defaultModel" | "models"
  | "contextWindow" | "modelContextWindows" | "modelInputModalities"
  | "reasoningEfforts" | "modelReasoningEfforts" | "reasoningEffortMap" | "modelReasoningEffortMap"
  | "noVisionModels" | "noReasoningModels" | "noTemperatureModels" | "noTopPModels" | "noPenaltyModels"
  | "autoToolChoiceOnlyModels" | "preserveReasoningContentModels" | "escapeBuiltinToolNames"
  | "googleMode" | "project" | "location"
>;


const OLLAMA_REASONING_MAP: Record<string, string> = { xhigh: "max" };

const ZAI_GLM_52_MODELS = ["glm-5.2", "glm-5.2[1m]"];
const ZAI_GLM_52_REASONING_EFFORTS = ["low", "medium", "high", "xhigh"];
const ZAI_GLM_52_REASONING_MAP: Record<string, string> = {
  none: "none",
  minimal: "none",
  low: "high",
  medium: "high",
  high: "high",
  xhigh: "max",
  max: "max",
};
const KIMI_THINKING_MODELS = ["kimi-k2.7-code", "kimi-k2.7-code-highspeed", "kimi-k2.6", "kimi-k2.5", "kimi-k2-0905-preview"];
const KIMI_LOCKED_PARAMETER_MODELS = ["kimi-k2.7-code", "kimi-k2.7-code-highspeed", "kimi-k2.6", "kimi-k2.5"];
const NEURALWATT_REASONING_HISTORY_MODELS = [
  "glm-5.2",
  "moonshotai/Kimi-K2.5", "kimi-k2.6", "kimi-k2.7-code",
  "qwen3.5-397b", "qwen3.6-35b",
];
const UMANS_MODELS = [
  "umans-coder",
  "umans-kimi-k2.7",
  "umans-kimi-k2.6",
  "umans-flash",
  "umans-glm-5.2",
  "umans-glm-5.1",
  "umans-qwen3.6-35b-a3b",
];
const UMANS_REASONING_EFFORTS = ["low", "medium", "high", "xhigh"];
const UMANS_GLM_REASONING_EFFORTS = ["high", "xhigh"];
const UMANS_GLM_REASONING_MAP: Record<string, string> = {
  none: "high",
  minimal: "high",
  low: "high",
  medium: "high",
  high: "high",
  xhigh: "max",
  max: "max",
};
const UMANS_TEXT_ONLY_MODELS = ["umans-glm-5.2", "umans-glm-5.1"];
const UMANS_MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  "umans-coder": 262_144,
  "umans-kimi-k2.7": 262_144,
  "umans-kimi-k2.6": 262_144,
  "umans-flash": 262_144,
  "umans-glm-5.2": 405_504,
  "umans-glm-5.1": 202_752,
  "umans-qwen3.6-35b-a3b": 262_144,
};
const UMANS_MODEL_INPUT_MODALITIES: Record<string, string[]> = Object.fromEntries(
  UMANS_MODELS.map(id => [id, UMANS_TEXT_ONLY_MODELS.includes(id) ? ["text"] : ["text", "image"]]),
);

export const PROVIDER_REGISTRY: readonly ProviderRegistryEntry[] = [
  {
    id: "openai",
    label: "OpenAI (ChatGPT login)",
    adapter: "openai-responses",
    baseUrl: "https://chatgpt.com/backend-api/codex",
    authKind: "forward",
    featured: true,
    note: "Uses your codex login — no API key",
  },
  {
    id: "xai",
    label: "xAI Grok",
    adapter: "openai-chat",
    baseUrl: "https://api.x.ai/v1",
    authKind: "oauth",
    featured: true,
    oauthId: "xai",
    jawcodeBundle: "xai",
    note: "Log in with your Grok account",
    models: ["grok-4.3", "grok-4.20-0309-reasoning", "grok-4.20-0309-non-reasoning", "grok-build-0.1", "grok-composer-2.5-fast"],
    defaultModel: "grok-4.3",
    noReasoningModels: ["grok-build-0.1", "grok-composer-2.5-fast"],
    noVisionModels: ["grok-build-0.1", "grok-composer-2.5-fast"],
  },
  {
    id: "anthropic",
    label: "Anthropic Claude",
    adapter: "anthropic",
    baseUrl: "https://api.anthropic.com",
    authKind: "oauth",
    featured: true,
    oauthId: "anthropic",
    jawcodeBundle: "anthropic",
    note: "Log in with your Claude account",
    models: ["claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5"],
    defaultModel: "claude-sonnet-4-6",
  },
  {
    id: "kimi",
    label: "Kimi",
    adapter: "openai-chat",
    baseUrl: "https://api.kimi.com/coding/v1",
    authKind: "oauth",
    featured: true,
    oauthId: "kimi",
    jawcodeBundle: "moonshot",
    note: "Log in with your Kimi account",
    models: ["kimi-k2.7-code", "kimi-k2.7-code-highspeed", "kimi-k2.6", "kimi-k2.5"],
    defaultModel: "kimi-k2.7-code",
    // Kimi thinking is controlled by Kimi's `thinking` extension, not OpenAI `reasoning_effort`.
    noReasoningModels: KIMI_THINKING_MODELS,
    modelReasoningEfforts: Object.fromEntries(KIMI_THINKING_MODELS.map(id => [id, []])),
    noTemperatureModels: KIMI_LOCKED_PARAMETER_MODELS,
    noTopPModels: KIMI_LOCKED_PARAMETER_MODELS,
    noPenaltyModels: KIMI_LOCKED_PARAMETER_MODELS,
    autoToolChoiceOnlyModels: ["kimi-k2.7-code", "kimi-k2.7-code-highspeed"],
    preserveReasoningContentModels: KIMI_THINKING_MODELS,
  },
  {
    id: "kiro",
    label: "Kiro (AWS CodeWhisperer)",
    adapter: "kiro",
    baseUrl: "https://runtime.us-east-1.kiro.dev",
    authKind: "oauth",
    oauthId: "kiro",
    note: "Import-first: reuses your installed kiro-cli login (no browser). Experimental third-party harness — see Kiro ToS.",
    models: KIRO_MODELS,
    defaultModel: "kiro-auto",
    // Context windows sourced from Kiro's official model catalog (kiro.dev/docs/models/).
    modelContextWindows: KIRO_MODEL_CONTEXT_WINDOWS,
    modelReasoningEfforts: KIRO_MODEL_REASONING_EFFORTS,
  },
  { id: "openai-apikey", label: "OpenAI (API key)", adapter: "openai-responses", baseUrl: "https://api.openai.com/v1", authKind: "key", featured: true, dashboardUrl: "https://platform.openai.com/api-keys", defaultModel: "gpt-5.5" },
  {
    id: "umans",
    label: "Umans AI Coding Plan",
    adapter: "anthropic",
    baseUrl: "https://api.code.umans.ai",
    authKind: "key",
    featured: true,
    dashboardUrl: "https://app.umans.ai/billing",
    defaultModel: "umans-coder",
    models: UMANS_MODELS,
    modelContextWindows: UMANS_MODEL_CONTEXT_WINDOWS,
    modelInputModalities: UMANS_MODEL_INPUT_MODALITIES,
    note: "Coding plan via Anthropic Messages",
    modelReasoningEfforts: {
      "umans-coder": UMANS_REASONING_EFFORTS,
      "umans-kimi-k2.7": UMANS_REASONING_EFFORTS,
      "umans-kimi-k2.6": UMANS_REASONING_EFFORTS,
      "umans-flash": ["low", "medium", "high"],
      "umans-glm-5.2": UMANS_GLM_REASONING_EFFORTS,
      "umans-glm-5.1": UMANS_GLM_REASONING_EFFORTS,
      "umans-qwen3.6-35b-a3b": ["low", "medium", "high"],
    },
    modelReasoningEffortMap: {
      "umans-glm-5.2": UMANS_GLM_REASONING_MAP,
      "umans-glm-5.1": UMANS_GLM_REASONING_MAP,
    },
    noVisionModels: UMANS_TEXT_ONLY_MODELS,
    escapeBuiltinToolNames: true,
  },
  {
    id: "opencode-go", label: "opencode go", adapter: "openai-chat", baseUrl: "https://opencode.ai/zen/go/v1",
    authKind: "key", featured: true, dashboardUrl: "https://opencode.ai/auth", defaultModel: "kimi-k2.7-code",
    jawcodeBundle: "opencode-go", note: "GLM, DeepSeek, Kimi, Qwen, MiMo…",
    modelReasoningEfforts: {
      "glm-5.2": ZAI_GLM_52_REASONING_EFFORTS,
      "kimi-k2.7-code": [],
      "kimi-k2.7-code-highspeed": [],
    },
    modelReasoningEffortMap: { "glm-5.2": ZAI_GLM_52_REASONING_MAP },
    noReasoningModels: ["kimi-k2.7-code", "kimi-k2.7-code-highspeed"],
    noTemperatureModels: ["kimi-k2.7-code", "kimi-k2.7-code-highspeed"],
    noTopPModels: ["kimi-k2.7-code", "kimi-k2.7-code-highspeed"],
    noPenaltyModels: ["kimi-k2.7-code", "kimi-k2.7-code-highspeed"],
    autoToolChoiceOnlyModels: ["kimi-k2.7-code", "kimi-k2.7-code-highspeed"],
    preserveReasoningContentModels: ["glm-5.2", "kimi-k2.7-code", "kimi-k2.7-code-highspeed"],
  },
  {
    id: "neuralwatt",
    label: "Neuralwatt Cloud",
    adapter: "openai-chat",
    baseUrl: "https://api.neuralwatt.com/v1",
    authKind: "key",
    dashboardUrl: "https://portal.neuralwatt.com",
    defaultModel: "glm-5.2",
    models: [
      "glm-5.2", "glm-5.2-fast",
      "moonshotai/Kimi-K2.5", "kimi-k2.5-fast", "kimi-k2.6", "kimi-k2.6-fast",
      "kimi-k2.7-code",
      "qwen3.5-397b", "qwen3.5-397b-fast", "qwen3.6-35b", "qwen3.6-35b-fast",
    ],
    // Neuralwatt's /v1/models metadata is authoritative; these static hints are the offline fallback.
    modelReasoningEfforts: {
      "glm-5.2": ZAI_GLM_52_REASONING_EFFORTS,
      "glm-5.2-fast": [],
      "moonshotai/Kimi-K2.5": [],
      "kimi-k2.5-fast": [],
      "kimi-k2.6": [],
      "kimi-k2.6-fast": [],
      "kimi-k2.7-code": [],
      "qwen3.5-397b": ["low", "medium", "high"],
      "qwen3.5-397b-fast": [],
      "qwen3.6-35b": ["low", "medium", "high"],
      "qwen3.6-35b-fast": [],
    },
    modelReasoningEffortMap: { "glm-5.2": ZAI_GLM_52_REASONING_MAP },
    noReasoningModels: ["glm-5.2-fast", "kimi-k2.5-fast", "kimi-k2.6-fast", "qwen3.5-397b-fast", "qwen3.6-35b-fast"],
    noVisionModels: ["glm-5.2", "glm-5.2-fast", "qwen3.5-397b", "qwen3.5-397b-fast"],
    noTemperatureModels: ["kimi-k2.7-code"],
    noTopPModels: ["kimi-k2.7-code"],
    noPenaltyModels: ["kimi-k2.7-code"],
    autoToolChoiceOnlyModels: ["kimi-k2.7-code"],
    preserveReasoningContentModels: NEURALWATT_REASONING_HISTORY_MODELS,
  },
  { id: "openrouter", label: "OpenRouter", adapter: "openai-chat", baseUrl: "https://openrouter.ai/api/v1", authKind: "key", featured: true, dashboardUrl: "https://openrouter.ai/keys", jawcodeBundle: "openrouter" },
  { id: "groq", label: "Groq", adapter: "openai-chat", baseUrl: "https://api.groq.com/openai/v1", authKind: "key", featured: true, dashboardUrl: "https://console.groq.com/keys" },
  { id: "google", label: "Google Gemini", adapter: "google", baseUrl: "https://generativelanguage.googleapis.com", authKind: "key", featured: true, dashboardUrl: "https://aistudio.google.com/apikey", defaultModel: "gemini-3-pro", jawcodeBundle: "google", extraMetadataAliases: ["gemini"] },
  { id: "google-vertex", label: "Google Vertex AI", adapter: "google", baseUrl: "https://aiplatform.googleapis.com", authKind: "key", dashboardUrl: "https://console.cloud.google.com/vertex-ai", defaultModel: "gemini-3-pro", googleMode: "vertex", jawcodeBundle: "google", extraMetadataAliases: ["gemini-vertex"] },
  { id: "google-antigravity", label: "Google Antigravity", adapter: "google", baseUrl: "https://daily-cloudcode-pa.googleapis.com", authKind: "oauth", dashboardUrl: "https://antigravity.google", models: ANTIGRAVITY_MODELS, defaultModel: "gemini-3.5-flash-low", modelContextWindows: ANTIGRAVITY_MODEL_CONTEXT_WINDOWS, googleMode: "cloud-code-assist", jawcodeBundle: "google", extraMetadataAliases: ["antigravity", "gemini-antigravity"] },
  { id: "azure-openai", label: "Azure OpenAI", adapter: "azure-openai", baseUrl: "https://{resource}.openai.azure.com/openai", authKind: "key", featured: true, dashboardUrl: "https://portal.azure.com" },
  { id: "ollama", label: "Ollama (local)", adapter: "openai-chat", baseUrl: "http://localhost:11434/v1", authKind: "local", featured: true, note: "Local — key usually blank", reasoningEffortMap: OLLAMA_REASONING_MAP },
  { id: "vllm", label: "vLLM (local)", adapter: "openai-chat", baseUrl: "http://localhost:8000/v1", authKind: "local", featured: true, note: "Local — key usually blank" },
  { id: "lm-studio", label: "LM Studio (local)", adapter: "openai-chat", baseUrl: "http://localhost:1234/v1", authKind: "local", featured: true, note: "Local — no key needed" },
  { id: "deepseek", label: "DeepSeek", baseUrl: "https://api.deepseek.com", adapter: "openai-chat", authKind: "key", dashboardUrl: "https://platform.deepseek.com/api_keys", models: ["deepseek-chat", "deepseek-reasoner"], defaultModel: "deepseek-chat" },
  { id: "cerebras", label: "Cerebras", baseUrl: "https://api.cerebras.ai/v1", adapter: "openai-chat", authKind: "key", dashboardUrl: "https://cloud.cerebras.ai/platform/apikeys", defaultModel: "llama-3.3-70b" },
  { id: "together", label: "Together", baseUrl: "https://api.together.xyz/v1", adapter: "openai-chat", authKind: "key", dashboardUrl: "https://api.together.xyz/settings/api-keys" },
  { id: "fireworks", label: "Fireworks", baseUrl: "https://api.fireworks.ai/inference/v1", adapter: "openai-chat", authKind: "key", dashboardUrl: "https://fireworks.ai/account/api-keys" },
  { id: "firepass", label: "Fire Pass (Fireworks Kimi)", baseUrl: "https://api.fireworks.ai/inference/v1", adapter: "openai-chat", authKind: "key", dashboardUrl: "https://fireworks.ai/account/api-keys" },
  {
    id: "moonshot", label: "Moonshot (Kimi API)", baseUrl: "https://api.moonshot.ai/v1", adapter: "openai-chat", authKind: "key",
    dashboardUrl: "https://platform.moonshot.ai/console/api-keys", defaultModel: "kimi-k2.7-code", jawcodeBundle: "moonshot",
    models: ["kimi-k2.7-code", "kimi-k2.7-code-highspeed", "kimi-k2.6", "kimi-k2.5", "kimi-k2-0905-preview"],
    noReasoningModels: KIMI_THINKING_MODELS,
    modelReasoningEfforts: Object.fromEntries(KIMI_THINKING_MODELS.map(id => [id, []])),
    noTemperatureModels: KIMI_LOCKED_PARAMETER_MODELS,
    noTopPModels: KIMI_LOCKED_PARAMETER_MODELS,
    noPenaltyModels: KIMI_LOCKED_PARAMETER_MODELS,
    autoToolChoiceOnlyModels: ["kimi-k2.7-code", "kimi-k2.7-code-highspeed"],
    preserveReasoningContentModels: KIMI_THINKING_MODELS,
  },
  { id: "huggingface", label: "Hugging Face", baseUrl: "https://router.huggingface.co/v1", adapter: "openai-chat", authKind: "key", dashboardUrl: "https://huggingface.co/settings/tokens" },
  { id: "nvidia", label: "NVIDIA NIM", baseUrl: "https://integrate.api.nvidia.com/v1", adapter: "openai-chat", authKind: "key", dashboardUrl: "https://build.nvidia.com" },
  { id: "venice", label: "Venice", baseUrl: "https://api.venice.ai/api/v1", adapter: "openai-chat", authKind: "key", dashboardUrl: "https://venice.ai/settings/api" },
  {
    id: "zai", label: "Z.AI — GLM Coding Plan", baseUrl: "https://api.z.ai/api/coding/paas/v4", adapter: "openai-chat", authKind: "key",
    dashboardUrl: "https://z.ai/manage-apikey/apikey-list", defaultModel: "glm-5.2",
    note: "GLM-5.2 coding subscription",
    models: ["glm-5.2", "glm-5.2[1m]", "glm-5.1", "glm-5", "glm-4.6"],
    noVisionModels: ZAI_GLM_52_MODELS,
    modelReasoningEfforts: Object.fromEntries(ZAI_GLM_52_MODELS.map(id => [id, ZAI_GLM_52_REASONING_EFFORTS])),
    modelReasoningEffortMap: Object.fromEntries(ZAI_GLM_52_MODELS.map(id => [id, ZAI_GLM_52_REASONING_MAP])),
    preserveReasoningContentModels: ZAI_GLM_52_MODELS,
  },
  { id: "nanogpt", label: "NanoGPT", baseUrl: "https://nano-gpt.com/api/v1", adapter: "openai-chat", authKind: "key", dashboardUrl: "https://nano-gpt.com/api" },
  { id: "synthetic", label: "Synthetic", baseUrl: "https://api.synthetic.new/openai/v1", adapter: "openai-chat", authKind: "key", dashboardUrl: "https://synthetic.new" },
  { id: "qwen-portal", label: "Qwen Portal", baseUrl: "https://portal.qwen.ai/v1", adapter: "openai-chat", authKind: "key", dashboardUrl: "https://portal.qwen.ai" },
  { id: "qianfan", label: "Qianfan (Baidu)", baseUrl: "https://qianfan.baidubce.com/v2", adapter: "openai-chat", authKind: "key", dashboardUrl: "https://console.bce.baidu.com/iam/#/iam/apikey/list" },
  { id: "alibaba", label: "Alibaba Coding Plan", baseUrl: "https://coding-intl.dashscope.aliyuncs.com/v1", adapter: "openai-chat", authKind: "key", dashboardUrl: "https://dashscope.console.aliyun.com/apiKey" },
  { id: "parallel", label: "Parallel", baseUrl: "https://platform.parallel.ai", adapter: "openai-chat", authKind: "key", dashboardUrl: "https://platform.parallel.ai" },
  { id: "zenmux", label: "ZenMux", baseUrl: "https://zenmux.ai/api/v1", adapter: "openai-chat", authKind: "key", dashboardUrl: "https://zenmux.ai" },
  { id: "litellm", label: "LiteLLM (self-hosted)", baseUrl: "http://localhost:4000/v1", adapter: "openai-chat", authKind: "key", dashboardUrl: "https://docs.litellm.ai/docs/proxy/quick_start" },
  {
    id: "ollama-cloud",
    label: "Ollama Cloud",
    baseUrl: "https://ollama.com/v1",
    adapter: "openai-chat",
    authKind: "key",
    dashboardUrl: "https://ollama.com/settings/keys",
    reasoningEffortMap: OLLAMA_REASONING_MAP,
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
  { id: "mistral", label: "Mistral", baseUrl: "https://api.mistral.ai/v1", adapter: "openai-chat", authKind: "key", dashboardUrl: "https://console.mistral.ai/api-keys", defaultModel: "codestral-latest" },
  { id: "minimax", label: "MiniMax — Coding Plan", baseUrl: "https://api.minimax.io/v1", adapter: "openai-chat", authKind: "key", dashboardUrl: "https://platform.minimax.io", defaultModel: "MiniMax-M2.5", jawcodeBundle: "minimax", metadataModelIdNormalize: "case-insensitive", note: "Subscription Key or API Key" },
  { id: "minimax-cn", label: "MiniMax — Coding Plan (CN)", baseUrl: "https://api.minimaxi.com/v1", adapter: "openai-chat", authKind: "key", dashboardUrl: "https://platform.minimaxi.com", defaultModel: "MiniMax-M2.5", jawcodeBundle: "minimax", metadataModelIdNormalize: "case-insensitive", note: "中国区 Subscription Key" },
  {
    id: "kimi-code", label: "Kimi (coding)", baseUrl: "https://api.kimi.com/coding/v1", adapter: "openai-chat", authKind: "key",
    dashboardUrl: "https://platform.moonshot.cn/console/api-keys", defaultModel: "kimi-k2.7-code",
    models: ["kimi-k2.7-code", "kimi-k2.7-code-highspeed", "kimi-k2.6", "kimi-k2.5"],
    noReasoningModels: KIMI_THINKING_MODELS,
    modelReasoningEfforts: Object.fromEntries(KIMI_THINKING_MODELS.map(id => [id, []])),
    noTemperatureModels: KIMI_LOCKED_PARAMETER_MODELS,
    noTopPModels: KIMI_LOCKED_PARAMETER_MODELS,
    noPenaltyModels: KIMI_LOCKED_PARAMETER_MODELS,
    autoToolChoiceOnlyModels: ["kimi-k2.7-code", "kimi-k2.7-code-highspeed"],
    preserveReasoningContentModels: KIMI_THINKING_MODELS,
  },
  { id: "opencode-zen", label: "opencode zen", baseUrl: "https://opencode.ai/zen/v1", adapter: "openai-chat", authKind: "key", dashboardUrl: "https://opencode.ai/auth" },
  { id: "vercel-ai-gateway", label: "Vercel AI Gateway", baseUrl: "https://ai-gateway.vercel.sh/v1", adapter: "openai-chat", authKind: "key", dashboardUrl: "https://vercel.com/dashboard" },
  { id: "xiaomi", label: "Xiaomi MiMo", baseUrl: "https://api.xiaomimimo.com/anthropic", adapter: "anthropic", authKind: "key", dashboardUrl: "https://xiaomimimo.com", defaultModel: "mimo-v2.5-pro" },
  { id: "kilo", label: "Kilo", baseUrl: "https://api.kilo.ai/api/gateway", adapter: "openai-chat", authKind: "key", dashboardUrl: "https://kilo.ai" },
  { id: "cloudflare-ai-gateway", label: "Cloudflare AI Gateway", baseUrl: "https://gateway.ai.cloudflare.com/v1/{account-id}/{gateway}/anthropic", adapter: "anthropic", authKind: "key", dashboardUrl: "https://dash.cloudflare.com/?to=/:account/ai/ai-gateway" },
  { id: "github-copilot", label: "GitHub Copilot", baseUrl: "https://api.githubcopilot.com", adapter: "openai-chat", authKind: "key", dashboardUrl: "https://github.com/settings/copilot" },
  { id: "gitlab-duo", label: "GitLab Duo", baseUrl: "https://cloud.gitlab.com/ai/v1/proxy/openai/v1", adapter: "openai-chat", authKind: "key", dashboardUrl: "https://gitlab.com/-/user_settings/personal_access_tokens" },
];

export function getProviderRegistryEntry(id: string): ProviderRegistryEntry | undefined {
  return PROVIDER_REGISTRY.find(entry => entry.id === id);
}
