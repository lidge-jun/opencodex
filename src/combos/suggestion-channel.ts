import { isCanonicalOpenAiForwardProvider } from "../providers/openai-tiers-destination";

export interface SuggestionProvider {
  name: string;
  disabled?: boolean;
  hiddenFromPicker?: boolean;
  authMode?: string;
  canonicalOpenAiForward?: boolean;
  googleMode?: string;
  vertexCredentialKind?: string;
  adapter?: string;
  baseUrl?: string;
}

/**
 * Order members are suggested in: a subscription from the model's own maker, any other
 * subscription, Vertex credit, then pay-per-use keys and relays.
 */
export type ChannelTier = "own-subscription" | "subscription" | "vertex" | "metered";
export const TIER_RANK: Record<ChannelTier, number> = { "own-subscription": 0, subscription: 1, vertex: 2, metered: 3 };

/** No `max`: it names distinct models (`gpt-5.1-codex-max` is not `gpt-5.1-codex` at max effort). */
export const EFFORT_SUFFIX = /-(?:minimal|low|medium|high|xhigh)$/;

/**
 * One model's name across providers: no `provider/` prefix, lowercase, runs of spaces,
 * underscores and dashes as one dash, a version dot as a dash (`claude-opus-5.5` is
 * `claude-opus-5-5`), and no trailing effort suffix (`gpt-6.1-sol-high` is `gpt-6-1-sol`;
 * `gpt-5.1-codex-max-high` is `gpt-5-1-codex-max`).
 */
export function normalizeModelName(id: string): string {
  let name = id.trim().toLowerCase();
  name = name.slice(name.lastIndexOf("/") + 1);
  name = name.replace(/[\s_-]+/g, "-").replace(/^-+|-+$/g, "");
  name = name.replace(/(\d)\.(?=\d)/g, "$1-");
  return name.replace(EFFORT_SUFFIX, "");
}

const MODEL_MAKERS: ReadonlyArray<[RegExp, string]> = [
  [/^claude/, "anthropic"],
  [/^(?:gpt|o\d|codex|chatgpt)/, "openai"],
  [/^(?:gemini|gemma)/, "google"],
  [/^grok/, "xai"],
  [/^deepseek/, "deepseek"],
];

const PROVIDER_MAKERS: ReadonlyArray<[RegExp, string]> = [
  [/(?:^|\.)anthropic\.com$/, "anthropic"],
  [/(?:^|\.)(?:openai\.com|chatgpt\.com)$/, "openai"],
  [/(?:^|\.)googleapis\.com$/, "google"],
  [/(?:^|\.)x\.ai$/, "xai"],
  [/(?:^|\.)deepseek\.com$/, "deepseek"],
];

function hostOf(baseUrl: string | undefined): string {
  if (!baseUrl) return "";
  try {
    return new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return "";
  }
}

export function channelTier(provider: SuggestionProvider, model: string): ChannelTier {
  const host = hostOf(provider.baseUrl);
  if (provider.authMode === "forward"
    && (provider.canonicalOpenAiForward === false || !isCanonicalOpenAiForwardProvider(provider))) return "metered";
  if (provider.googleMode === "vertex" || provider.vertexCredentialKind || /(?:^|[.-])aiplatform\.googleapis\.com$/.test(host) || /vertex/i.test(provider.name)) return "vertex";
  if (provider.authMode !== "oauth" && provider.authMode !== "forward") return "metered";
  const modelMaker = MODEL_MAKERS.find(([re]) => re.test(normalizeModelName(model)))?.[1];
  const providerMaker = PROVIDER_MAKERS.find(([re]) => re.test(host))?.[1];
  return modelMaker !== undefined && modelMaker === providerMaker ? "own-subscription" : "subscription";
}

export function isMeteredTier(tier: ChannelTier): boolean {
  return tier === "metered" || tier === "vertex";
}
