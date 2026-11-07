/**
 * Add registry models to a saved roster that is still the previous registry seed.
 *
 * `enrichProviderFromRegistry` copies the registry's `models` only when a row has none, so
 * every config saved while an older roster was current keeps that roster forever. That is
 * the right posture for a hand-edited list and the wrong one for an untouched seed: a model
 * the vendor added never reaches the install, and when the vendor's live `/models` roster
 * does not list it either, nothing else can surface it.
 *
 * This rewrites one thing: a saved `models` list that is still byte-for-byte the roster
 * this file names as `from`, on a provider that still carries the registry adapter, and
 * only while the registry currently seeds `to`. A list the user changed does not match and
 * is left alone. For each added id it also fills a per-model context window, output limit
 * and default effort, but only inside a container the row already has: enrichment fills
 * those records all-or-nothing, so creating one here would hide the rest of the registry seed.
 * Same shape and restraint as `stale-context-window-migration`.
 */
import { ALIBABA_INTL_TOKEN_PLAN_BASE_URL, MOONSHOT_CN_BASE_URL, MOONSHOT_INTL_BASE_URL } from "./base-url-choices";
import { PROVIDER_REGISTRY, normalizedProviderEndpoint } from "./registry";
import {
  ALIBABA_TOKEN_PLAN_MODELS,
  ALIBABA_INTL_TOKEN_PLAN_MODELS,
  ALIBABA_TOKEN_PLAN_CONTEXT_WINDOWS,
  ALIBABA_TOKEN_PLAN_MAX_OUTPUT_TOKENS,
  KIMI_API_DEFAULT_REASONING_EFFORTS,
  KIMI_API_MODEL_CONTEXT_WINDOWS,
  KIMI_API_MODELS,
  KIMI_API_MODELS_BEFORE_K31,
  META_MODEL_API_MODELS,
  META_MUSE_CONTEXT_WINDOW,
  META_MUSE_MODELS,
  META_MUSE_WONDER_MODEL,
  MINIMAX_M31_DEFAULT_REASONING_EFFORT,
  MINIMAX_M31_FLASH,
  MINIMAX_M31_FLASH_MAX_OUTPUT_TOKENS,
  MINIMAX_MODELS,
  MINIMAX_MODELS_BEFORE_M31,
  MINIMAX_MODEL_CONTEXT_WINDOWS,
} from "./registry/model-seeds";
import type { OcxConfig } from "../types";
import { modelRecordValue } from "../reasoning-effort";

export interface StaleModelRoster {
  /** Registry provider id whose saved rows may carry the old roster. */
  provider: string;
  /** The exact saved roster this migration may replace, and nothing else. */
  from: readonly string[];
  /** Exact old roster after id renames; metadata additions still compare against `from`. */
  afterModelRenames?: readonly string[];
  to: readonly string[];
  /** Per-model seed values for the added ids, written only into containers that exist. */
  contextWindows?: Readonly<Record<string, number>>;
  /**
   * Custom catalog rows read the saved map directly, so an added id missing from a
   * partial map would publish without the registry output limit.
   */
  maxOutputTokens?: Readonly<Record<string, number>>;
  defaultReasoningEfforts?: Readonly<Record<string, string>>;
  /**
   * For a provider whose saved URL may point elsewhere (pay-as-you-go or Custom), the
   * destinations whose roster `to` describes. A row on any other URL keeps its list; a row
   * with no saved URL uses the registry default and is refreshed.
   */
  destinationBaseUrls?: readonly string[];
}

export interface StaleModelRosterProjection {
  config: OcxConfig;
  changed: boolean;
  warnings: string[];
}

