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
  "command-code": "commandcode-color.svg",
  commandcode: "commandcode-color.svg",
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
  minimax: "minimax.svg",
  "minimax-cn": "minimax.svg",
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
  baseten: "baseten.svg",
  bizrouter: "bizrouter.svg",
  cerebras: "cerebras.svg",
  deepinfra: "deepinfra.svg",
  digitalocean: "digitalocean.svg",
  featherless: "featherless.svg",
  hyperbolic: "hyperbolic.svg",
  kilo: "kilo.svg",
  nanogpt: "nanogpt.svg",
  nebius: "nebius.svg",
  neuralwatt: "neuralwatt.svg",
  nous: "nous.svg",
  novita: "novita.svg",
  orcarouter: "orcarouter.svg",
  parallel: "parallel.svg",
  sambanova: "sambanova.svg",
  scaleway: "scaleway.svg",
  siliconflow: "siliconflow.svg",
  synthetic: "synthetic.svg",
  together: "together.svg",
  umans: "umans.svg",
  venice: "venice.svg",
  vultr: "vultr.svg",
  litellm: "litellm.svg",
  zenmux: "zenmux.svg",
  /*
   * Z.AI and Zhipu's BigModel are the same company on two brands. `zai` is the
   * international GLM Coding Plan and the mark comes from z.ai; the two
   * `zhipu-bigmodel*` ids are the mainland console, which publishes only a
   * horizontal wordmark, so they borrow it rather than render a lockup squeezed
   * into a 19px box.
   */
  zai: "zai.svg",
  "zhipu-bigmodel": "zai.svg",
  "zhipu-bigmodel-coding": "zai.svg",
  "qwen-cloud": "qwen-portal-color.svg",
  "vercel-ai-gateway": "vercel-ai-gateway-color.svg",
  vllm: "vllm-color.svg",
  xai: "grok.svg",
  "mimo-free": "xiaomi-color.svg",
  mimo: "xiaomi-color.svg",
  xiaomi: "xiaomi-color.svg",
  "xiaomi-mimo": "xiaomi-color.svg",
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
  "command-code": "provider.name.commandCodeAuth",
  commandcode: "provider.name.commandCodeApi",
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
  const key = provider.toLowerCase();
  return Object.hasOwn(PROVIDER_ICON_ALIASES, key) ? PROVIDER_ICON_ALIASES[key] : undefined;
}

/** Optional hints kept for call-site compatibility; resolution is name-based for now. */
export function providerIconSrc(provider: string, _hints?: ProviderIconHints): string | undefined {
  void _hints;
  const icon = providerIconAlias(provider);
  return icon ? `/provider-icons/${icon}` : undefined;
}

/**
 * Marks whose artwork is one neutral ink, so the ink has to come from the theme.
 *
 * Keyed by asset path, deliberately, and for the same reason `MASKED_MARKS` is on
 * the client side: an asset reachable from two surfaces cannot be masked on one
 * and drawn plain on the other without looking like a bug.
 *
 * Membership is a measurement, not a guess. Each of these renders a single fill
 * that is either near-black or near-white, which means it disappears against one
 * of the two tile surfaces (`--raised` resolves to #f4f4f4 light, #303030 dark).
 * `zenmux` is #000, `synthetic` is #ffffff, `neuralwatt` is #081a17.
 *
 * A mark that carries real colour never belongs here. Masking discards every ink
 * in the file and repaints the silhouette, so applying it to a palette is
 * destructive in a way that still looks deliberate on screen.
 */
const MASKED_PROVIDER_ICONS: ReadonlySet<string> = new Set([
  "cerebras.svg",
  "deepinfra.svg",
  "neuralwatt.svg",
  "nous.svg",
  "novita.svg",
  "siliconflow.svg",
  "synthetic.svg",
  "zenmux.svg",

  /*
   * Marks that predate this pass and were invisible on one tile the whole time.
   *
   * `opencode.svg` (#211e1e) and `kimi-color.svg` (#1a1a1a) are the same two files
   * the client surface already masks -- the Integrations page fixed them and the
   * provider rail kept drawing them plain, because the two surfaces had no shared
   * decision. `grok.svg` is the same story one PR later. `ollama-color.svg`
   * (#141414) and `vercel-ai-gateway-color.svg` (#000000) were never caught by
   * either pass; the luminance guard found all five at once.
   */
  "grok.svg",
  "kimi-color.svg",
  "ollama-color.svg",
  "opencode.svg",
  "vercel-ai-gateway-color.svg",
]);

