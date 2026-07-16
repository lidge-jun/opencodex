const PROVIDER_ICON_ALIASES: Record<string, string> = {
  anthropic: "claude-color.svg",
  "anthropic-apikey": "claude-color.svg",
  "azure-openai": "openai.svg",
  chatgpt: "openai.svg",
  "cloudflare-ai-gateway": "cloudflare-ai-gateway-color.svg",
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
  "qwen-portal": "qwen-portal-color.svg",
  "vercel-ai-gateway": "vercel-ai-gateway-color.svg",
  vllm: "vllm-color.svg",
  xai: "grok-color.svg",
  "mimo-free": "xiaomi-color.svg",
  xiaomi: "xiaomi-color.svg",
  momo: "xiaomi-color.svg",
};

/** Brand colors for monochrome Simple-Icons SVGs (fill is black by default). */
const PROVIDER_BRAND_COLORS: Record<string, string> = {
  nvidia: "#76B900",
  "mimo-free": "#FF6900",
  xiaomi: "#FF6900",
  momo: "#FF6900",
  anthropic: "#D97757",
  "anthropic-apikey": "#D97757",
  openai: "#10A37F",
  "openai-apikey": "#10A37F",
  chatgpt: "#10A37F",
  "azure-openai": "#10A37F",
  // xAI / Ollama monochrome marks stay as-authored (black/white per theme SVG).
  deepseek: "#4D6BFE",
  groq: "#F55036",
  mistral: "#FF7000",
  openrouter: "#6566F1",
  google: "#8E75B2",
  "google-vertex": "#8E75B2",
  kimi: "#1A6CFF",
  "kimi-code": "#1A6CFF",
  moonshot: "#1A6CFF",
};

/** Canonical brand casing for known provider ids (config keys stay lowercase). */
const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  anthropic: "Anthropic",
  "anthropic-apikey": "Anthropic",
  chatgpt: "ChatGPT",
  openai: "OpenAI",
  "openai-apikey": "OpenAI",
  "azure-openai": "Azure OpenAI",
  nvidia: "NVIDIA",
  ollama: "Ollama",
  "ollama-cloud": "Ollama Cloud",
  xai: "xAI",
  "mimo-free": "MiMo Free",
  xiaomi: "Xiaomi",
  momo: "MiMo",
  cursor: "Cursor",
  deepseek: "DeepSeek",
  openrouter: "OpenRouter",
  "opencode-go": "OpenCode Go",
  "opencode-free": "OpenCode Free",
  mistral: "Mistral",
  groq: "Groq",
  kimi: "Kimi",
  "kimi-code": "Kimi",
  moonshot: "Moonshot",
  google: "Google",
  "google-vertex": "Google Vertex",
  "lm-studio": "LM Studio",
  huggingface: "Hugging Face",
  vllm: "vLLM",
  litellm: "LiteLLM",
};

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

/** Brand accent for monochrome icons; undefined = leave SVG as-authored. */
export function providerBrandColor(provider: string): string | undefined {
  return PROVIDER_BRAND_COLORS[provider.toLowerCase()];
}

/** Display label with proper brand casing when known; otherwise original name. */
export function formatProviderDisplayName(provider: string): string {
  const key = provider.toLowerCase();
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