const ALIBABA_TOKEN_PLAN_MODELS_BEFORE_1017 = [
  "qwen3.8-max", "qwen3.8-flash", "qwen3.7-max", "qwen3.7-plus", "qwen3.6-flash",
  "deepseek-v4-pro", "deepseek-v4-flash-0731", "deepseek-v4.1-flash", "glm-5.2", "glm-5.3",
];
const ALIBABA_INTL_TOKEN_PLAN_MODELS_BEFORE_1017 = [
  "qwen3.8-max", "qwen3.8-flash", "qwen3.7-max", "qwen3.7-plus", "qwen3.6-plus", "qwen3.6-flash",
  "deepseek-v4-pro", "deepseek-v4-pro-0813", "deepseek-v4-flash", "deepseek-v4-flash-0731", "deepseek-v4.1-flash", "deepseek-v3.2",
  "kimi-k2.7-code", "kimi-k2.6", "kimi-k2.5",
  "glm-5.2", "glm-5.3", "glm-5.1", "glm-5",
  "MiniMax-M2.5",
];

/**
 * MiniMax-M3.1-Flash (2026-10-21). MiniMax's /v1/models roster does not list the
 * Flash, so live discovery cannot add it; the catalog keeps it only when it is configured.
 */
export const STALE_MODEL_ROSTERS: readonly StaleModelRoster[] = [
  {
    provider: "meta-model",
    from: META_MUSE_MODELS,
    to: META_MODEL_API_MODELS,
    contextWindows: { [META_MUSE_WONDER_MODEL]: META_MUSE_CONTEXT_WINDOW },
    // A Custom row may keep this id pointed at another gateway
    // (preserveCustomDestination); only api.meta.ai publishes the roster `to` describes.
    destinationBaseUrls: ["https://api.meta.ai/v1"],
  },
  {
    provider: "deepseek",
    from: ["deepseek-chat", "deepseek-reasoner", "deepseek-flash", "deepseek-v4-flash", "deepseek-v4-flash-vision-exp"],
    to: ["deepseek-chat", "deepseek-reasoner", "deepseek-flash", "deepseek-v4-flash", "deepseek-v4-pro", "deepseek-v4-flash-vision-exp"],
    contextWindows: { "deepseek-v4-pro": 1_048_576 },
    destinationBaseUrls: ["https://api.deepseek.com", "https://api.deepseek.com/v1"],
  },
  ...["minimax", "minimax-cn"].map(provider => ({
    provider,
    from: MINIMAX_MODELS_BEFORE_M31,
    to: MINIMAX_MODELS,
    contextWindows: { [MINIMAX_M31_FLASH]: MINIMAX_MODEL_CONTEXT_WINDOWS[MINIMAX_M31_FLASH]! },
    maxOutputTokens: { [MINIMAX_M31_FLASH]: MINIMAX_M31_FLASH_MAX_OUTPUT_TOKENS },
    defaultReasoningEfforts: { [MINIMAX_M31_FLASH]: MINIMAX_M31_DEFAULT_REASONING_EFFORT },
    // #7807: Custom destinations keep their roster and partial metadata maps.
    destinationBaseUrls: ["https://api.minimax.io/v1", "https://api.minimaxi.com/v1", "https://api.minimax.cn/v1"]
      .flatMap(url => [url, `${url}/chat/completions`]),
  })),
  ...[
    { provider: "alibaba-token-plan", from: ALIBABA_TOKEN_PLAN_MODELS_BEFORE_1017, to: ALIBABA_TOKEN_PLAN_MODELS },
    // International honors pay-as-you-go and Custom URLs, which may still serve the retired ids.
    // Beijing needs no guard: the router pins it to the registry Token Plan host.
    {
      provider: "alibaba-token-plan-intl", from: ALIBABA_INTL_TOKEN_PLAN_MODELS_BEFORE_1017, to: ALIBABA_INTL_TOKEN_PLAN_MODELS,
      destinationBaseUrls: [ALIBABA_INTL_TOKEN_PLAN_BASE_URL],
    },
  ].map(entry => ({
    ...entry,
    contextWindows: ALIBABA_TOKEN_PLAN_CONTEXT_WINDOWS,
    maxOutputTokens: ALIBABA_TOKEN_PLAN_MAX_OUTPUT_TOKENS,
    defaultReasoningEfforts: { "deepseek-v4.1-flash-1017": "high" },
  })),
  // Kimi K3.1 Pro (#7653). Both the International and China platforms list kimi-k3.1-pro and
  // -highspeed; a Custom URL may be another gateway, so it keeps its saved list.
  {
    provider: "moonshot",
    from: KIMI_API_MODELS_BEFORE_K31,
    afterModelRenames: KIMI_API_MODELS_BEFORE_K31.map(id => id === "kimi-k2.5" ? "kimi-k3.1-pro" : id),
    to: KIMI_API_MODELS,
    contextWindows: KIMI_API_MODEL_CONTEXT_WINDOWS,
    defaultReasoningEfforts: KIMI_API_DEFAULT_REASONING_EFFORTS,
    destinationBaseUrls: [MOONSHOT_INTL_BASE_URL, MOONSHOT_CN_BASE_URL],
  },
];

