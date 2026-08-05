import type { TFn, TKey } from "./i18n/shared";

const PROVIDER_ICON_ALIASES: Record<string, string> = {
  anthropic: "claude-color.svg",
  "anthropic-apikey": "claude-color.svg",
  "azure-openai": "openai.svg",
  chatgpt: "openai.svg",
 "cloudflare-ai-gateway": "cloudflare-ai-gateway-color.svg",
  "cloudflare-workers-ai": "cloudflare-ai-gateway-color.svg",
  cline: "cline-color.svg",
  "cline-pass": "cline-color.svg",
  cursor: "cursor-color.svg",
  deepseek: "deepseek-color.svg",
  firepass: "firepass-color.svg",
  fireworks: "fireworks-color.svg",
  github: "github-copilot-color.svg",
  "github-copilot": "copilot-color.svg",
  "gitlab-duo": "gitlab-duo-color.svg",
  google: "gemini-color.svg",
  "google-antigravity": "antigravity-color.svg",
  "google-vertex": "gemini-color.svg",
  groq: "groq-color.svg",
  huggingface: "huggingface-color.svg",
  kimi: "kimi-color.svg",
  "kimi-code": "kimi-color.svg",
  kiro: "kiro-color.svg",
  "lm-studio": "lm-studio-color.svg",
  mistral: "mistral-color.svg",
  moonshot: "moonshot-color.svg",
  nvidia: "nvidia-color.svg",
  ollama: "ollama-color.svg",
  "ollama-cloud": "ollama-color.svg",
  openai: "openai.svg",
  "openai-apikey": "openai.svg",
  "opencode-free": "opencode.svg",
  "opencode-go": "opencode.svg",
  "opencode-zen": "opencode.svg",
  openrouter: "openrouter-color.svg",
  qianfan: "qianfan-color.svg",
  alibaba: "alibaba-color.svg",
  "alibaba-token-plan": "alibaba-color.svg",
  "alibaba-token-plan-intl": "alibaba-color.svg",
  "qwen-cloud": "qwen-portal-color.svg",
  "vercel-ai-gateway": "vercel-ai-gateway-color.svg",
  vllm: "vllm-color.svg",
  xai: "grok.svg",
  "mimo-free": "xiaomi-color.svg",
  xiaomi: "xiaomi-color.svg",
};

/**
 * Canonical brand casing for known provider ids (config keys stay lowercase).
 * Current OpenAI ids follow the registry labels; legacy `chatgpt` keeps its historical label.
 */
const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  anthropic: "Anthropic Claude",
  "anthropic-apikey": "Anthropic Claude",
  chatgpt: "ChatGPT",
  openai: "OpenAI (Codex login)",
  "openai-apikey": "OpenAI API",
  "azure-openai": "Azure OpenAI",
 "cloudflare-ai-gateway": "Cloudflare AI Gateway",
  "cloudflare-workers-ai": "Cloudflare Workers AI",
  cline: "Cline",
  "cline-pass": "ClinePass",
  nvidia: "NVIDIA NIM",
  ollama: "Ollama",
  "ollama-cloud": "Ollama Cloud",
  xai: "xAI Grok",
  "mimo-free": "MiMo Free",
  xiaomi: "Xiaomi",
  cursor: "Cursor",
  deepseek: "DeepSeek",
  github: "GitHub",
  "github-copilot": "GitHub Copilot",
  "gitlab-duo": "GitLab Duo",
  openrouter: "OpenRouter",
  "opencode-go": "OpenCode Go",
  "opencode-free": "OpenCode Free",
  "opencode-zen": "OpenCode Zen",
  mistral: "Mistral",
  groq: "Groq",
  alibaba: "Alibaba Coding Plan",
  "alibaba-token-plan": "Alibaba Token Plan",
  "alibaba-token-plan-intl": "Alibaba Token Plan (Intl)",
  kimi: "Kimi",
  "kimi-code": "Kimi",
  moonshot: "Moonshot",
  google: "Google",
  "google-vertex": "Google Vertex",
  "lm-studio": "LM Studio",
  huggingface: "Hugging Face",
  "qwen-cloud": "Qwen Cloud",
  siliconflow: "SiliconFlow",
  "tencent-coding-plan": "Tencent Cloud Coding Plan",
  "vercel-ai-gateway": "Vercel AI Gateway",
  vllm: "vLLM",
  litellm: "LiteLLM",
};

const PROVIDER_DISPLAY_NAME_KEYS: Record<string, TKey> = {
  volcengine: "provider.name.volcengine",
  "volcengine-coding-plan": "provider.name.volcengineCodingPlan",
  "volcengine-agent-plan": "provider.name.volcengineAgentPlan",
};

const CATALOG_PROVIDER_IDS = new Set([
  ...Object.keys(PROVIDER_DISPLAY_NAMES),
  ...Object.keys(PROVIDER_DISPLAY_NAME_KEYS),
]);

type ProviderIconHints = {
  adapter?: string;
  baseUrl?: string;
};

function providerIconAlias(provider: string): string | undefined {
  return PROVIDER_ICON_ALIASES[provider.toLowerCase()];
}

/** Optional hints kept for call-site compatibility; resolution is name-based for now. */
export function providerIconSrc(provider: string, _hints?: ProviderIconHints): string | undefined {
  void _hints;
  const icon = providerIconAlias(provider);
  return icon ? `/provider-icons/${icon}` : undefined;
}

/** Display label with proper brand casing when known; otherwise original name. */
export function formatProviderDisplayName(provider: string, t: TFn): string {
  const key = provider.toLowerCase();
  const displayNameKey = PROVIDER_DISPLAY_NAME_KEYS[key];
  if (displayNameKey) return t(displayNameKey);
  if (PROVIDER_DISPLAY_NAMES[key]) return PROVIDER_DISPLAY_NAMES[key]!;
  // Title-case simple ids like "my-provider" without mangling mixedCase custom names.
  if (provider === key && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(provider)) {
    return provider
      .split("-")
      .map(part => (part ? part[0]!.toUpperCase() + part.slice(1) : part))
      .join(" ");
  }
  return provider;
}

/** True for known registry/preset ids (hide ID/adapter/URL behind Advanced by default). */
export function isCatalogProviderId(provider: string): boolean {
  return CATALOG_PROVIDER_IDS.has(provider.toLowerCase());
}
