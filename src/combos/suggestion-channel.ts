import { isCanonicalOpenAiForwardProvider, normalizedBaseUrl } from "../providers/openai-forward-destination";

export interface SuggestionProvider {
  name: string;
  disabled?: boolean;
  hiddenFromPicker?: boolean;
  authMode?: string;
  canonicalOpenAiForward?: boolean;
  knownSubscriptionOAuth?: boolean;
  googleMode?: string;
  vertexCredentialKind?: string;
  adapter?: string;
  baseUrl?: string;
}

/**
 * Placement preference only. Every suggested target can incur charges. Order members are suggested in: a subscription from the model's own maker, any other
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
  [/^kimi/, "moonshot"],
];

// Keep this allowlist aligned with the documented subscription channels in structure/config.md.
const SUBSCRIPTION_OAUTH_CHANNELS = [
  { name: "xai", adapter: "openai-chat", baseUrl: "https://api.x.ai/v1", maker: "xai" },
  { name: "xai", adapter: "openai-chat", baseUrl: "https://cli-chat-proxy.grok.com/v1", maker: "xai" },
  { name: "kimi", adapter: "openai-chat", baseUrl: "https://api.kimi.com/coding/v1", maker: "moonshot" },
  { name: "kimi-responses", adapter: "openai-responses", baseUrl: "https://api.kimi.com/coding/v1", maker: "moonshot" },
] as const;

function subscriptionMaker(provider: SuggestionProvider): string | undefined {
  if (provider.authMode === "forward") {
    return provider.canonicalOpenAiForward !== false && isCanonicalOpenAiForwardProvider(provider) ? "openai" : undefined;
  }
  return provider.knownSubscriptionOAuth === false ? undefined : oauthSubscriptionMaker(provider);
}

export function oauthSubscriptionMaker(provider: SuggestionProvider): string | undefined {
  if (provider.authMode !== "oauth" || !provider.baseUrl) return undefined;
  const baseUrl = normalizedBaseUrl(provider.baseUrl);
  return SUBSCRIPTION_OAUTH_CHANNELS.find((channel) =>
    channel.name === provider.name && channel.adapter === provider.adapter && channel.baseUrl === baseUrl
  )?.maker;
}

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
  const providerMaker = subscriptionMaker(provider);
  if (!providerMaker) return "metered";
  const modelMaker = MODEL_MAKERS.find(([re]) => re.test(normalizeModelName(model)))?.[1];
  return modelMaker !== undefined && modelMaker === providerMaker ? "own-subscription" : "subscription";
}
