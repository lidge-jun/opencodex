const PROVIDER_ICON_ALIASES: Record<string, string> = {
  agentrouter: "agentrouter.png",
  agnes: "agnesai.svg",
  agy: "provider-generic.svg",
  ai21: "ai21-color.svg",
  aihorde: "provider-generic.svg",
  ainative: "provider-generic.svg",
  aion: "aionlabs-color.svg",
  anthropic: "claude-color.svg",
  "anthropic-apikey": "claude-color.svg",
  "azure-openai": "openai.svg",
  "arcee-ai": "arcee-color.svg",
  "api-airforce": "api-airforce.svg",
  bazaarlink: "bazaarlink.svg",
  blackbox: "blackbox.png",
  bluesminds: "bluesminds.svg",
  chatgpt: "openai.svg",
  cerebras: "cerebras-color.svg",
  "cloudflare-ai-gateway": "cloudflare-ai-gateway-color.svg",
  "cloudflare-ai": "cloudflare-ai-gateway-color.svg",
  "cloudflare-workers-ai": "cloudflare-ai-gateway-color.svg",
  cohere: "cohere-color.svg",
  coze: "coze.svg",
  cursor: "cursor-color.svg",
  deepseek: "deepseek-color.svg",
  deepinfra: "deepinfra-color.svg",
  doubao: "volcengine-color.svg",
  "duckduckgo-web": "duckduckgo.svg",
  "felo-web": "provider-generic.svg",
  firepass: "firepass-color.svg",
  fireworks: "fireworks-color.svg",
  friendliai: "friendli.svg",
  "freemodel-dev": "freemodel-dev.svg",
  github: "github-copilot-color.svg",
  "github-models": "github-copilot-color.svg",
  "github-copilot": "copilot-color.svg",
  "gitlab-duo": "gitlab-duo-color.svg",
  google: "gemini-color.svg",
  gemini: "gemini-color.svg",
  "google-antigravity": "antigravity-color.svg",
  "google-vertex": "gemini-color.svg",
  vertex: "gemini-color.svg",
  groq: "groq-color.svg",
  hackclub: "hackclub.svg",
  huggingface: "huggingface-color.svg",
  huggingchat: "huggingface-color.svg",
  hyperbolic: "hyperbolic-color.svg",
  iflytek: "iflytek-color.svg",
  "inference-net": "inference.svg",
  kimi: "kimi-color.svg",
  "kimi-code": "kimi-color.svg",
  kiro: "kiro-color.svg",
  "kilo-gateway": "kilocode.svg",
  "lm-studio": "lm-studio-color.svg",
  litellm: "litellm.png",
  liquid: "liquid.svg",
  llm7: "llm7.svg",
  longcat: "longcat-color.svg",
  mistral: "mistral-color.svg",
  moonshot: "moonshot-color.svg",
  monsterapi: "monsterapi.svg",
  morph: "morph-color.svg",
  "muse-spark-web": "provider-generic.svg",
  nara: "provider-generic.svg",
  navy: "provider-generic.svg",
  nebius: "nebius.svg",
  nvidia: "nvidia-color.svg",
  "nous-research": "nousresearch.svg",
  novita: "novita-color.svg",
  nlpcloud: "nlpcloud.svg",
  nscale: "nscale.png",
  ollama: "ollama-color.svg",
  "ollama-cloud": "ollama-color.svg",
  openai: "openai.svg",
  "openai-apikey": "openai.svg",
  "opencode-free": "opencode.svg",
  opencode: "opencode.svg",
  "opencode-go": "opencode.svg",
  "opencode-zen": "opencode.svg",
  openrouter: "openrouter-color.svg",
  ovhcloud: "ovh.svg",
  pollinations: "pollinations.svg",
  predibase: "predibase.png",
  publicai: "publicai.svg",
  puter: "puter.svg",
  qianfan: "qianfan-color.svg",
  baidu: "qianfan-color.svg",
  baichuan: "baichuan-color.svg",
  alibaba: "alibaba-color.svg",
  "alibaba-token-plan": "alibaba-color.svg",
  "alibaba-token-plan-intl": "alibaba-color.svg",
  "qwen-cloud": "qwen-portal-color.svg",
  "qwen-web": "qwen-portal-color.svg",
  qoder: "qoder-color.svg",
  reka: "reka.png",
  requesty: "requesty.svg",
  routeway: "provider-generic.svg",
  sambanova: "sambanova-color.svg",
  scaleway: "scaleway.svg",
  siliconflow: "siliconcloud-color.svg",
  sensenova: "sensenova-color.svg",
  sparkdesk: "spark-color.svg",
  stepfun: "stepfun-color.svg",
  "t3-web": "t3-web.svg",
  together: "together-color.svg",
  uncloseai: "uncloseai.svg",
  tencent: "tencent-color.svg",
  "vercel-ai-gateway": "vercel-ai-gateway-color.svg",
  vllm: "vllm-color.svg",
  xai: "grok-color.svg",
  "mimo-free": "xiaomi-color.svg",
  xiaomi: "xiaomi-color.svg",
  glm: "zhipu-color.svg",
  "glm-cn": "zhipu-color.svg",
};

/** Brand colors for monochrome Simple-Icons SVGs (fill is black by default). */
const PROVIDER_BRAND_COLORS: Record<string, string> = {
  nvidia: "#76B900",
  "mimo-free": "#FF6900",
  xiaomi: "#FF6900",
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
  alibaba: "#FF6A00",
  "alibaba-token-plan": "#FF6A00",
  "alibaba-token-plan-intl": "#FF6A00",
  kimi: "#1A6CFF",
  "kimi-code": "#1A6CFF",
  moonshot: "#1A6CFF",
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

type ProviderIconHints = {
  adapter?: string;
  baseUrl?: string;
  defaultModel?: string;
  models?: readonly string[];
};

function providerIconAlias(provider: string): string | undefined {
  return PROVIDER_ICON_ALIASES[provider.toLowerCase()];
}

const MODEL_FAMILY_ICONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(?:claude|anthropic)\b/i, "claude-color.svg"],
  [/\b(?:gpt|openai|o[1345](?:\b|-))\b/i, "openai.svg"],
  [/\b(?:gemini|gemma)\b/i, "gemini-color.svg"],
  [/\bdeepseek\b/i, "deepseek-color.svg"],
  [/\b(?:qwen|qwq)\b/i, "qwen-portal-color.svg"],
  [/\b(?:kimi|moonshot)\b/i, "kimi-color.svg"],
  [/\bmistral(?:ai)?\b/i, "mistral-color.svg"],
  [/\b(?:grok|xai)\b/i, "grok-color.svg"],
  [/\b(?:ernie|qianfan)\b/i, "qianfan-color.svg"],
];

function modelFamilyIcon(hints?: ProviderIconHints): string | undefined {
  const models = [hints?.defaultModel, ...(hints?.models ?? [])].filter((model): model is string => !!model);
  for (const model of models) {
    const match = MODEL_FAMILY_ICONS.find(([pattern]) => pattern.test(model));
    if (match) return match[1];
  }
  return undefined;
}

/** Resolve a local provider mark first, then a known model-family mark. */
export function providerIconSrc(provider: string, hints?: ProviderIconHints): string | undefined {
  const icon = providerIconAlias(provider) ?? modelFamilyIcon(hints);
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

/** True for known registry/preset ids (hide ID/adapter/URL behind Advanced by default). */
export function isCatalogProviderId(provider: string): boolean {
  return Object.prototype.hasOwnProperty.call(PROVIDER_DISPLAY_NAMES, provider.toLowerCase());
}