/**
 * Marks that carry colour but whose dominant ink is near-black.
 *
 * These cannot be masked -- that would flatten a real palette -- and they cannot
 * be left alone either: measured against the dark tile they land between 1.04:1
 * and 1.59:1, which is invisible. `zai` is 1.04, `bizrouter` 1.08, `baseten` 1.59.
 *
 * The fix belongs to the tile rather than the file. A vendor's artwork is drawn
 * unchanged on a constant light plate, which is what a favicon assumes anyway:
 * every one of these was designed to sit on a page, not on a #303030 chip.
 *
 * `digitalocean.svg` looks like it belongs here and must not: its file carries
 * its own `@media (prefers-color-scheme: dark)` rule that repaints the glyph
 * #F4F5F5. A constant plate defeats that -- the file goes light-on-light and
 * measures 1.01:1 -- so the one mark that solves this problem itself is left
 * alone to do it. Check for an embedded media query before plating anything.
 */
const PLATED_PROVIDER_ICONS: ReadonlySet<string> = new Set([
  "baseten.svg",
  "kilo.svg",
  "sambanova.svg",
  "venice.svg",
  "zai.svg",
]);

/**
 * The same problem pointing the other way: colour artwork whose dominant ink is
 * near-WHITE, drawn for a dark header and invisible on the light tile.
 *
 * Measured dominant luminance: `parallel` 1.00, `bizrouter` 0.98, `nebius` 0.87,
 * `featherless` 0.87, `umans` 0.84, `hyperbolic` 0.84 -- all of which land near
 * 1.0:1 against #f4f4f4. A light plate would make them worse, so they get a dark
 * one, which is the surface their own designers assumed.
 *
 * Two plates rather than one theme-following plate on purpose: a plate that
 * followed the theme would put light-ink art back on a light tile in light mode,
 * which is the exact failure being fixed.
 */
const DARK_PLATED_PROVIDER_ICONS: ReadonlySet<string> = new Set([
  "bizrouter.svg",
  "featherless.svg",
  "hyperbolic.svg",
  "nebius.svg",
  "parallel.svg",
  "umans.svg",
]);

/** How a provider mark must be painted so it survives both themes. */
export type ProviderIconPaint = "mask" | "plate" | "dark-plate" | "image";

export function providerIconPaint(src: string | undefined): ProviderIconPaint {
  if (!src) return "image";
  const file = src.split("/").pop() ?? "";
  if (MASKED_PROVIDER_ICONS.has(file)) return "mask";
  if (PLATED_PROVIDER_ICONS.has(file)) return "plate";
  if (DARK_PLATED_PROVIDER_ICONS.has(file)) return "dark-plate";
  return "image";
}

/** Display label with proper brand casing when known; otherwise original name. */
export function formatProviderDisplayName(provider: string, t: TFn): string {
  const key = provider.toLowerCase();
  const displayNameKey = Object.hasOwn(PROVIDER_DISPLAY_NAME_KEYS, key)
    ? PROVIDER_DISPLAY_NAME_KEYS[key]
    : undefined;
  if (displayNameKey) return t(displayNameKey);
  const displayName = Object.hasOwn(PROVIDER_DISPLAY_NAMES, key)
    ? PROVIDER_DISPLAY_NAMES[key]
    : undefined;
  if (displayName) return displayName;
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

/** Distinguishable lowercase-dash slug for a provider id (command-code -> commandcode-auth). */
export function providerDisplaySlug(provider: string): string {
  if (provider === "command-code") return "commandcode-auth";
  if (provider === "commandcode") return "commandcode-api";
  return provider;
}

/**
 * Rewrite a `provider/model` route to a clearly distinguishable slug. Command Code's two
 * config ids differ by a single dash (`command-code` vs `commandcode`), so relabel them to
 * `commandcode-auth/...` and `commandcode-api/...` — the same lowercase-dash style the
 * opencode presets use (`opencode-free/mimo-v2.5`, `opencode-go/hy3`). Also collapse a
 * redundant `<provider>-<model>` prefix when the model id itself repeats the family
 * (`command-code/deepseek-deepseek-v4-flash` -> `commandcode-auth/deepseek-v4-flash`).
 * Every other provider keeps the raw route exactly as before.
 */
export function formatNamespacedModelId(namespaced: string, _t: TFn): string {
  const slash = namespaced.indexOf("/");
  if (slash <= 0) return namespaced;
  const provider = namespaced.slice(0, slash);
  let model = namespaced.slice(slash + 1);
  if (provider === "command-code" || provider === "commandcode") {
    // The live catalog model id is `<vendor>/<model>` (e.g. deepseek/deepseek-v4-flash),
    // encoded as `<vendor>-<model>`; drop the duplicated `<vendor>-` prefix for display.
    const m = model.match(/^([a-z0-9]+)-([a-z0-9]+(?:-[a-z0-9]+)+)$/i);
    if (m && model.startsWith(`${m[1]}-${m[1]}-`)) model = model.slice(m[1]!.length + 1);
    return `${provider === "command-code" ? "commandcode-auth" : "commandcode-api"}/${model}`;
  }
  return namespaced;
}