function sameList(value: unknown, expected: readonly string[]): boolean {
  return Array.isArray(value)
    && value.length === expected.length
    && value.every((item, index) => item === expected[index]);
}

function registrySeeds(provider: string, adapter: unknown, roster: readonly string[]): boolean {
  const entry = PROVIDER_REGISTRY.find(row => row.id === provider);
  return entry !== undefined && entry.adapter === adapter && sameList(entry.models, roster);
}

function servesRoster(baseUrl: unknown, destinations: readonly string[] | undefined): boolean {
  if (!destinations || baseUrl === undefined || baseUrl === "") return true;
  if (typeof baseUrl !== "string") return false;
  const saved = normalizedProviderEndpoint(baseUrl);
  return destinations.some(url => normalizedProviderEndpoint(url) === saved);
}

function fillExisting<T>(container: Record<string, T> | undefined, values: Readonly<Record<string, T>> | undefined, ids: readonly string[]): boolean {
  if (!container || !values) return false;
  let filled = false;
  for (const id of ids) {
    const value = values[id];
    if (value !== undefined && modelRecordValue(container, id) === undefined) {
      container[id] = value;
      filled = true;
    }
  }
  return filled;
}

/** Pure projection. The caller decides whether to persist. */
export function projectStaleModelRosters(
  config: OcxConfig,
  entries: readonly StaleModelRoster[] = STALE_MODEL_ROSTERS,
): StaleModelRosterProjection {
  const warnings: string[] = [];
  let changed = false;

  for (const entry of entries) {
    const prov = config.providers?.[entry.provider];
    if (!prov) continue;
    if (!registrySeeds(entry.provider, prov.adapter, entry.to)) continue;
    if (!servesRoster(prov.baseUrl, entry.destinationBaseUrls)) continue;
    const added = entry.to.filter(id => !entry.from.includes(id));
    if (sameList(prov.models, entry.to)) {
      // A row refreshed before output limits joined the refresh still has a partial map.
      // Only that record is revisited: the earlier pass already filled windows and efforts,
      // so refilling them could restore a key the operator has since removed.
      if (fillExisting(prov.modelMaxOutputTokens, entry.maxOutputTokens, added)) {
        changed = true;
        warnings.push(`filled output limits for ${added.join(", ")} on the saved "${entry.provider}" row.`);
      }
      continue;
    }
    if (!sameList(prov.models, entry.from)
      && !(entry.afterModelRenames && sameList(prov.models, entry.afterModelRenames))) continue;
    prov.models = [...entry.to];
    fillExisting(prov.modelContextWindows, entry.contextWindows, added);
    fillExisting(prov.modelMaxOutputTokens, entry.maxOutputTokens, added);
    fillExisting(prov.modelDefaultReasoningEfforts, entry.defaultReasoningEfforts, added);
    changed = true;
    warnings.push(
      `added ${added.join(", ")} to the saved "${entry.provider}" model list, which was still `
      + "the previous registry seed.",
    );
  }

  return { config, changed, warnings };
}
