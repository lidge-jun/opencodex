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
};

type ProviderIconHints = {
  adapter?: string;
  baseUrl?: string;
};

function providerIconAlias(provider: string): string | undefined {
  return PROVIDER_ICON_ALIASES[provider.toLowerCase()];
}

export function providerIconSrc(provider: string, _hints?: ProviderIconHints): string | undefined {
  void _hints;
  const icon = providerIconAlias(provider);
  return icon ? `/provider-icons/${icon}` : undefined;
}
