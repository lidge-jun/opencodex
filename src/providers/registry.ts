import type { CodexAccountMode, FastWire, OcxProviderConfig } from "../types";
import { fastWireDeclarationError } from "./fastwire";
import { KIRO_MODELS, KIRO_MODEL_CONTEXT_WINDOWS, KIRO_MODEL_REASONING_EFFORTS } from "./kiro-models";
import { ANTIGRAVITY_MODELS, ANTIGRAVITY_MODEL_CONTEXT_WINDOWS, ANTIGRAVITY_MODEL_EFFORTS, ANTIGRAVITY_MODEL_INPUT_MODALITIES } from "./antigravity-models";
import type { ProviderBaseUrlChoice } from "./base-url-choices";
import {
  QWEN_CLOUD_BASE_URL_CHOICES, QWEN_CLOUD_TOKEN_PLAN_BASE_URL,
  ALIBABA_INTL_BASE_URL_CHOICES, ALIBABA_INTL_TOKEN_PLAN_BASE_URL,
  ALIBABA_CODING_BASE_URL_CHOICES, ALIBABA_CODING_INTL_BASE_URL,
  MOONSHOT_BASE_URL_CHOICES, MOONSHOT_INTL_BASE_URL,
} from "./base-url-choices";
import {
  CURSOR_NO_VISION_MODELS,
  CURSOR_STATIC_MODELS,
  cursorModelContextWindows,
  cursorModelIds,
  cursorModelInputModalities,
  cursorModelReasoningEfforts,
} from "../adapters/cursor/discovery";
import { COMMAND_CODE_MODEL_REASONING_EFFORTS } from "./command-code-efforts";
import { isCanonicalOpenRouterTarget } from "./openrouter-routing";

export type ProviderAuthKind = "forward" | "oauth" | "key" | "local";
export type MetadataModelIdNormalize = "case-insensitive";

/**
 * Wire protocol a client spoke when it reached the proxy. Chat and Anthropic surfaces
 * translate into a Responses-shaped body and replay through `handleResponses`, so the
 * original inbound has to travel with the request or the replay looks native.
 */
export type InboundWire = "responses" | "chat" | "anthropic";

/**
 * A per-model wire default: a bare string applies to every inbound, while the object
 * form may scope the default to listed inbound protocols and authentication modes.
 */
export type ModelWireDefault = string | {
  wire: string;
  inbound: readonly InboundWire[];
  authModes?: readonly ProviderAuthKind[];
  /** Whether this registry-selected route may relay a caller-owned service_tier. */
  forwardCallerServiceTier?: boolean;
};

export interface ResponsesTerminalRepairPolicy {
  /** Quiet time after a structurally complete output graph before synthesizing completion. */
  graceMs: number;
}

export type ProviderModelDiscoveryScalar = string | number | boolean;

export type ProviderModelDiscoveryPredicate =
  | {
      path: readonly string[];
      equalsAny: readonly ProviderModelDiscoveryScalar[];
      caseInsensitive?: boolean;
    }
  | {
      path: readonly string[];
      /**
       * A string-valued upstream target uses substring matching; an array-valued target uses
       * exact element matching. Use `equalsAny` when the string must match in full.
       */
      containsAny: readonly ProviderModelDiscoveryScalar[];
      caseInsensitive?: boolean;
    }
  | {
      path: readonly string[];
      /** Uses the same string-substring and array-element semantics as `containsAny`. */
      containsAll: readonly ProviderModelDiscoveryScalar[];
      caseInsensitive?: boolean;
    };

export interface ProviderModelDiscoveryFilter {
  /** Every predicate must match. */
  allOf?: readonly ProviderModelDiscoveryPredicate[];
  /** At least one predicate must match. */
  anyOf?: readonly ProviderModelDiscoveryPredicate[];
  /** No predicate may match. */
  noneOf?: readonly ProviderModelDiscoveryPredicate[];
}

interface ProviderModelDiscoverySharedSpec {
  /** Query parameters applied to the resolved discovery URL. */
  query?: Readonly<Record<string, string>>;
  /** Declarative eligibility rules evaluated against each untrusted model row. */
  filter?: ProviderModelDiscoveryFilter;
  /** Optional lower byte ceiling; the process-wide hard ceiling still wins. */
  maxResponseBytes?: number;
  /** Optional lower raw-row ceiling; the process-wide hard ceiling still wins. */
  maxModels?: number;
  /**
   * If a valid extracted id starts with this prefix, strip it and re-validate the remainder.
   * Empty/invalid remainders skip that row only.
   */
  stripIdPrefix?: string;
}

type ProviderModelDiscoveryLocation =
  | {
      /** Registry-owned absolute endpoint. Mutually exclusive with `path`. */
      url: string;
      path?: never;
    }
  | {
      /** Resource path relative to baseUrl; query strings and fragments are disallowed. */
      path: string;
      url?: never;
    }
  | {
      /** Keep the adapter-derived default discovery endpoint. */
      url?: never;
      path?: never;
    };

/**
 * Trusted live-model discovery policy. This metadata is registry-only: it must never be copied
 * into config.json, where a same-named custom provider could otherwise redirect a stored key.
 */
export type ProviderModelDiscoverySpec = ProviderModelDiscoverySharedSpec & ProviderModelDiscoveryLocation;

export interface ProviderRegistryEntry {
  id: string;
  label: string;
  adapter: string;
  baseUrl: string;
  apiKeyTransport?: OcxProviderConfig["apiKeyTransport"];
  authKind: ProviderAuthKind;
  codexAccountMode?: CodexAccountMode;
  /** OAuth preset may explicitly honor a persisted API-key billing mode. */
  allowKeyAuthOverride?: boolean;
  allowPrivateNetworkByDefault?: boolean;
  keyOptional?: boolean;
  /**
   * Registry-only key-login policy for public model catalogs that cannot authenticate a key.
   * The dashboard flow then reports the key as unverifiable instead of a false positive.
   */
  apiKeyValidation?: "unknown";
  /**
   * Free-tier pricing (no paid subscription required). Distinct from `keyOptional`:
   * free tiers may still require an API key (e.g. NVIDIA NIM free credits).
   */
  freeTier?: boolean;
  allowBaseUrlOverride?: boolean;
  /**
   * Do not claim an existing same-named key provider whose fixed destination differs from this
   * preset. Enable for newly promoted ids so an older custom key cannot be silently retargeted.
   */
  preserveCustomDestination?: boolean;
  /**
   * Optional endpoint picker for providers with multiple official hosts
   * (e.g. Qwen Cloud token plan vs pay-as-you-go). Requires `allowBaseUrlOverride`
   * so the selected URL is honored at route time. A choice without `baseUrl` is "Custom".
   */
  baseUrlChoices?: readonly ProviderBaseUrlChoice[];
  /** Static headers merged into every upstream request for this provider. */
  staticHeaders?: Record<string, string>;
  modelSuffixBracketStrip?: boolean;
  featured?: boolean;
  dashboardPreset?: boolean;
  note?: string;
  dashboardUrl?: string;
  defaultModel?: string;
  models?: string[];
  liveModels?: boolean;
  /**
   * Registry-only per-model wire defaults for mixed OpenAI-compatible gateways.
   * These are intentionally not seeded into saved config: an explicit `modelAdapters`
   * entry must remain distinguishable and must always win over a default.
   *
   * A bare string applies to every inbound protocol. The object form scopes the
   * default to the inbound surfaces named in `inbound`, which is how a model that is
   * native on two wires can serve each client on the wire it already speaks instead
   * of paying a translation hop.
   */
  modelWireDefaults?: Record<string, ModelWireDefault>;
  /** Explicit Fast wire declaration; absence derives from the final model adapter. */
  fastWire?: FastWire | null;
  /**
   * Registry-only per-model override for the upstream request shape used behind a
   * Codex Responses WebSocket turn. `false` keeps the client-facing WebSocket but
   * asks the upstream Responses endpoint for bounded JSON, which the bridge then
   * reframes as Responses events. Use only for upstreams whose streaming response
   * can omit or indefinitely delay the terminal event.
   */
  modelResponsesUpstreamStreaming?: Record<string, boolean>;
  /** Registry-only repair for a model whose native Responses stream may omit its terminal. */
  modelResponsesTerminalRepair?: Record<string, ResponsesTerminalRepairPolicy>;
  /**
   * Registry-only client-facing item-id repair policy (#938), filled onto the
   * runtime provider only when the user has no explicit policy (derive.ts);
   * never seeded into saved config.
   */
  responsesItemIdRepair?: {
    message?: string[];
    reasoning?: string[];
    repairMissingTerminalIds?: boolean;
    repairInvalidIds?: boolean;
  };
  /**
   * Responses-API resource path for providers whose route is not `/v1/responses`.
   * Unlike `modelWireDefaults` above, this IS seeded into saved config: it describes
   * the provider's fixed endpoint rather than a default a user might want to override
   * per model. DeepSeek documents `POST /responses` with no `/v1` segment.
   */
  responsesPath?: string;
  /**
   * Responses upstream that stores nothing server-side. Stateful request parameters
   * are dropped and `store` is pinned false, and orphaned tool results left by a
   * replay miss are repaired rather than forwarded.
   */
  statelessResponses?: boolean;
  /**
   * Responses parser requires an unambiguous call batch and its matched result batch
   * to stay contiguous. This is seeded/backfilled like other fixed wire capabilities.
   */
  requiresAdjacentResponsesToolResults?: boolean;
  /**
   * Registry default for the provider's `service_tier` support; see
   * `OcxProviderConfig.supportsServiceTier`. Registry-only: backfilled (never
   * overriding) at enrich/route time and deliberately NOT seeded into saved
   * config, so an explicit user value stays distinguishable from the default
   * (and the canonical openai seed comparison keeps its exact key set).
   */
  supportsServiceTier?: boolean;
  /** Registry default for OpenAI extended hosted web_search field support. */
  supportsOpenAiWebSearchToolFields?: boolean;
  /** Registry default for native Responses custom-tool support. */
  supportsResponsesCustomTools?: boolean;
  /** Registry default for exact model service-tier capability; explicit config keys win. */
  modelSupportsServiceTier?: Record<string, boolean>;
  /**
   * Registry-only service-tier defaults for an OAuth preset's explicit API-key transport.
   * Applied only when `allowKeyAuthOverride` is true and the captured effective auth transport
   * is key-based. Explicit provider config still wins field-by-field, including `false`.
   */
  keyAuthServiceTier?: {
    supportsServiceTier?: boolean;
    modelSupportsServiceTier?: Record<string, boolean>;
    chatServiceTier?: boolean;
  };
  /** Provider-specific copy for the Codex catalog's Fast tier. */
  fastTierDescription?: string;
  /**
   * Registry-only destination guard for `modelSupportsServiceTier`. This scopes vendor evidence
   * without changing provider ownership, routing, authentication, or config validation.
   */
  modelServiceTierCapabilityBaseUrlGuard?: (baseUrl: string) => boolean;
  /** Registry default for plaintext reasoning replay; see `OcxProviderConfig.preserveResponsesReasoningContent`. Registry-only like `supportsServiceTier`. */
  preserveResponsesReasoningContent?: boolean;
  /** Registry defaults for per-model Codex reasoning propagation; explicit user keys win during enrichment. */
  modelSupportsReasoningSummaries?: Record<string, boolean>;
  modelDiscovery?: ProviderModelDiscoverySpec;
  contextWindow?: number;
  modelContextWindows?: Record<string, number>;
  modelInputModalities?: Record<string, string[]>;
  defaultMaxOutputTokens?: number;
  modelMaxOutputTokens?: Record<string, number>;
  reasoningEfforts?: string[];
  modelReasoningEfforts?: Record<string, string[]>;
  modelDefaultReasoningEfforts?: Record<string, string>;
  reasoningEffortMap?: Record<string, string>;
  modelReasoningEffortMap?: Record<string, Record<string, string>>;
  /**
   * Registry-authoritative models that send OpenAI's direct `reasoning_effort` field.
   * Runtime enrichment uses this to repair stale preset metadata that still classifies a model
   * as a thinking-budget/toggle model. This is registry-only and is never persisted as user config.
   */
  directReasoningEffortModels?: string[];
  reasoningWireFormat?: OcxProviderConfig["reasoningWireFormat"];
  noVisionModels?: string[];
  noReasoningModels?: string[];
  noTemperatureModels?: string[];
  noTopPModels?: string[];
  noPenaltyModels?: string[];
  /** Opt this provider into parallel tool calls (see OcxProviderConfig.parallelToolCalls). */
  parallelToolCalls?: boolean;
  /** Opt this provider into forwarding prompt_cache_key (OpenAI-specific; strict backends reject it). */
  promptCacheKey?: boolean;
  /**
   * Opt-in: forward `service_tier` on the `/chat/completions` wire. Same hazard as
   * `promptCacheKey` — an OpenAI-specific extension that strict gateways reject. Distinct from
   * `supportsServiceTier`, which governs the Responses wire.
   */
  chatServiceTier?: boolean;
  /** OpenAI Chat EOF policy for gateways that omit terminal frames after complete tool calls. */
  openaiChatEofTolerance?: boolean;
  autoToolChoiceOnlyModels?: string[];
  preserveReasoningContentModels?: string[];
  requiresReasoningPlaceholderModels?: string[];
  reasoningSplitModels?: string[];
  thinkingToggleModels?: string[];
  thinkingBudgetModels?: string[];
  escapeBuiltinToolNames?: boolean;
  oauthId?: string;
  virtualModels?: Record<string, { wireModelId: string; reasoningMode: "pro" }>;
  modelMaxInputTokens?: Record<string, number>;
  jawcodeBundle?: string;
  extraMetadataAliases?: string[];
  metadataModelIdNormalize?: MetadataModelIdNormalize;
  googleMode?: "ai-studio" | "vertex" | "cloud-code-assist";
  project?: string;
  location?: string;
}

export type ProviderConfigSeed = Pick<
  OcxProviderConfig,
  "adapter" | "baseUrl" | "apiKeyTransport" | "responsesPath" | "authMode" | "keyOptional" | "freeTier" | "modelSuffixBracketStrip" | "defaultModel" | "models"
  | "liveModels" | "contextWindow" | "modelContextWindows" | "modelInputModalities"
  | "modelMaxInputTokens" | "defaultMaxOutputTokens" | "modelMaxOutputTokens"
  | "reasoningEfforts" | "modelReasoningEfforts" | "modelDefaultReasoningEfforts" | "reasoningEffortMap" | "modelReasoningEffortMap" | "reasoningWireFormat"
  | "noVisionModels" | "noReasoningModels" | "noTemperatureModels" | "noTopPModels" | "noPenaltyModels"
  | "autoToolChoiceOnlyModels" | "preserveReasoningContentModels" | "requiresReasoningPlaceholderModels" | "reasoningSplitModels" | "thinkingToggleModels" | "thinkingBudgetModels" | "escapeBuiltinToolNames" | "openaiChatEofTolerance"
  | "googleMode" | "project" | "location" | "headers"
>;

// Shared between the OAuth (Claude account) and API-key Anthropic entries so both expose the
// same static model seed.
// 260710 context refresh: Tier-2 evidence in
// devlog/_plan/260710_provider_hardening/001_research_frontier.md.
const ANTHROPIC_MODELS = ["claude-fable-5", "claude-sonnet-5", "claude-opus-5", "claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5"];
const ANTHROPIC_MODEL_CONTEXT_WINDOWS: Record<string, number> = { "claude-sonnet-5": 1_000_000, "claude-fable-5": 1_000_000, "claude-opus-5": 1_000_000, "claude-opus-4-8": 1_000_000, "claude-opus-4-7": 1_000_000, "claude-opus-4-6": 1_000_000, "claude-sonnet-4-6": 1_000_000, "claude-haiku-4-5": 200_000 };

// 260814 GLM-5.3 is registered pre-emptively alongside 5.2 everywhere 5.2 appears. Z.AI's
// devpack "How to Switch Models" page (docs.z.ai/devpack/latest-model) lists glm-5.3 and
// glm-5.3[1m] as Coding Plan ids on the unchanged endpoints; the capability and pricing
// tables were not published yet, so every 5.3 row mirrors its 5.2 sibling until they settle.
// The non-Z.AI providers below are speculative on purpose: they carry 5.2 today and are
// expected to pick 5.3 up on their usual lag. Providers whose live /v1/models discovery is
// enabled self-correct on the next successful fetch; static ones need a follow-up refresh.
const ZAI_GLM_53_MODELS = ["glm-5.3", "glm-5.3[1m]"];
const ZAI_GLM_52_MODELS = ["glm-5.2", "glm-5.2[1m]"];
const ZAI_GLM_5X_MODELS = [...ZAI_GLM_53_MODELS, ...ZAI_GLM_52_MODELS];
const ZAI_GLM_52_REASONING_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
/**
 * GLM-5.3 does NOT share 5.2's five-tier ladder. docs.z.ai/devpack/latest-model folds every
 * incoming effort into three effective tiers — low/minimal/light -> low, medium/high -> high,
 * xhigh/max/ultra -> max — with max as both the default and the unknown-value fallback.
 * Advertising five levels would publish two picker rows that are indistinguishable on the wire,
 * so only the effective tiers are exposed (same treatment Cursor and Baseten already give GLM).
 */
const ZAI_GLM_53_REASONING_EFFORTS = ["low", "high", "max"];
/** Per-model ladders for the Coding Plan rows: 5.3 gets its three effective tiers, 5.2 keeps five. */
const ZAI_GLM_5X_REASONING_EFFORTS: Record<string, string[]> = {
  ...Object.fromEntries(ZAI_GLM_53_MODELS.map(id => [id, ZAI_GLM_53_REASONING_EFFORTS])),
  ...Object.fromEntries(ZAI_GLM_52_MODELS.map(id => [id, ZAI_GLM_52_REASONING_EFFORTS])),
};
// 260710 MiniMax models and context windows: Tier-2 evidence in
// devlog/_plan/260710_provider_hardening/002_research_cn.md.
const MINIMAX_MODELS = [
  "MiniMax-M3",
  "MiniMax-M2.7", "MiniMax-M2.7-highspeed",
  "MiniMax-M2.5", "MiniMax-M2.5-highspeed",
  "MiniMax-M2.1", "MiniMax-M2.1-highspeed",
  "MiniMax-M2",
];
const MINIMAX_MODEL_CONTEXT_WINDOWS: Record<string, number> = Object.fromEntries(
  MINIMAX_MODELS.map(id => [id, id === "MiniMax-M3" ? 1_000_000 : 204_800]),
);
const MINIMAX_M3_REASONING_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const MINIMAX_M3_REASONING_EFFORT_MAP: Record<string, string> = {
  none: "disabled",
  minimal: "disabled",
  low: "disabled",
  medium: "adaptive",
  high: "adaptive",
  xhigh: "adaptive",
  max: "adaptive",
};
const OPENAI_GPT56_MODELS = ["gpt-5.6", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"];
const OPENAI_GPT56_PRO_MODELS = ["gpt-5.6-sol-pro", "gpt-5.6-terra-pro", "gpt-5.6-luna-pro"];
const OPENAI_API_GPT56_CONTEXT_WINDOW = 1_050_000;
const OPENAI_API_GPT56_CONTEXT_WINDOWS: Record<string, number> = {
  ...Object.fromEntries([...OPENAI_GPT56_MODELS, ...OPENAI_GPT56_PRO_MODELS].map(id => [id, OPENAI_API_GPT56_CONTEXT_WINDOW])),
  "gpt-5.5": OPENAI_API_GPT56_CONTEXT_WINDOW,
};
const OPENAI_API_GPT56_MAX_INPUT_TOKENS: Record<string, number> = {
  ...Object.fromEntries([...OPENAI_GPT56_MODELS, ...OPENAI_GPT56_PRO_MODELS].map(id => [id, 922_000])),
  "gpt-5.5": 922_000,
};
const OPENAI_API_GPT56_VIRTUAL_MODELS: Record<string, { wireModelId: string; reasoningMode: "pro" }> = {
  "gpt-5.6-sol-pro": { wireModelId: "gpt-5.6-sol", reasoningMode: "pro" },
  "gpt-5.6-terra-pro": { wireModelId: "gpt-5.6-terra", reasoningMode: "pro" },
  "gpt-5.6-luna-pro": { wireModelId: "gpt-5.6-luna", reasoningMode: "pro" },
};
const OPENAI_API_GPT56_REASONING_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
/**
 * Daybreak program aliases. These `-latest` ids are the stable contract: OpenAI repoints
 * them at newer snapshots over time (red -> gpt-5.6-cyber, blue -> gpt-5.6-sol as of
 * 2026-08-11), so registering the ALIAS inherits future model swaps while a pinned
 * snapshot id would silently go stale. Snapshot ids are deliberately absent here.
 * Responses-only per both published endpoint tables (`v1/chat/completions` is marked
 * Not supported) — never add these to a chat-completions provider. Access needs separate
 * Daybreak approval and provisioning, so neither is ever a default.
 * Verified 2026-08-11: developers.openai.com/api/docs/models/daybreak-red-latest.md
 * and .../daybreak-blue-latest.md
 */
const OPENAI_DAYBREAK_MODELS = ["daybreak-red-latest", "daybreak-blue-latest"];
const OPENAI_DAYBREAK_CONTEXT_WINDOWS: Record<string, number> = {
  "daybreak-red-latest": 400_000,
  "daybreak-blue-latest": 1_050_000,
};
const OPENAI_DAYBREAK_MAX_INPUT_TOKENS: Record<string, number> = {
  "daybreak-red-latest": 272_000,
  "daybreak-blue-latest": 922_000,
};
/**
 * Neither Daybreak page publishes a reasoning-effort ladder. An explicit empty array means
 * "expose no effort control"; OMITTING the key would instead fall back to the full routed
 * ladder (`configuredReasoningEfforts` returns undefined -> `applyReasoningLevels` uses
 * ROUTED_REASONING_LEVELS), which would advertise efforts the models never documented.
 * `noReasoningModels` is wrong here: both pages document reasoning-token support, so these
 * are reasoning models with no *selectable* ladder.
 */
const OPENAI_DAYBREAK_REASONING_EFFORTS: Record<string, string[]> = Object.fromEntries(
  OPENAI_DAYBREAK_MODELS.map(id => [id, [] as string[]]),
);
const OPENROUTER_GPT56_MODELS = OPENAI_GPT56_MODELS.map(id => `openai/${id}`);
// OpenRouter's live /endpoints routes report 1,050,000; keep this separate from the
// unverified OpenAI API-key seed. Evidence: devlog/_plan/260710_provider_hardening/003_research_aggregators.md.
const OPENROUTER_GPT56_CONTEXT_WINDOW = 1_050_000;
const OPENROUTER_GPT56_CONTEXT_WINDOWS = {
  "openai/gpt-5.6-sol": OPENROUTER_GPT56_CONTEXT_WINDOW,
  "openai/gpt-5.6-terra": OPENROUTER_GPT56_CONTEXT_WINDOW,
  "openai/gpt-5.6-luna": OPENROUTER_GPT56_CONTEXT_WINDOW,
};

/**
 * Vendor thinking-toggle models (MiMo v2.x, GLM 5/5.1 on Zen Go): the wire knob is
 * `thinking: {type: enabled|disabled}` — a binary. Advertise the full Codex picker ladder
 * and map efforts onto the toggle. Zen Go
 * pass-through probed live 2026-07-07 (glm-5.2 toggle verified; mimo/minimax accept shape).
 */
const THINKING_TOGGLE_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const THINKING_TOGGLE_MAP: Record<string, string> = {
  none: "disabled",
  minimal: "disabled",
  low: "disabled",
  medium: "enabled",
  high: "enabled",
  xhigh: "enabled",
  max: "enabled",
};
const OPENCODE_GO_THINKING_TOGGLE_MODELS = [
  "mimo-v2.5", "mimo-v2.5-pro", "mimo-v2-omni", "mimo-v2-pro", "glm-5", "glm-5.1",
];
/**
 * Zhipu's domestic BigModel platform. Text families first, then the vision member: modalities are
 * declared per model because `noVisionModels` means the opposite of "text only" here — it routes
 * images through the proxy's vision sidecar (src/codex/catalog/provider-fetch.ts), a claim nobody
 * has verified for BigModel-hosted GLM.
 */
const ZHIPU_BIGMODEL_TEXT_MODELS = ["glm-4.6", "glm-4.7", "glm-4.7-flash", "glm-5", "glm-5.1", "glm-5.2", "glm-5.3"];
const ZHIPU_BIGMODEL_MODELS = [...ZHIPU_BIGMODEL_TEXT_MODELS, "glm-4.6v"];
const ZHIPU_BIGMODEL_INPUT_MODALITIES: Record<string, string[]> = {
  ...Object.fromEntries(ZHIPU_BIGMODEL_TEXT_MODELS.map(id => [id, ["text"]])),
  "glm-4.6v": ["text", "image"],
};
const ZHIPU_BIGMODEL_THINKING_TOGGLE_MODELS = ["glm-4.6", "glm-4.7", "glm-5", "glm-5.1", "glm-5.2", "glm-5.3"];
const THINKING_BUDGET_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
// Qwen3.8-Max is the first Qwen3.x model with official direct `reasoning_effort` support.
// Evidence: https://qwen.ai/blog?id=qwen3.8
const QWEN38_REASONING_EFFORTS = ["low", "medium", "xhigh"];
const THINKING_BUDGET_MODELS = [
  "qwen3.5-397b", "qwen3.6-35b",
  "qwen3.5-plus", "qwen3.6-plus", "qwen3.7-max", "qwen3.7-plus",
];
const OPENCODE_GO_THINKING_BUDGET_MODELS = ["qwen3.5-plus", "qwen3.6-plus", "qwen3.7-max", "qwen3.7-plus"];
const DEEPSEEK_THINKING_MODELS = ["deepseek-v4-pro", "deepseek-v4-flash"];
/*
 * DeepSeek's experimental vision preview (released 2026-08-21, api-docs.deepseek.com):
 * text+image input on the V4 Flash base. DeepSeek positions it as a preview id;
 * the expectation is that vision merges into `deepseek-v4-flash` proper later,
 * at which point this id retires the same way deepseek-chat/reasoner did.
 */
const DEEPSEEK_VISION_PREVIEW_MODEL = "deepseek-v4-flash-vision-exp";
const OPENCODE_FREE_DEEPSEEK_MODELS = ["deepseek-v4-flash-free"];
/*
 * OpenCode Zen's free slug for the OpenRouter stealth model "Ox Alpha"
 * (openrouter.ai/stealth/ox-alpha): 1,048,576-token context, multimodal
 * (text+image+video upstream; Zen serves text+image), mandatory reasoning,
 * free during the stealth window. Zen displays it as "Ox Alpha Free" under
 * this exact id (opencode.ai/docs/zen, verified 2026-08-21).
 */
const OPENCODE_OX_ALPHA_FREE_MODEL = "x-preview-f-free";
const OX_ALPHA_CONTEXT_WINDOW = 1_048_576;
/*
 * Zen free models that reject `image_url` upstream (#1043, and the reproducible
 * half of #1024).
 *
 * Zen publishes NO modality metadata — its `/v1/models` returns only id, object,
 * created, owned_by — so this list is measured, not derived. Each id was probed
 * once against https://opencode.ai/zen/v1 on 2026-08-05 with a text control first
 * and then a 1x1 PNG; the six below failed the image request, four of them with
 * `[404] No endpoints found that support image input` and `big-pickle` with the
 * exact deserialize error quoted in #1043.
 *
 * `mimo-v2.5-free` and `longcat-2.0-free` ACCEPT images and are deliberately
 * absent. Adding them would silently replace a working image with a caption,
 * which is worse than the loud 400 this list exists to prevent — see the negative
 * assertion in tests/provider-registry-parity.test.ts.
 *
 * Zen's roster is discovered live while this list is static, so it is a dated
 * exception list, not a capability model. Re-probe before extending it.
 * Evidence: devlog/_fin/260805_bug_fix_stack/002_zen_modality_probe.md
 */
const OPENCODE_ZEN_TEXT_ONLY_MODELS = [
  "big-pickle",
  "nemotron-3-ultra-free",
  "ling-3.0-flash-free",
  "north-mini-code-free",
  "laguna-s-2.1-free",
  "deepseek-v4-flash-free",
];
/*
 * DeepSeek's Codex ladder is low/high/max. With the V4 Pro GA release
 * (DeepSeek-V4-Pro-0813) the official thinking-mode table is IDENTICAL for both
 * V4 models (api-docs.deepseek.com/guides/thinking_mode, verified 2026-08-13):
 *
 *   requested  | v4-flash | v4-pro
 *   low        | low      | low
 *   medium     | high     | high
 *   high       | high     | high
 *   xhigh      | high     | high
 *   max        | max      | max
 *
 * Before GA, Pro silently upgraded low->high and mapped xhigh->max (#1057-era
 * table); the page's footnote about an early-August Pro mapping update landed
 * with this GA, so Pro now advertises the same three real tiers as Flash.
 *
 * Two standing notes (#1057):
 *
 * - `xhigh` is a COMPATIBILITY ALIAS, not a native tier. It stays in the wire maps
 *   so existing requests and saved configs keep working, but it is not advertised.
 * - `medium` has no row in the vendor table — mapping it to `high` is OUR
 *   compatibility choice for clients that only speak the OpenAI ladder.
 */
const DEEPSEEK_FLASH_THINKING_EFFORTS = ["low", "high", "max"];
const DEEPSEEK_PRO_THINKING_EFFORTS = ["low", "high", "max"];
const DEEPSEEK_PRO_REASONING_MAP: Record<string, string> = {
  low: "low",
  medium: "high",
  high: "high",
  xhigh: "high",
  max: "max",
};
const DEEPSEEK_FLASH_REASONING_MAP: Record<string, string> = {
  low: "low",
  medium: "high",
  high: "high",
  xhigh: "high",
  max: "max",
};
/**
 * Flash-versus-Pro classification for DeepSeek V4 model ids, including prefixed
 * (`deepseek/deepseek-v4-pro`) and suffixed (`deepseek-v4-flash-free`) forms.
 * `tests/provider-registry-parity.test.ts` enumerates every id the registry
 * actually passes here, so a future id this substring test would misread cannot
 * land silently.
 */
const isDeepseekFlashModel = (modelId: string): boolean =>
  modelId.toLowerCase().includes("flash");
const deepseekThinkingEffortsFor = (modelId: string): string[] =>
  isDeepseekFlashModel(modelId) ? DEEPSEEK_FLASH_THINKING_EFFORTS : DEEPSEEK_PRO_THINKING_EFFORTS;
const deepseekReasoningMapFor = (modelId: string): Record<string, string> =>
  isDeepseekFlashModel(modelId) ? DEEPSEEK_FLASH_REASONING_MAP : DEEPSEEK_PRO_REASONING_MAP;
// 260719 Alibaba Token Plan Personal Edition (China/Beijing). Keep it distinct from
// Coding Plan: the products use different exact allowlists and different base URLs.
// Evidence: https://help.aliyun.com/en/model-studio/token-plan-personal-overview
//           https://help.aliyun.com/en/model-studio/token-plan-quickstart
const ALIBABA_TOKEN_PLAN_MODELS = [
  "qwen3.8-max", "qwen3.7-max", "qwen3.7-plus", "qwen3.6-flash",
  "glm-5.3", "glm-5.2", "deepseek-v4-pro",
];
const ALIBABA_TOKEN_PLAN_QWEN_MODELS = [
  "qwen3.8-max", "qwen3.7-max", "qwen3.7-plus", "qwen3.6-flash",
];
const ALIBABA_TOKEN_PLAN_INPUT_MODALITIES: Record<string, string[]> = {
  "qwen3.8-max": ["text", "image"],
  "qwen3.7-max": ["text", "image"],
  "qwen3.7-plus": ["text", "image"],
  "qwen3.6-flash": ["text", "image"],
  "glm-5.3": ["text"],
  "glm-5.2": ["text"],
  "deepseek-v4-pro": ["text"],
};

// 260721 Alibaba Token Plan International (ap-southeast-1 / Singapore, hardened 260721).
// Multi-vendor lineup distinct from Beijing — includes DeepSeek V4 flash, Kimi K2.7, MiniMax.
// Evidence: https://www.alibabacloud.com/help/en/model-studio/token-plan-overview
//           https://qwencloud.com/pricing/token-plan (qwen3.8 metadata)
const ALIBABA_INTL_TOKEN_PLAN_MODELS = [
  "qwen3.8-max", "qwen3.7-max", "qwen3.7-plus", "qwen3.6-plus", "qwen3.6-flash",
  "deepseek-v4-pro", "deepseek-v4-flash", "deepseek-v3.2",
  "kimi-k2.7-code", "kimi-k2.6", "kimi-k2.5",
  "glm-5.3", "glm-5.2", "glm-5.1", "glm-5",
  "MiniMax-M2.5",
];
const ALIBABA_INTL_TOKEN_PLAN_QWEN_MODELS = [
  "qwen3.8-max", "qwen3.7-max", "qwen3.7-plus", "qwen3.6-plus", "qwen3.6-flash",
];

// 260722 Tencent Cloud Coding Plan. The plan's model set is explicitly dynamic; these are the
// current documented ids and live discovery remains enabled so successful /models responses win.
// Tencent marks every Coding Plan model as text-only input and restricts plan keys to interactive
// coding tools (not custom application backends or non-interactive batch automation).
// Evidence: https://cloud.tencent.cn/document/product/1823/130092
const TENCENT_CODING_PLAN_MODELS = ["tc-code-latest", "glm-5", "kimi-k2.5", "minimax-m2.5"];
// Volcengine's authenticated /api/v3/models catalog mixes chat models with embedding,
// image, video, and 3D generation resources. Keep the Codex-facing presets scoped to
// models documented for text/agent or Coding Plan use.
//
// Maintenance owner: @lidge-jun. Verified 2026-08-01 against the vendor's own docs —
// endpoints https://docs.volcengine.com/docs/82379/1528783 (Coding Plan) and
// https://docs.volcengine.com/docs/82379/2165245 (Agent Plan); Codex CLI integration
// https://www.volcengine.com/docs/82379/2556056; supported clients
// https://www.volcengine.com/docs/82379/2188957; terms https://www.volcengine.com/docs/6256/64903
// (北京火山引擎科技有限公司). Plan quota is restricted to supported AI coding tools and misuse
// is documented as grounds for suspension — see the `note` on both Plan entries.
// Report a break by opening an issue tagging the owner; the three things that rot first are the
// static catalogs (liveModels:false cannot self-heal), the base URLs, and those Plan terms.
// Full evidence ledger: devlog/_fin/260801_pr611_volcengine_evidence/000_evidence_ledger.md
const VOLCENGINE_ARK_MODELS = [
  "doubao-seed-2-1-pro-260628",
  "doubao-seed-2-1-turbo-260628",
  "doubao-seed-evolving",
  "deepseek-v4-pro-260425",
  "deepseek-v4-flash-260425",
  "deepseek-v3-2-251201",
  // No glm-5-3 row: Ark pins date-stamped snapshot ids (glm-5-2-260617) that cannot be
  // guessed ahead of the vendor publishing them. Add it once /api/v3/models lists one.
  "glm-5-2-260617",
  "glm-4-7-251222",
];
const VOLCENGINE_DOUBAO_THINKING_MODELS = [
  "doubao-seed-2-1-pro-260628",
  "doubao-seed-2-1-turbo-260628",
  "doubao-seed-evolving",
];
const VOLCENGINE_CODING_PLAN_MODELS = [
  "ark-code-latest",
  "doubao-seed-2.0-code",
  "deepseek-v4-pro",
  "deepseek-v4-flash",
  "glm-5.3",
  "glm-5.2",
  "kimi-k2.6",
  "minimax-m3",
];
const VOLCENGINE_AGENT_PLAN_MODELS = [
  "deepseek-v4-pro",
  "deepseek-v4-flash",
  "glm-5.3",
  "glm-5.2",
  "kimi-k2.6",
  "minimax-m3",
  "doubao-seed-2.0-pro",
];
const VOLCENGINE_PLAN_INPUT_MODALITIES: Record<string, string[]> = {
  "kimi-k2.6": ["text", "image"],
  "minimax-m3": ["text", "image"],
};
// Every other Plan model is text-only. Declaring this explicitly keeps the vision
// sidecar from advertising image input for models that cannot accept it — the same
// treatment tencent-coding-plan gives its (entirely text-only) plan catalog.
const VOLCENGINE_PLAN_TEXT_ONLY_MODELS = [
  "ark-code-latest",
  "doubao-seed-2.0-code",
  "deepseek-v4-pro",
  "deepseek-v4-flash",
  "glm-5.3",
  "glm-5.2",
  "doubao-seed-2.0-pro",
];
const ALIBABA_INTL_TOKEN_PLAN_INPUT_MODALITIES: Record<string, string[]> = {
  "qwen3.8-max": ["text", "image"],
  "qwen3.7-max": ["text", "image"],
  "qwen3.7-plus": ["text", "image"],
  "qwen3.6-plus": ["text", "image"],
  "qwen3.6-flash": ["text", "image"],
  "deepseek-v4-pro": ["text"],
  "deepseek-v4-flash": ["text"],
  "deepseek-v3.2": ["text"],
  "kimi-k2.7-code": ["text", "image"],
  "kimi-k2.6": ["text", "image"],
  "kimi-k2.5": ["text", "image"],
  "glm-5.3": ["text"],
  "glm-5.2": ["text"],
  "glm-5.1": ["text"],
  "glm-5": ["text"],
  "MiniMax-M2.5": ["text"],
};

// 260717 Kimi K3: the subscription endpoint uses one upstream id (`k3`) for both
// entitlement tiers. Bare `k3` advertises the Moderato 256K ceiling; the local `[1m]`
// alias advertises Allegretto's 1M ceiling and is stripped before the upstream request.
// The separately billed Moonshot API uses `kimi-k3`.
// Evidence: https://www.kimi.com/code/docs/en/kimi-code/models.html
//           https://www.kimi.com/code/docs/en/kimi-code/error-reference.html
const KIMI_K3_STANDARD_CONTEXT_WINDOW = 262_144;
const KIMI_K3_1M_CONTEXT_WINDOW = 1_048_576;
const KIMI_CODING_K3_MODELS = ["k3", "k3[1m]"];
const KIMI_LEGACY_API_MODELS = ["kimi-k2.7-code", "kimi-k2.7-code-highspeed", "kimi-k2.6", "kimi-k2.5"];
const KIMI_API_MODELS = ["kimi-k3", ...KIMI_LEGACY_API_MODELS];
const KIMI_CODING_MODELS = [...KIMI_CODING_K3_MODELS, ...KIMI_LEGACY_API_MODELS, "kimi-for-coding"];
const KIMI_THINKING_MODELS = KIMI_CODING_MODELS;
const KIMI_CODING_NO_REASONING_MODELS = KIMI_CODING_MODELS.filter(id => !KIMI_CODING_K3_MODELS.includes(id));
const KIMI_API_NO_REASONING_MODELS = KIMI_API_MODELS.filter(id => id !== "kimi-k3");
const KIMI_CODING_K3_REASONING_EFFORTS = ["low", "high", "max"];
const KIMI_CODING_K3_REASONING_EFFORT_MAP: Record<string, string> = {
  none: "none",
  low: "low",
  medium: "high",
  high: "high",
  xhigh: "max",
  max: "max",
};
const KIMI_CODING_REASONING_EFFORTS = Object.fromEntries(
  KIMI_CODING_MODELS.map(id => [id, KIMI_CODING_K3_MODELS.includes(id) ? KIMI_CODING_K3_REASONING_EFFORTS : []]),
);
const KIMI_CODING_DEFAULT_REASONING_EFFORTS = Object.fromEntries(
  KIMI_CODING_K3_MODELS.map(id => [id, "max"]),
);
const KIMI_CODING_REASONING_EFFORT_MAPS = Object.fromEntries(
  KIMI_CODING_K3_MODELS.map(id => [id, KIMI_CODING_K3_REASONING_EFFORT_MAP]),
);
const KIMI_API_REASONING_EFFORTS = Object.fromEntries(
  KIMI_API_MODELS.map(id => [id, id === "kimi-k3" ? ["max"] : []]),
);
const KIMI_LOCKED_PARAMETER_MODELS = KIMI_CODING_MODELS;
const KIMI_AUTO_TOOL_CHOICE_ONLY_MODELS = ["kimi-k2.7-code", "kimi-k2.7-code-highspeed", "kimi-for-coding"];
const KIMI_API_MODEL_CONTEXT_WINDOWS: Record<string, number> = Object.fromEntries(
  KIMI_API_MODELS.map(id => [id, id === "kimi-k3" ? KIMI_K3_1M_CONTEXT_WINDOW : 262_144]),
);
const KIMI_API_MODEL_INPUT_MODALITIES = { "kimi-k3": ["text", "image"] };

// 260715 NVIDIA NIM kimi family (issue #126): documented served ids on integrate
// chat/completions per docs.api.nvidia.com/nim/reference/llm-apis; live /v1/models
// currently lists only kimi-k2.6 but the list is dynamic, so carry the documented family.
const NVIDIA_NIM_KIMI_THINKING_MODELS = [
  "moonshotai/kimi-k2.6", "moonshotai/kimi-k2.5", "moonshotai/kimi-k2-thinking",
];
const NVIDIA_NIM_KIMI_MODELS = [
  ...NVIDIA_NIM_KIMI_THINKING_MODELS,
  "moonshotai/kimi-k2-instruct", "moonshotai/kimi-k2-instruct-0905",
];
/**
 * 260804 issue #956: NIM publishes no input-modality metadata on `/v1/models`, so the
 * registry is the only source of truth for which models can see images.
 *
 * Two lists, both verified per-model against NVIDIA documentation on 2026-08-04
 * (build.nvidia.com model pages and docs.api.nvidia.com/nim/reference/*). Evidence and
 * the per-id audit: devlog/_fin/260804_stack7_service_vision/011_nim_id_audit.md.
 *
 * Read `noVisionModels` carefully — it lists models that CANNOT see images, which is
 * what routes them through the proxy's vision sidecar (src/vision/index.ts) and makes the
 * catalog advertise image input for them. Membership is wrong in BOTH directions:
 *   - a text-only model missing from it keeps issue #956 (images blocked or rejected);
 *   - a vision model wrongly IN it gets its image silently replaced by another model's
 *     text description — no error, worse answers, extra cost.
 *
 * A new NIM id must be classified DELIBERATELY against its NVIDIA page, never assumed
 * from its name: `google/gemma-4-31b-it` carries no vision marker yet accepts images,
 * `-vl` also appears on embedding/reranking models, and `google/codegemma-7b` is
 * text-only while `google/codegemma-1.1-7b` has no current page at all. An unclassified
 * id is intentionally left alone rather than defaulted, because NIM serves non-chat
 * endpoints (embeddings, rerankers, guards, OCR) that reach the same code path.
 */
const NVIDIA_NIM_VISION_MODELS = [
  "meta/llama-3.2-11b-vision-instruct", "meta/llama-3.2-90b-vision-instruct",
  "nvidia/llama-3.1-nemotron-nano-vl-8b-v1", "nvidia/nemotron-nano-12b-v2-vl",
  "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning", "nvidia/cosmos3-nano-reasoner",
  "nvidia/ising-calibration-1.5-31b", "nvidia/ising-calibration-1-35b-a3b",
  "google/gemma-4-31b-it", "google/diffusiongemma-26b-a4b-it",
  "minimaxai/minimax-m3", "moonshotai/kimi-k2.6", "moonshotai/kimi-k2.5",
  "stepfun-ai/step-3.7-flash", "thinkingmachines/inkling",
  "mistralai/mistral-medium-3.5-128b",
];
/**
 * The catalog advertises image input only for `noVisionModels` members, so a natively
 * vision-capable model would otherwise be published as text-only and the Codex app would
 * block attachments before the native path ever runs.
 */
const NVIDIA_NIM_VISION_INPUT_MODALITIES: Record<string, string[]> = Object.fromEntries(
  NVIDIA_NIM_VISION_MODELS.map(id => [id, ["text", "image"]]),
);
/**
 * Text-only NIM chat models — 26 ids, each carrying an explicit `Input Modalities: Text`
 * (or equivalent) on its NVIDIA page. PR #964 proposed ~64; six of those are natively
 * image-capable and live in NVIDIA_NIM_VISION_MODELS above, and 32 more had no current
 * NVIDIA page and were dropped rather than assumed.
 *
 * kimi-k2-thinking and kimi-k2-instruct are text-only while k2.5/k2.6 are not — vision
 * and reasoning are independent axes, so all four stay in NVIDIA_NIM_KIMI_MODELS for
 * reasoning suppression regardless of which list they appear in here.
 */
const NVIDIA_NIM_NO_VISION_MODELS = [
  "deepseek-ai/deepseek-v4-flash", "deepseek-ai/deepseek-v4-pro",
  "google/codegemma-7b",
  "meta/llama-3.1-70b-instruct", "meta/llama-3.1-8b-instruct",
  "meta/llama-3.2-1b-instruct", "meta/llama-3.2-3b-instruct",
  "meta/llama-3.3-70b-instruct", "meta/llama2-70b",
  "mistralai/mistral-7b-instruct-v0.3", "mistralai/mistral-nemotron",
  "moonshotai/kimi-k2-thinking", "moonshotai/kimi-k2-instruct",
  "nvidia/llama-3.1-nemotron-nano-8b-v1", "nvidia/llama-3.1-nemotron-ultra-253b-v1",
  "nvidia/llama-3.3-nemotron-super-49b-v1", "nvidia/llama-3.3-nemotron-super-49b-v1.5",
  "nvidia/nemotron-3-nano-30b-a3b", "nvidia/nemotron-3-super-120b-a12b",
  "nvidia/nemotron-3-ultra-550b-a55b", "nvidia/nemotron-mini-4b-instruct",
  "nvidia/nvidia-nemotron-nano-9b-v2",
  "openai/gpt-oss-120b", "openai/gpt-oss-20b",
  "poolside/laguna-xs-2.1", "z-ai/glm-5.3", "z-ai/glm-5.2",
];
const KIMI_CODING_MODEL_CONTEXT_WINDOWS: Record<string, number> = Object.fromEntries(
  KIMI_CODING_MODELS.map(id => [id, id === "k3[1m]" ? KIMI_K3_1M_CONTEXT_WINDOW : KIMI_K3_STANDARD_CONTEXT_WINDOW]),
);
const KIMI_CODING_MODEL_INPUT_MODALITIES = Object.fromEntries(
  KIMI_CODING_K3_MODELS.map(id => [id, ["text", "image"]]),
);
const NEURALWATT_REASONING_HISTORY_MODELS = [
  "glm-5.3", "glm-5.3-short",
  "glm-5.2", "glm-5.2-short",
  "kimi-k2.6", "kimi-k2.7-code",
  "qwen3.5-397b", "qwen3.6-35b",
];

// 260728 Baseten Model APIs: `/v1/models` owns the live lineup, while these hints
// describe only capabilities that Baseten documents per slug. Unlisted live models
// intentionally inherit the empty provider ladder instead of being advertised with
// opencodex's generic reasoning defaults. Audio is omitted because the current proxy
// request model does not carry OpenAI `audio_url` parts.
// Evidence: https://docs.baseten.co/inference/model-apis/reasoning
//           https://docs.baseten.co/inference/model-apis/vision
const BASETEN_FULL_REASONING_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const BASETEN_MODEL_REASONING_EFFORTS: Record<string, string[]> = {
  "deepseek-ai/DeepSeek-V4-Pro": BASETEN_FULL_REASONING_EFFORTS,
  "thinkingmachines/inkling": BASETEN_FULL_REASONING_EFFORTS,
  "openai/gpt-oss-120b": BASETEN_FULL_REASONING_EFFORTS,
  "moonshotai/Kimi-K3": ["low", "high", "max"],
  // 260814: GLM-5.3 honours low/high/max upstream, unlike 5.2's high/max on Baseten.
  "zai-org/GLM-5.3": ["low", "high", "max"],
  "zai-org/GLM-5.3-Fast": ["low", "high", "max"],
  "zai-org/GLM-5.2": ["high", "max"],
  "zai-org/GLM-5.2-Fast": ["high", "max"],
};
const BASETEN_MODEL_REASONING_EFFORT_MAP: Record<string, Record<string, string>> = {
  "deepseek-ai/DeepSeek-V4-Pro": { none: "none", minimal: "minimal" },
  "thinkingmachines/inkling": { none: "none", minimal: "minimal" },
  "openai/gpt-oss-120b": { none: "none", minimal: "minimal" },
  "moonshotai/Kimi-K3": { none: "none" },
  "zai-org/GLM-5.3": { none: "none" },
  "zai-org/GLM-5.3-Fast": { none: "none" },
  "zai-org/GLM-5.2": { none: "none" },
  "zai-org/GLM-5.2-Fast": { none: "none" },
};
const BASETEN_MODEL_DEFAULT_REASONING_EFFORTS: Record<string, string> = {
  "deepseek-ai/DeepSeek-V4-Pro": "medium",
  "thinkingmachines/inkling": "high",
  "openai/gpt-oss-120b": "medium",
  "moonshotai/Kimi-K3": "max",
};
const BASETEN_MODEL_INPUT_MODALITIES: Record<string, string[]> = {
  "thinkingmachines/inkling": ["text", "image"],
  "moonshotai/Kimi-K2.6": ["text", "image"],
  "moonshotai/Kimi-K2.7-Code": ["text", "image"],
  "moonshotai/Kimi-K3": ["text", "image"],
};

// 260801 DigitalOcean and Scaleway expose OpenAI-shaped `/v1/models` rows with only
// id/object/created/owned_by, while their shared serverless catalogs also contain
// non-chat and endpoint-specific models. Fail closed by intersecting live discovery
// with ids that the providers' current first-party model tables establish for Chat
// Completions. A newly listed id therefore needs a docs-backed registry refresh before
// it can enter the Codex catalog.
// Evidence: https://docs.digitalocean.com/products/inference/details/models/
//           https://docs.digitalocean.com/reference/api/reference/serverless-inference/
//           https://www.scaleway.com/en/docs/generative-apis/reference-content/supported-models/
const DIGITALOCEAN_CHAT_COMPLETION_MODELS = [
  "arcee-trinity-large-thinking",
  "openai-gpt-5.6-sol",
  "openai-gpt-5.6-terra",
  "openai-gpt-5.6-luna",
  "qwen3-coder-flash",
  "qwen3.5-397b-a17b",
  "deepseek-v4-pro",
  "deepseek-4-flash",
  "deepseek-3.2",
  "gemma-4-31B-it",
  "minimax-m2.5",
  "kimi-k3",
  "kimi-k2.6",
  "kimi-k2.5",
  "llama3.3-70b-instruct",
  "llama-4-maverick",
  "mistral-3-14B",
  "nemotron-3-ultra-550b",
  "nvidia-nemotron-3-super-120b",
  "nemotron-3-nano-omni",
  "nemotron-nano-12b-v2-vl",
  "mimo-v2.5-pro",
  "glm-5.3",
  "glm-5.2",
  "glm-5.1",
  "glm-5",
  // The API reference uses this native slash id in its Chat Completions example.
  "meta-llama/Meta-Llama-3.1-8B-Instruct",
] as const;
const SCALEWAY_SERVERLESS_CHAT_MODELS = [
  "glm-5.3",
  "glm-5.2",
  // gpt-oss-120b is intentionally omitted: Scaleway requires Responses API for tool calling,
  // while this preset routes Codex agent tools through Chat Completions.
  "qwen3.6-35b-a3b",
  "qwen3.5-397b-a17b",
  "qwen3-235b-a22b-instruct-2507",
  "qwen3-coder-30b-a3b-instruct",
  "gemma-4-26b-a4b-it",
  "llama-3.3-70b-instruct",
  "mistral-medium-3.5-128b",
  "mistral-small-3.2-24b-instruct-2506",
  "pixtral-12b-2409",
] as const;
const SCALEWAY_MODEL_INPUT_MODALITIES: Record<string, string[]> = {
  "pixtral-12b-2409": ["text", "image"],
};
const UMANS_MODELS = [
  "umans-coder",
  "umans-kimi-k2.7",
  "umans-flash",
  "umans-glm-5.3",
  "umans-glm-5.2",
  "umans-glm-5.1",
  "umans-qwen3.6-35b-a3b",
];
const UMANS_REASONING_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const UMANS_GLM_REASONING_EFFORTS = ["high", "xhigh", "max"];
// 260814: Z.AI folds GLM-5.3 efforts into low/high/max, so `low` is a real tier here and
// `xhigh` is not distinct from `max` (docs.z.ai/devpack/latest-model).
const UMANS_GLM_53_REASONING_EFFORTS = ["low", "high", "max"];
const UMANS_TEXT_ONLY_MODELS = ["umans-glm-5.3", "umans-glm-5.2", "umans-glm-5.1"];
const UMANS_MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  "umans-coder": 262_144,
  "umans-kimi-k2.7": 262_144,
  "umans-flash": 262_144,
  "umans-glm-5.3": 405_504,
  "umans-glm-5.2": 405_504,
  "umans-glm-5.1": 202_752,
  "umans-qwen3.6-35b-a3b": 262_144,
};
const UMANS_MODEL_INPUT_MODALITIES: Record<string, string[]> = Object.fromEntries(
  UMANS_MODELS.map(id => [id, UMANS_TEXT_ONLY_MODELS.includes(id) ? ["text"] : ["text", "image"]]),
);
const CLINE_PASS_MODELS = [
  "cline-pass/glm-5.3",
  "cline-pass/glm-5.2",
  "cline-pass/kimi-k3",
  "cline-pass/kimi-k2.7-code",
  "cline-pass/kimi-k2.6",
  "cline-pass/deepseek-v4-pro",
  "cline-pass/deepseek-v4-flash",
  "cline-pass/mimo-v2.5",
  "cline-pass/mimo-v2.5-pro",
  "cline-pass/minimax-m3",
  "cline-pass/qwen3.8-max",
  "cline-pass/qwen3.7-max",
  "cline-pass/qwen3.7-plus",
];
const CLINE_PASS_MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  "cline-pass/glm-5.3": 1_048_576,
  "cline-pass/glm-5.2": 1_048_576,
  "cline-pass/kimi-k3": 1_048_576,
  "cline-pass/kimi-k2.7-code": 262_144,
  "cline-pass/kimi-k2.6": 262_144,
  "cline-pass/deepseek-v4-pro": 1_048_576,
  "cline-pass/deepseek-v4-flash": 1_048_576,
  "cline-pass/mimo-v2.5": 1_050_000,
  "cline-pass/mimo-v2.5-pro": 1_050_000,
  "cline-pass/minimax-m3": 1_048_576,
  "cline-pass/qwen3.7-max": 1_000_000,
  "cline-pass/qwen3.7-plus": 1_000_000,
};
const CLINE_PASS_IMAGE_MODELS = new Set([
  "cline-pass/kimi-k3",
  "cline-pass/kimi-k2.7-code",
  "cline-pass/kimi-k2.6",
  "cline-pass/mimo-v2.5",
  "cline-pass/minimax-m3",
  "cline-pass/qwen3.7-plus",
]);
const CLINE_PASS_MODALITY_KNOWN_MODELS = CLINE_PASS_MODELS.filter(id => id !== "cline-pass/qwen3.8-max");
const CLINE_PASS_TEXT_ONLY_MODELS = CLINE_PASS_MODALITY_KNOWN_MODELS.filter(id => !CLINE_PASS_IMAGE_MODELS.has(id));
const CLINE_PASS_MODEL_INPUT_MODALITIES: Record<string, string[]> = Object.fromEntries(
  CLINE_PASS_MODALITY_KNOWN_MODELS.map(id => [id, CLINE_PASS_IMAGE_MODELS.has(id) ? ["text", "image"] : ["text"]]),
);

export const PROVIDER_REGISTRY: readonly ProviderRegistryEntry[] = [
  {
    id: "openai",
    label: "OpenAI (Codex login)",
    adapter: "openai-responses",
    baseUrl: "https://chatgpt.com/backend-api/codex",
    authKind: "forward",
    codexAccountMode: "pool",
    supportsServiceTier: true,
    featured: true,
    note: "Codex login account pool (default) or Direct main-account mode via codexAccountMode",
  },
  {
    id: "cursor",
    label: "Cursor (experimental)",
    adapter: "cursor",
    baseUrl: "https://api2.cursor.sh",
    authKind: "oauth",
    featured: false,
    dashboardPreset: true,
    note: "Experimental Cursor bridge. Live transport and live model discovery are enabled after a standalone PKCE browser login via 'ocx login cursor'; native read/write/delete/shell/fetch execution is disabled by default and request text such as Codex sandbox markers never authorizes it. Set \"nativeLocalExec\": \"on\" on providers.cursor in ~/.opencodex/config.json (dashboard: Providers → Cursor → Edit JSON) only for a trusted local experiment where every data-plane caller is trusted. \"off\" denies all, \"codex-sandbox\" is accepted for backwards compatibility but fails closed, and legacy \"unsafeAllowNativeLocalExec\": true still means explicit operator opt-in.",
    models: cursorModelIds(CURSOR_STATIC_MODELS),
    liveModels: true,
    defaultModel: "auto",
    modelContextWindows: cursorModelContextWindows(CURSOR_STATIC_MODELS),
    modelInputModalities: cursorModelInputModalities(CURSOR_STATIC_MODELS),
    modelReasoningEfforts: cursorModelReasoningEfforts(CURSOR_STATIC_MODELS),
    // Kimi K3 documents `max` as its API default, and its Cursor ladder has no `medium`
    // rung — so applyReasoningLevels' medium->high->first fallback would settle the catalog
    // default on `high`, the picker would send `high` explicitly, and the request builder's
    // no-effort fallback to `kimi-k3-max` would never be reached. Mirrors the other K3
    // routes (kimi, kimi-code, opencode-go).
    modelDefaultReasoningEfforts: { "kimi-k3": "max" },
    // Blind Cursor models (Auto routers, Composer, GLM-5.2, GLM-5.3) go through the vision sidecar;
    // multimodal hosts (Claude/Gemini/GPT/Kimi/Grok) take native SelectedImage. The catalog
    // still advertises image for noVision members so Codex can attach (sidecar option B).
    noVisionModels: [...CURSOR_NO_VISION_MODELS],
  },
  {
    id: "xai",
    label: "xAI Grok",
    adapter: "openai-chat",
    baseUrl: "https://api.x.ai/v1",
    authKind: "oauth",
    allowKeyAuthOverride: true,
    // Priority Processing is documented for xAI's public API-key Chat Completions and
    // Responses endpoints. OAuth is a separate Grok CLI subscription gateway and remains
    // unclassified; do not turn this into a provider-wide supportsServiceTier declaration.
    keyAuthServiceTier: {
      supportsServiceTier: true,
      chatServiceTier: true,
    },
    fastTierDescription: "Priority processing, 2x token price",
    featured: true,
    oauthId: "xai",
    jawcodeBundle: "xai",
    supportsOpenAiWebSearchToolFields: false,
    // Live A/B on 2026-08-20: xAI rejects native custom/custom_tool_call shapes while accepting
    // the otherwise-identical request after the custom tool is lowered to a function.
    supportsResponsesCustomTools: false,
    note: "Log in with your Grok account",
    // Parallel tool calls: officially supported and default-on per docs.x.ai function-calling
    // (verified 260709, devlog/_plan/260709_parallel_tool_calls). Streamed calls arrive whole
    // per chunk, so the buffered parser assembles them losslessly.
    parallelToolCalls: true,
    // Live /v1/models discovery is the authoritative lineup (verified 260709: returns grok-4.5);
    // the static list below is the logged-out fallback seed.
    liveModels: true,
    // 260709 refresh: lineup + metadata from official docs.x.ai (grok-4.5 announced 07-08);
    // grok-composer-2.5-fast kept as account-verified (absent from public docs). Evidence:
    // devlog/model_update/260709_model_refresh/001_xai_lineup.md.
    // grok-4.20-multi-agent-0309 is intentionally absent: the OAuth chat-completions
    // transport returns 400 ("Multi Agent requests are not allowed on chat completions").
    // 260813: grok-4.6 added per docs.x.ai/developers/grok-4-6. Context/vision still match
    // grok-4.5; the reasoning ladder does not — 4.6 adds the documented xhigh rung.
    models: ["grok-4.6", "grok-4.5", "grok-4.3", "grok-4.20-0309-reasoning", "grok-4.20-0309-non-reasoning", "grok-build-0.1", "grok-composer-2.5-fast"],
    defaultModel: "grok-4.5",
    // Keep Codex Responses callers on the compatibility Chat wire until xAI can replay
    // opaque reasoning continuation and compaction state across later turns. The scoped
    // declaration also keeps caller-owned service tiers off the OAuth subscription route.
    modelWireDefaults: {
      "grok-4.6": {
        wire: "openai-chat",
        inbound: ["responses"],
        authModes: ["oauth"],
        forwardCallerServiceTier: false,
      },
      "grok-4.5": {
        wire: "openai-chat",
        inbound: ["responses"],
        authModes: ["oauth"],
        forwardCallerServiceTier: false,
      },
    },
    // Vision lineup per docs.x.ai model-capabilities/images/understanding: the grok-4.x chat
    // models accept image input (JPEG/PNG, URL or base64). Without this the catalog leaves
    // inputModalities undefined, and deriveComboCatalogModel defaults an undefined member to
    // ["text"] — so any combo containing an xAI target is advertised to Codex as text-only and
    // the app blocks attachments client-side. grok-build-0.1 / grok-composer-2.5-fast stay out
    // (they are already listed in noVisionModels below).
    modelInputModalities: {
      "grok-4.6": ["text", "image"],
      "grok-4.5": ["text", "image"],
      "grok-4.3": ["text", "image"],
      "grok-4.20-0309-reasoning": ["text", "image"],
      "grok-4.20-0309-non-reasoning": ["text", "image"],
    },
    noReasoningModels: ["grok-4.20-0309-non-reasoning", "grok-build-0.1", "grok-composer-2.5-fast"],
    // Replay assistant reasoning_content for grok reasoning models: xAI documents dropped
    // reasoning_content as the top cause of prompt-cache misses on multi-turn conversations
    // (docs.x.ai prompt-caching/multi-turn, verified 2026-07-13 — devlog/_plan/260713_grok_caching).
    // Models that never emit reasoning simply have no thinking parts to replay (no-op).
    preserveReasoningContentModels: ["grok-4.6", "grok-4.5", "grok-4.3", "grok-4.20-0309-reasoning"],
    // grok-4.5 reasoning is always-on with low/medium/high (no off tier, no xhigh).
    // grok-4.6 adds xhigh per docs.x.ai/developers/model-capabilities/text/reasoning;
    // xAI documents high as the upstream default.
    modelReasoningEfforts: { "grok-4.6": ["low", "medium", "high", "xhigh"], "grok-4.5": ["low", "medium", "high"] },
    modelDefaultReasoningEfforts: { "grok-4.6": "high" },
    modelContextWindows: {
      "grok-4.6": 500_000,
      "grok-4.5": 500_000,
      "grok-4.3": 1_000_000,
      "grok-4.20-0309-reasoning": 1_000_000,
      "grok-4.20-0309-non-reasoning": 1_000_000,
      "grok-build-0.1": 256_000,
    },
    noVisionModels: ["grok-build-0.1", "grok-composer-2.5-fast"],
  },
  {
    id: "command-code",
    label: "Command Code - Auth",
    adapter: "command-code",
    baseUrl: "https://api.commandcode.ai",
    authKind: "oauth",
    oauthId: "command-code",
    featured: true,
    note: "Log in with your Command Code account",
    // OAuth needs one initial selection, but the exposed catalog is always discovered from the
    // signed-in account. Do not add a static model list here.
    defaultModel: "deepseek/deepseek-v4-flash",
    liveModels: true,
    modelDiscovery: {
      url: "https://api.commandcode.ai/provider/v1/models",
      maxResponseBytes: 262_144,
      maxModels: 256,
    },
    // These are capability facts from official Command Code model profiles, not seeded models.
    // Unknown/new live models deliberately do not advertise a reasoning picker.
    reasoningEfforts: [],
    modelReasoningEfforts: COMMAND_CODE_MODEL_REASONING_EFFORTS,
    // Ox Alpha (stealth preview, changelog v1.31.0): free 1M multimodal reasoning
    // model on every plan. DeepSeek vision preview id is preemptive metadata —
    // it is expected to merge into deepseek-v4-flash later.
    modelContextWindows: {
      "stealth/ox-alpha": OX_ALPHA_CONTEXT_WINDOW,
      [`deepseek/${DEEPSEEK_VISION_PREVIEW_MODEL}`]: 1_048_576,
    },
    modelInputModalities: {
      "stealth/ox-alpha": ["text", "image"],
      [`deepseek/${DEEPSEEK_VISION_PREVIEW_MODEL}`]: ["text", "image"],
    },
    defaultMaxOutputTokens: 64_000,
    // The proprietary generate wire has no verified per-request serialization flag.
    parallelToolCalls: false,
  },
  {
    id: "anthropic",
    label: "Anthropic Claude",
    adapter: "anthropic",
    baseUrl: "https://api.anthropic.com",
    authKind: "oauth",
    allowBaseUrlOverride: true,
    featured: true,
    oauthId: "anthropic",
    jawcodeBundle: "anthropic",
    note: "Log in with your Claude account",
    models: [...ANTHROPIC_MODELS],
    modelContextWindows: { ...ANTHROPIC_MODEL_CONTEXT_WINDOWS },
    defaultModel: "claude-sonnet-5",
  },
  {
    id: "anthropic-apikey",
    label: "Anthropic (API key)",
    adapter: "anthropic",
    baseUrl: "https://api.anthropic.com",
    authKind: "key",
    featured: true,
    dashboardUrl: "https://console.anthropic.com/settings/keys",
    jawcodeBundle: "anthropic",
    extraMetadataAliases: ["anthropic-key"],
    note: "Direct Anthropic API billing — no Claude subscription",
    models: [...ANTHROPIC_MODELS],
    liveModels: true,
    modelContextWindows: { ...ANTHROPIC_MODEL_CONTEXT_WINDOWS },
    defaultModel: "claude-sonnet-5",
  },
  {
    id: "kimi",
    label: "Kimi",
    adapter: "openai-chat",
    baseUrl: "https://api.kimi.com/coding/v1",
    authKind: "oauth",
    modelSuffixBracketStrip: true,
    // Kimi Code Plan documents a stable session/task prompt_cache_key as required to improve
    // cache hit rates.
    // The chat adapter only forwards a key already on the internal request (Codex's session key,
    // or the one the Claude /v1/messages inbound derives); the adapter itself never invents one.
    // Evidence: https://platform.kimi.com/docs/api/chat
    promptCacheKey: true,
    featured: true,
    oauthId: "kimi",
    jawcodeBundle: "moonshot",
    note: "Log in with your Kimi account",
    models: KIMI_CODING_MODELS,
    defaultModel: "kimi-k2.7-code",
    modelContextWindows: KIMI_CODING_MODEL_CONTEXT_WINDOWS,
    modelInputModalities: KIMI_CODING_MODEL_INPUT_MODALITIES,
    // K3 accepts low/high/max; Codex aliases are normalized by the model-scoped wire map.
    noReasoningModels: KIMI_CODING_NO_REASONING_MODELS,
    modelReasoningEfforts: KIMI_CODING_REASONING_EFFORTS,
    modelDefaultReasoningEfforts: KIMI_CODING_DEFAULT_REASONING_EFFORTS,
    modelReasoningEffortMap: KIMI_CODING_REASONING_EFFORT_MAPS,
    noTemperatureModels: KIMI_LOCKED_PARAMETER_MODELS,
    noTopPModels: KIMI_LOCKED_PARAMETER_MODELS,
    noPenaltyModels: KIMI_LOCKED_PARAMETER_MODELS,
    autoToolChoiceOnlyModels: KIMI_AUTO_TOOL_CHOICE_ONLY_MODELS,
    preserveReasoningContentModels: KIMI_THINKING_MODELS,
  },
  {
    id: "kiro",
    label: "Kiro (AWS CodeWhisperer)",
    adapter: "kiro",
    baseUrl: "https://runtime.us-east-1.kiro.dev",
    authKind: "oauth",
    oauthId: "kiro",
    note: "Import-first: reuses your installed and signed-in Kiro CLI session (requires `kiro-cli login`). Add account logs `kiro-cli` out, switches it through a fresh browser login, stores the account by profile ARN, and restores the previous CLI session on cancellation or failure. Experimental third-party harness — see Kiro ToS.",
    models: KIRO_MODELS,
    defaultModel: "kiro-auto",
    // Kiro speaks CodeWhisperer wire, not OpenAI-style GET /models. Keep the static
    // catalog authoritative so a spurious 2xx from runtime.../models cannot drop seeded ids
    // (e.g. newly listed GPT-5.6 tiers) via live-discovery reconciliation.
    liveModels: false,
    // Per-model context metadata is maintained next to the Kiro model list.
    modelContextWindows: KIRO_MODEL_CONTEXT_WINDOWS,
    modelReasoningEfforts: KIRO_MODEL_REASONING_EFFORTS,
  },
  {
    // Nous Portal — Nous Research subscription gateway (same backend Hermes Agent
    // uses). OAuth is a device grant (src/oauth/nous.ts): the access token IS the
    // per-request inference JWT (scope inference:invoke), refresh tokens are
    // single-use and rotated on every refresh. Catalog is a mix of paid models
    // (billed against the Portal subscription) and `:free` slugs (e.g.
    // tencent/hy3:free, stepfun/step-3.7-flash:free, inclusionai/ling-3.0-flash:free);
    // free-tier gating is decided live by the Portal per account, so discovery
    // from the signed-in account is authoritative; the static seed below is the
    // logged-out fallback and only lists free models verified on a real account
    // (2026-08-10): the Portal free list is authoritative and currently has
    // exactly 4 :free models: tencent/hy3:free, poolside/laguna-s-2.1:free,
    // stepfun/step-3.7-flash:free, poolside/laguna-xs-2.1:free.
    // inclusionai/ling-3.0-flash:free was removed from the Portal free list
    // (404 on the inference API since 2026-08-07) and must not be seeded.
    id: "nous",
    label: "Nous Portal",
    adapter: "openai-chat",
    baseUrl: "https://inference-api.nousresearch.com/v1",
    authKind: "oauth",
    oauthId: "nous",
    featured: true,
    // Mixed free + paid provider: the free tier is per-model (the `:free`
    // slugs), not a property of the whole provider, so freeTier stays false to
    // avoid implying every model is free.
    freeTier: false,
    dashboardUrl: "https://portal.nousresearch.com",
    defaultModel: "tencent/hy3:free",
    liveModels: true,
    models: ["tencent/hy3:free", "poolside/laguna-s-2.1:free", "stepfun/step-3.7-flash:free", "poolside/laguna-xs-2.1:free"],
    modelDiscovery: {
      // Resolves against effectiveBaseUrl (registry baseUrl .../v1) to the same
      // canonical endpoint https://inference-api.nousresearch.com/v1/models.
      path: "models",
      maxResponseBytes: 262_144,
      maxModels: 512,
    },
    note: "Nous Research subscription gateway. OAuth device login with your own Portal account; mixed paid + :free models discovered live (fallback seed 2026-08-10: tencent/hy3:free, poolside/laguna-s-2.1:free, stepfun/step-3.7-flash:free, poolside/laguna-xs-2.1:free).",
  },
  {
    id: "openai-apikey",
    label: "OpenAI API",
    adapter: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
    authKind: "key",
    supportsServiceTier: true,
    featured: true,
    dashboardUrl: "https://platform.openai.com/api-keys",
    defaultModel: "gpt-5.5",
    models: ["gpt-5.5", ...OPENAI_GPT56_MODELS, ...OPENAI_GPT56_PRO_MODELS, ...OPENAI_DAYBREAK_MODELS],
    liveModels: true,
    modelContextWindows: { ...OPENAI_API_GPT56_CONTEXT_WINDOWS, ...OPENAI_DAYBREAK_CONTEXT_WINDOWS },
    modelMaxInputTokens: { ...OPENAI_API_GPT56_MAX_INPUT_TOKENS, ...OPENAI_DAYBREAK_MAX_INPUT_TOKENS },
    modelInputModalities: Object.fromEntries(
      ["gpt-5.5", ...OPENAI_GPT56_MODELS, ...OPENAI_GPT56_PRO_MODELS, ...OPENAI_DAYBREAK_MODELS]
        .map(id => [id, ["text", "image"]]),
    ),
    modelReasoningEfforts: {
      ...Object.fromEntries(
        [...OPENAI_GPT56_MODELS, ...OPENAI_GPT56_PRO_MODELS].map(id => [id, OPENAI_API_GPT56_REASONING_EFFORTS]),
      ),
      ...OPENAI_DAYBREAK_REASONING_EFFORTS,
    },
    virtualModels: OPENAI_API_GPT56_VIRTUAL_MODELS,
  },
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
      "umans-flash": UMANS_REASONING_EFFORTS,
      "umans-glm-5.3": UMANS_GLM_53_REASONING_EFFORTS,
      "umans-glm-5.2": UMANS_GLM_REASONING_EFFORTS,
      "umans-glm-5.1": UMANS_GLM_REASONING_EFFORTS,
      "umans-qwen3.6-35b-a3b": UMANS_REASONING_EFFORTS,
    },
    noVisionModels: UMANS_TEXT_ONLY_MODELS,
    escapeBuiltinToolNames: true,
  },
  {
    id: "opencode-go", label: "opencode go", adapter: "openai-chat", baseUrl: "https://opencode.ai/zen/go/v1",
    authKind: "key", featured: true, dashboardUrl: "https://opencode.ai/auth", defaultModel: "kimi-k2.7-code",
    jawcodeBundle: "opencode-go", note: "GLM, DeepSeek, Kimi, Qwen, MiMo…",
    // Zen Go can close a Chat stream after a fully assembled function call without sending
    // finish_reason or [DONE] (#2260). The adapter still rejects incomplete argument JSON.
    openaiChatEofTolerance: true,
    /* [Decision Log]
    - 목적과 의도: Route GPT 5.6 Luna to the Responses endpoint that OpenCode Go documents for that exact model.
    - 기존 구현 및 제약 조건: The provider is mixed-wire but its provider-wide `openai-chat` adapter sent Luna to `/chat/completions`; explicit user `modelAdapters` entries must remain authoritative.
    - 검토한 주요 대안: Change the whole provider to Responses; infer the wire from model-family names; add one registry-only exact-model default.
    - 선택한 방식: Declare only `gpt-5.6-luna` as `openai-responses` through the existing registry default mechanism.
    - 다른 대안 대신 이 방식을 선택한 이유: OpenCode Go documents sibling models on Chat or Anthropic endpoints, and an exact registry default preserves both those routes and explicit opt-out precedence.
    - 장점, 단점 및 영향: Luna reaches `/responses` from every inbound surface without changing siblings; a future upstream endpoint change requires an evidence-backed registry update.
    */
    modelWireDefaults: { "gpt-5.6-luna": "openai-responses" },
    modelContextWindows: {
      "kimi-k3": KIMI_K3_STANDARD_CONTEXT_WINDOW,
      // Ox Alpha (stealth 1M multimodal) and the DeepSeek vision preview are
      // metadata-only here: the Go roster is discovered live, so these apply
      // the moment the gateway starts serving the ids.
      [OPENCODE_OX_ALPHA_FREE_MODEL]: OX_ALPHA_CONTEXT_WINDOW,
      [DEEPSEEK_VISION_PREVIEW_MODEL]: 1_048_576,
    },
    modelInputModalities: {
      "kimi-k3": ["text", "image"],
      [OPENCODE_OX_ALPHA_FREE_MODEL]: ["text", "image"],
      // Experimental DeepSeek vision preview — expected to merge into deepseek-v4-flash later.
      [DEEPSEEK_VISION_PREVIEW_MODEL]: ["text", "image"],
    },
    modelReasoningEfforts: {
      "glm-5.3": ZAI_GLM_53_REASONING_EFFORTS,
      "glm-5.2": ZAI_GLM_52_REASONING_EFFORTS,
      "kimi-k3": KIMI_CODING_K3_REASONING_EFFORTS,
      "kimi-k2.7-code": [],
      "kimi-k2.7-code-highspeed": [],
      ...Object.fromEntries(OPENCODE_GO_THINKING_TOGGLE_MODELS.map(id => [id, THINKING_TOGGLE_EFFORTS])),
      ...Object.fromEntries(OPENCODE_GO_THINKING_BUDGET_MODELS.map(id => [id, THINKING_BUDGET_EFFORTS])),
      ...Object.fromEntries(DEEPSEEK_THINKING_MODELS.map(id => [id, deepseekThinkingEffortsFor(id)])),
    },
    modelDefaultReasoningEfforts: { "kimi-k3": "max" },
    // glm-5.2 uses identity labels now that `max` is a native Codex level (no alias map);
    // the thinking-toggle map is a REAL wire alias (effort -> enabled/disabled) and stays.
    modelReasoningEffortMap: {
      "kimi-k3": KIMI_CODING_K3_REASONING_EFFORT_MAP,
      ...Object.fromEntries(OPENCODE_GO_THINKING_TOGGLE_MODELS.map(id => [id, THINKING_TOGGLE_MAP])),
      ...Object.fromEntries(DEEPSEEK_THINKING_MODELS.map(id => [id, deepseekReasoningMapFor(id)])),
    },
    modelSupportsReasoningSummaries: {
      "glm-5.3": true,
      "glm-5.2": true,
      "glm-5.1": true,
      "glm-5": true,
      ...Object.fromEntries(DEEPSEEK_THINKING_MODELS.map(id => [id, true])),
    },
    thinkingToggleModels: OPENCODE_GO_THINKING_TOGGLE_MODELS,
    thinkingBudgetModels: THINKING_BUDGET_MODELS,
    noReasoningModels: ["kimi-k2.7-code", "kimi-k2.7-code-highspeed"],
    // Text-only Zen Go models (jawcode metadata) — the vision sidecar describes images for
    // every model listed here (and the catalog advertises image input on their behalf).
    // Kimi K2.7 Code accepts text+image+video: do NOT list it here.
    noVisionModels: [
      "glm-5.3", "glm-5.2", "glm-5", "glm-5.1",
      "deepseek-v4-flash", "deepseek-v4-pro",
      "mimo-v2-pro", "mimo-v2.5-pro",
      "minimax-m2.5", "minimax-m2.7",
      "qwen3.7-max",
    ],
    noTemperatureModels: ["kimi-k3", "kimi-k2.7-code", "kimi-k2.7-code-highspeed"],
    noTopPModels: ["kimi-k3", "kimi-k2.7-code", "kimi-k2.7-code-highspeed"],
    noPenaltyModels: ["kimi-k3", "kimi-k2.7-code", "kimi-k2.7-code-highspeed"],
    autoToolChoiceOnlyModels: ["kimi-k2.7-code", "kimi-k2.7-code-highspeed"],
    // Issue #78: DeepSeek V4 thinking mode requires reasoning_content replay on tool-call turns.
    preserveReasoningContentModels: ["glm-5.3", "glm-5.2", "kimi-k3", "kimi-k2.7-code", "kimi-k2.7-code-highspeed", ...DEEPSEEK_THINKING_MODELS],
  },
  {
    id: "neuralwatt",
    label: "Neuralwatt Cloud",
    adapter: "openai-chat",
    baseUrl: "https://api.neuralwatt.com/v1",
    authKind: "key",
    dashboardUrl: "https://portal.neuralwatt.com",
    defaultModel: "glm-5.3",
    // 2026-07-10 live /v1/models: K2.5 rows were removed and GLM-5.2 short variants added.
    // 260814: the glm-5.3 quartet is speculative; live discovery is authoritative and drops
    // any id Neuralwatt has not published yet.
    // Evidence: devlog/_plan/260710_provider_hardening/003_research_aggregators.md and https://api.neuralwatt.com/v1/models.
    models: [
      "glm-5.3", "glm-5.3-fast", "glm-5.3-short", "glm-5.3-short-fast",
      "glm-5.2", "glm-5.2-fast", "glm-5.2-short", "glm-5.2-short-fast",
      "kimi-k2.6", "kimi-k2.6-fast",
      "kimi-k2.7-code",
      "qwen3.5-397b", "qwen3.5-397b-fast", "qwen3.6-35b", "qwen3.6-35b-fast",
    ],
    // Neuralwatt's /v1/models metadata is authoritative; these static hints are the offline fallback.
    modelReasoningEfforts: {
      "glm-5.3": ZAI_GLM_53_REASONING_EFFORTS,
      "glm-5.3-fast": [],
      "glm-5.3-short": ZAI_GLM_53_REASONING_EFFORTS,
      "glm-5.3-short-fast": [],
      "glm-5.2": ZAI_GLM_52_REASONING_EFFORTS,
      "glm-5.2-fast": [],
      "glm-5.2-short": ZAI_GLM_52_REASONING_EFFORTS,
      "glm-5.2-short-fast": [],
      "kimi-k2.6": [],
      "kimi-k2.6-fast": [],
      "kimi-k2.7-code": [],
      // Qwen3.x uses thinking_budget, NOT graded reasoning_effort; the adapter maps the five
      // Codex picker levels onto budget fractions.
      "qwen3.5-397b": THINKING_BUDGET_EFFORTS,
      "qwen3.5-397b-fast": [],
      "qwen3.6-35b": THINKING_BUDGET_EFFORTS,
      "qwen3.6-35b-fast": [],
    },
    thinkingBudgetModels: THINKING_BUDGET_MODELS,
    noReasoningModels: ["glm-5.3-fast", "glm-5.3-short-fast", "glm-5.2-fast", "glm-5.2-short-fast", "kimi-k2.6-fast", "qwen3.5-397b-fast", "qwen3.6-35b-fast"],
    noVisionModels: ["glm-5.3", "glm-5.3-fast", "glm-5.3-short", "glm-5.3-short-fast", "glm-5.2", "glm-5.2-fast", "glm-5.2-short", "glm-5.2-short-fast", "qwen3.5-397b", "qwen3.5-397b-fast"],
    noTemperatureModels: ["kimi-k2.7-code"],
    noTopPModels: ["kimi-k2.7-code"],
    noPenaltyModels: ["kimi-k2.7-code"],
    autoToolChoiceOnlyModels: ["kimi-k2.7-code"],
    preserveReasoningContentModels: NEURALWATT_REASONING_HISTORY_MODELS,
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    adapter: "openai-chat",
    baseUrl: "https://openrouter.ai/api/v1",
    authKind: "key",
    featured: true,
    dashboardUrl: "https://openrouter.ai/keys",
    jawcodeBundle: "openrouter",
    // stealth/ox-alpha: free stealth-window frontier model (launched 2026-08-20).
    // /api/v1/models reports 1,048,576 context, 131,072 max output, text+image+video
    // input, $0 pricing, mandatory reasoning. Single provider slug: `stealth`.
    models: ["anthropic/claude-sonnet-5", "stealth/ox-alpha", ...OPENROUTER_GPT56_MODELS],
    modelContextWindows: {
      "anthropic/claude-sonnet-5": 1_000_000,
      "stealth/ox-alpha": OX_ALPHA_CONTEXT_WINDOW,
      ...OPENROUTER_GPT56_CONTEXT_WINDOWS,
    },
    modelInputModalities: { "stealth/ox-alpha": ["text", "image"] },
    // OpenRouter documents priority support for OpenAI endpoints, but not Anthropic. Keep the
    // provider unclassified and opt in only the exact OpenAI-backed slugs we ship. These facts
    // belong only to the canonical destination; a same-named custom gateway is unknown to us.
    modelServiceTierCapabilityBaseUrlGuard: isCanonicalOpenRouterTarget,
    modelSupportsServiceTier: {
      "openai/gpt-5.6-sol": true,
      "openai/gpt-5.6-terra": true,
      "openai/gpt-5.6-luna": true,
    },
    // Deliberately no OpenRouter route pin: it bills the endpoint actually used and reports the
    // actual service_tier. B0 confirmation therefore owns downgrade safety. Forcing `only` plus
    // `allow_fallbacks:false` would turn a graceful priority-capacity fallback into a hard failure.
  },
  {
    // Primary sources checked 2026-08-02:
    // - docs.cline.bot/getting-started/clinepass publishes this exact catalog and explicitly
    //   authorizes using the full slugs through Cline's external API.
    // - docs.cline.bot/api/chat-completions and /api/errors define the endpoint, reasoning delta,
    //   and choice-scoped mid-stream error contract.
    // - Cline's official catalog source resolves per-model capabilities through OpenRouter data;
    //   the static context/modality snapshot below was cross-checked against that catalog.
    // - cline.bot/tos identifies Cline Bot Inc. as the operator. Maintenance owner: @lidge-jun.
    id: "cline-pass",
    label: "ClinePass",
    adapter: "openai-chat",
    baseUrl: "https://api.cline.bot/api/v1",
    authKind: "key",
    dashboardUrl: "https://app.cline.bot",
    defaultModel: "cline-pass/kimi-k3",
    models: CLINE_PASS_MODELS,
    modelContextWindows: CLINE_PASS_MODEL_CONTEXT_WINDOWS,
    modelInputModalities: CLINE_PASS_MODEL_INPUT_MODALITIES,
    noVisionModels: CLINE_PASS_TEXT_ONLY_MODELS,
    // Live-probed 2026-08-13 across every static ClinePass model: the gateway accepts and
    // validates low/medium/high/xhigh/max, and rejects an invalid sentinel. Preserve the
    // caller's requested tier and let ClinePass own any backend-specific normalization.
    reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
    reasoningWireFormat: "gateway-object",
    preserveCustomDestination: true,
    note: "ClinePass subscription API. Uses a Cline API key and the full cline-pass/<model> upstream slug; quota is shared across the account's rolling 5-hour, weekly, and monthly limits.",
  },
  // Cline API (usage-billing): OpenAI-compatible Chat Completions. Model IDs follow the
  // OpenRouter-style `provider/model` convention. Live /models discovery is key-gated (401
  // without auth), so the static seed is the cold-start fallback. Evidence: docs.cline.bot/api/*.
  {
    id: "cline",
    label: "Cline",
    adapter: "openai-chat",
    baseUrl: "https://api.cline.bot/api/v1",
    authKind: "key",
    dashboardUrl: "https://app.cline.bot",
    liveModels: true,
    defaultModel: "anthropic/claude-sonnet-4-6",
    models: [
      "anthropic/claude-sonnet-4-6",
      "openai/gpt-4o",
      "google/gemini-2.5-pro",
      "deepseek/deepseek-chat",
      "minimax/minimax-m2.5",
    ],
    preserveCustomDestination: true,
    note: "Cline usage-billing API: one key, 100+ models, OpenRouter-style ids. Promotional free models are IDE/CLI-only per Cline docs; minimax/minimax-m2.5 is the documented API free experimentation model.",
  },
  {
    // OrcaRouter: OpenAI-compatible adaptive router (api.orcarouter.ai). Model ids are
    // vendor-namespaced (`<vendor>/<model>`) and pass through to the upstream as-is.
    // The default pins a tool-capable model; the adaptive `orcarouter/auto` router is also
    // selectable. Live-verified 2026-07-20: /v1/chat/completions accepts the `tools` field
    // and routes to a function-calling-capable upstream.
    id: "orcarouter", label: "OrcaRouter", adapter: "openai-chat", baseUrl: "https://api.orcarouter.ai/v1",
    authKind: "key", dashboardUrl: "https://www.orcarouter.ai/console",
    defaultModel: "openai/gpt-5.5",
    models: [
      "openai/gpt-5.5",
      "anthropic/claude-opus-4.8",
      "google/gemini-3.5-flash",
      "deepseek/deepseek-v4-pro",
      "orcarouter/auto",
    ],
    // Text-only models → the vision sidecar describes images instead.
    noVisionModels: ["deepseek/deepseek-v4-pro"],
    // Reasoning/temperature behavior verified live 2026-07-20 against api.orcarouter.ai:
    // - openai/gpt-5.5 accepts reasoning_effort none|low|medium|high|xhigh but rejects `max` (400),
    //   so advertise up to xhigh and let mapReasoningEffort clamp a `max`/`ultra` request to xhigh.
    // - deepseek/deepseek-v4-pro mirrors the direct-DeepSeek wiring (thinking-effort map +
    //   reasoning_content history replay) so the namespaced selection behaves identically.
    // - temperature is accepted by every seeded model (gpt-5.5, claude-opus-4.8, deepseek-v4-pro all
    //   returned 200), so no noTemperatureModels entry is warranted here.
    modelReasoningEfforts: {
      "openai/gpt-5.5": ["low", "medium", "high", "xhigh"],
      "deepseek/deepseek-v4-pro": deepseekThinkingEffortsFor("deepseek/deepseek-v4-pro"),
    },
    modelReasoningEffortMap: { "deepseek/deepseek-v4-pro": deepseekReasoningMapFor("deepseek/deepseek-v4-pro") },
    preserveReasoningContentModels: ["deepseek/deepseek-v4-pro"],
    note: "OpenAI-compatible adaptive router. Default is a tool-capable model; orcarouter/auto (adaptive routing) is also selectable. Full catalog: https://www.orcarouter.ai/models",
  },
  {
    // BizRouter: Korean enterprise LLM gateway (api.bizrouter.ai). Model ids are
    // vendor-namespaced (`<vendor>/<model>`) and pass through to the upstream as-is.
    // Live-verified 2026-07-24: /v1/chat/completions accepts the `tools` field and
    // streams, and GET /v1/models returns the per-API-key allowed catalog in the
    // OpenAI list shape, so live model discovery narrows to what the key can use.
    id: "bizrouter", label: "BizRouter", adapter: "openai-chat", baseUrl: "https://api.bizrouter.ai/v1",
    authKind: "key", dashboardUrl: "https://bizrouter.ai/settings/keys",
    defaultModel: "openai/gpt-5.6-sol",
    models: ["openai/gpt-5.6-sol", "anthropic/claude-sonnet-5", "google/gemini-3.5-flash"],
    note: "Korean enterprise LLM gateway. Per-key allowed models are discovered live from /v1/models. Full catalog: https://bizrouter.ai/models",
  },
  { id: "groq", label: "Groq", adapter: "openai-chat", baseUrl: "https://api.groq.com/openai/v1", authKind: "key", featured: true, dashboardUrl: "https://console.groq.com/keys" },
  // 2026-07-10 Gemini API refresh: Tier-2 ai.google.dev evidence recorded in
  // devlog/_plan/260710_provider_hardening/001_research_frontier.md.
  {
    id: "google", label: "Google Gemini", adapter: "google", baseUrl: "https://generativelanguage.googleapis.com", authKind: "key", featured: true,
    dashboardUrl: "https://aistudio.google.com/apikey", defaultModel: "gemini-3.5-flash", models: ["gemini-3.6-flash", "gemini-3.5-flash", "gemini-3.5-flash-lite", "gemini-3.1-pro-preview", "gemini-3.7-flash"],
    modelContextWindows: { "gemini-3.6-flash": 1_048_576, "gemini-3.5-flash": 1_000_000, "gemini-3.5-flash-lite": 1_048_576, "gemini-3.7-flash": 1_048_576 },
    modelInputModalities: { "gemini-3.6-flash": ["text", "image"], "gemini-3.5-flash-lite": ["text", "image"], "gemini-3.7-flash": ["text", "image"] },
    modelReasoningEfforts: {
      "gemini-3.6-flash": ["minimal", "low", "medium", "high"],
      "gemini-3.5-flash": ["minimal", "low", "medium", "high"],
      "gemini-3.7-flash": ["minimal", "low", "medium", "high"],
      "gemini-3.1-pro-preview": ["low", "medium", "high"],
    },
    jawcodeBundle: "google", extraMetadataAliases: ["gemini"],
  },
  // 2026-07-10: defaultModel is frozen pending Vertex-specific Tier-2 evidence; Gemini API
  // evidence from ai.google.dev does not establish Vertex publisher availability.
  { id: "google-vertex", label: "Google Vertex AI", adapter: "google", baseUrl: "https://aiplatform.googleapis.com", authKind: "key", dashboardUrl: "https://console.cloud.google.com/vertex-ai", defaultModel: "gemini-3-pro", googleMode: "vertex", jawcodeBundle: "google", extraMetadataAliases: ["gemini-vertex"] },
  { id: "google-antigravity", label: "Google Antigravity", adapter: "google", baseUrl: "https://daily-cloudcode-pa.googleapis.com", authKind: "oauth", allowBaseUrlOverride: true, dashboardUrl: "https://antigravity.google", models: ANTIGRAVITY_MODELS, liveModels: true, defaultModel: "gemini-3.7-flash", modelContextWindows: ANTIGRAVITY_MODEL_CONTEXT_WINDOWS, modelInputModalities: ANTIGRAVITY_MODEL_INPUT_MODALITIES, modelReasoningEfforts: ANTIGRAVITY_MODEL_EFFORTS, googleMode: "cloud-code-assist", jawcodeBundle: "google", extraMetadataAliases: ["antigravity", "gemini-antigravity"] },
  { id: "azure-openai", label: "Azure OpenAI", adapter: "azure-openai", baseUrl: "https://{resource}.openai.azure.com/openai", authKind: "key", featured: true, dashboardUrl: "https://portal.azure.com" },
  { id: "ollama", label: "Ollama (local)", adapter: "openai-chat", baseUrl: "http://localhost:11434/v1", authKind: "local", allowPrivateNetworkByDefault: true, allowBaseUrlOverride: true, featured: true, note: "Local — key usually blank" },
  { id: "vllm", label: "vLLM (local)", adapter: "openai-chat", baseUrl: "http://localhost:8000/v1", authKind: "local", allowPrivateNetworkByDefault: true, allowBaseUrlOverride: true, featured: true, note: "Local — key usually blank" },
  { id: "lm-studio", label: "LM Studio (local)", adapter: "openai-chat", baseUrl: "http://localhost:1234/v1", authKind: "local", allowPrivateNetworkByDefault: true, allowBaseUrlOverride: true, featured: true, note: "Local — no key needed" },
  {
    id: "deepseek",
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    adapter: "openai-chat",
    authKind: "key",
    dashboardUrl: "https://platform.deepseek.com/api_keys",
    // Route DeepSeek's own catalog bundle so routed rebuilds restore the official
    // context window from the vendored model-metadata bundle instead of falling
    // back to the 128k strict-fields default (scripts/model-metadata.source.json,
    // verified 2026-08-08).
    jawcodeBundle: "deepseek",
    // deepseek-chat/deepseek-reasoner were deprecated upstream on 2026-07-24 15:59 UTC;
    // official identifiers are now deepseek-v4-flash / deepseek-v4-pro. They stay in
    // the list only as compatibility aliases so existing saved configs and requests
    // keep validating and routing (they previously mapped to v4-flash; devlog
    // _fin/260710_provider_hardening/002_research_cn.md). The current offerings are
    // the V4 ids — defaultModel and the model-specific wiring above use them.
    // deepseek-v4-flash-vision-exp: experimental vision preview (2026-08-21) —
    // expected to merge into deepseek-v4-flash later; see DEEPSEEK_VISION_PREVIEW_MODEL.
    models: ["deepseek-chat", "deepseek-reasoner", ...DEEPSEEK_THINKING_MODELS, DEEPSEEK_VISION_PREVIEW_MODEL],
    defaultModel: "deepseek-v4-flash",
    // Official DeepSeek Codex setup (codex-deepseek-setup.sh) advertises 1,048,576
    // for both V4 models; the older 1,000,000 figure was a rounded approximation.
    modelContextWindows: { "deepseek-v4-flash": 1_048_576, "deepseek-v4-pro": 1_048_576, [DEEPSEEK_VISION_PREVIEW_MODEL]: 1_048_576 },
    modelInputModalities: { [DEEPSEEK_VISION_PREVIEW_MODEL]: ["text", "image"] },
    // DeepSeek documents both V4 models as native Responses API models adapted for Codex
    // (model table marks Responses API ✓ for flash and pro; the /responses reference lists
    // both ids as accepted `model` values — verified 2026-08-13 with the V4 Pro GA,
    // version label DeepSeek-V4-Pro-0813).
    modelWireDefaults: {
      // Codex speaks Responses natively and DeepSeek ships a Codex-compatible
      // apply_patch tool on that wire, so a Responses inbound goes straight out with
      // no translation. Claude Code and OpenAI-compatible clients keep the
      // provider-wide Chat wire: DeepSeek serves Chat Completions natively too, so
      // translating them into Responses would add a hop onto our newest upstream path
      // for no gain.
      "deepseek-v4-flash": { wire: "openai-responses", inbound: ["responses"] },
      "deepseek-v4-pro": { wire: "openai-responses", inbound: ["responses"] },
    },
    // The #875-era bounded-JSON force (`modelResponsesUpstreamStreaming`) is retired
    // for this entry: the official guide documents a `response.completed` /
    // `response.incomplete` / `response.failed` terminal with NO `data: [DONE]`
    // sentinel, and live probes (2026-08-07, including the tool-result replay shape
    // that originally stalled) close on the terminal. The relay's terminal boundary
    // (src/server/relay.ts) already cuts the stream at that event and synthesizes
    // `[DONE]`, so forcing stream:false only delayed every byte until generation
    // finished (28-46 s of silence on long turns). The registry knob itself remains
    // for providers that need it — re-adding one line here restores the old policy.
    // Evidence: https://api-docs.deepseek.com/guides/responses_api/ +
    // devlog/_fin/260807_deepseek_responses_streaming/000_plan.md.
    // Current official streams normally carry a real terminal; retain a narrow grace
    // repair for the historical shape that closes after a complete graph without one.
    modelResponsesTerminalRepair: { "deepseek-v4-flash": { graceMs: 5_000 }, "deepseek-v4-pro": { graceMs: 5_000 } },
    // DeepSeek's Responses route emits bare UUID item ids, which leave Codex
    // clients stuck on an uncommitted turn (#938). Client-facing only — raw
    // continuation snapshots keep the upstream ids.
    responsesItemIdRepair: { repairInvalidIds: true, repairMissingTerminalIds: true },
    // DeepSeek's Responses route is `POST /responses` with no `/v1` segment. Without
    // this the passthrough adapter falls back to its legacy `/v1/responses`
    // construction and the wire above can never route.
    // Evidence: https://api-docs.deepseek.com/api/create-response/
    responsesPath: "/responses",
    // DeepSeek's Responses reference does not list `service_tier`; unsupported
    // parameters are documented as silently ignored, but the fail-closed policy
    // strips the field rather than forwarding a knob the upstream never asked for.
    supportsServiceTier: false,
    // DeepSeek's Responses compatibility guide accepts plaintext reasoning items and
    // merges them into the adjacent assistant message, so replayed reasoning must
    // not be blanked the way the ChatGPT backend requires. (Whether the Responses
    // route REQUIRES replay on tool-call continuations is an inference from the
    // Chat Thinking-Mode docs, not a confirmed Responses contract.)
    preserveResponsesReasoningContent: true,
    // "The API is stateless: responses and conversations are not stored on the
    // server." https://api-docs.deepseek.com/api/create-response/
    statelessResponses: true,
    // DeepSeek rejects a valid Codex continuation when hook-provided developer
    // context splits a call from its result (#1292); parallel calls remain one
    // reasoning-bearing assistant batch rather than being split per pair (#1477).
    requiresAdjacentResponsesToolResults: true,
    /* [Decision Log]
    - 목적: DeepSeek V4 thinking mode multi-turn/tool-call requests must replay prior assistant reasoning_content.
    - 대안 분석: Globally preserve reasoning_content for all OpenAI-compatible models; preserve it for legacy deepseek-reasoner too; mark only V4 thinking models in registry metadata.
    - 선택 근거: DeepSeek V4 thinking mode requires history replay, while older DeepSeek reasoner has different compatibility rules. A model-scoped registry flag fixes built-in and stale saved configs without broad provider regressions.
    */
    modelReasoningEfforts: Object.fromEntries(DEEPSEEK_THINKING_MODELS.map(id => [id, deepseekThinkingEffortsFor(id)])),
    modelReasoningEffortMap: Object.fromEntries(DEEPSEEK_THINKING_MODELS.map(id => [id, deepseekReasoningMapFor(id)])),
    modelSupportsReasoningSummaries: Object.fromEntries(DEEPSEEK_THINKING_MODELS.map(id => [id, true])),
    preserveReasoningContentModels: DEEPSEEK_THINKING_MODELS,
    // Issue #88: every DeepSeek API model is text-only input (no image support upstream) — the
    // vision sidecar describes attached images for them, and the catalog advertises image input
    // on their behalf (same treatment as opencode-go's DeepSeek V4 entries above).
    noVisionModels: ["deepseek-chat", "deepseek-reasoner", ...DEEPSEEK_THINKING_MODELS],
  },
  // llama-3.3-70b was deprecated by Cerebras on 2026-02-16. Evidence: devlog/_plan/260710_provider_hardening/003_research_aggregators.md.
  { id: "cerebras", label: "Cerebras", baseUrl: "https://api.cerebras.ai/v1", adapter: "openai-chat", authKind: "key", dashboardUrl: "https://cloud.cerebras.ai/platform/apikeys", defaultModel: "gpt-oss-120b" },
  {
    // Primary sources checked 2026-08-08:
    // - https://chutes.ai/pricing documents the shared llm.chutes.ai/v1 OpenAI-compatible
    //   gateway, Bearer API keys, and chat completions. Its public
    //   https://llm.chutes.ai/v1/models response supplies supported_features for filtering.
    // - https://chutes.ai/terms identifies Chutes Global Corp as the platform operator, applies
    //   to API consumers, and directs production/high-volume automated inference to PAYGO.
    //   Maintainer: @olddonkey; no affiliation with Chutes.
    id: "chutes",
    label: "Chutes",
    baseUrl: "https://llm.chutes.ai/v1",
    adapter: "openai-chat",
    authKind: "key",
    dashboardUrl: "https://chutes.ai/auth/start",
    liveModels: true,
    preserveCustomDestination: true,
    // The public model catalog cannot prove that a supplied Bearer key is valid.
    apiKeyValidation: "unknown",
    // Chutes documents tool calling, but not a provider-wide parallel tool-call contract.
    parallelToolCalls: false,
    // The live catalog reports reasoning support, but not a stable effort ladder.
    reasoningEfforts: [],
    modelDiscovery: {
      path: "models",
      maxResponseBytes: 256 * 1024,
      maxModels: 128,
      filter: {
        // The shared LLM catalog also contains rows without native tool support. Codex needs a
        // complete agent loop, so admit only rows whose live metadata advertises tools.
        allOf: [{ path: ["supported_features"], containsAny: ["tools"] }],
      },
    },
    note: "Shared OpenAI-compatible LLM gateway only; live discovery exposes tool-capable rows. User-deployed custom Chute endpoints and non-LLM APIs require a custom provider.",
  },
  {
    id: "deepinfra",
    label: "DeepInfra",
    baseUrl: "https://api.deepinfra.com/v1/openai",
    adapter: "openai-chat",
    authKind: "key",
    dashboardUrl: "https://deepinfra.com/dash/api_keys",
    liveModels: true,
    preserveCustomDestination: true,
    modelDiscovery: {
      // DeepInfra documents the OpenAI model catalog outside the chat-compatible `/v1/openai`
      // namespace, so keep this destination registry-owned instead of deriving it from baseUrl.
      url: "https://api.deepinfra.com/v1/models",
      maxResponseBytes: 512 * 1024,
      maxModels: 512,
      filter: {
        allOf: [{ path: ["metadata", "tags"], containsAny: ["chat"] }],
      },
    },
    note: "OpenAI-compatible chat models only; live discovery excludes non-chat rows from DeepInfra's mixed model catalog.",
  },
  {
    id: "hyperbolic",
    label: "Hyperbolic",
    baseUrl: "https://api.hyperbolic.xyz/v1",
    adapter: "openai-chat",
    authKind: "key",
    dashboardUrl: "https://app.hyperbolic.ai",
    liveModels: true,
    preserveCustomDestination: true,
    modelDiscovery: {
      path: "models",
      maxResponseBytes: 256 * 1024,
      maxModels: 256,
    },
    note: "Serverless text and vision-language chat models only; Hyperbolic's separate image, audio, and GPU endpoints are out of scope.",
  },
  {
    // Primary sources checked 2026-08-03:
    // - docs.nscale.com documents the production OpenAI-compatible endpoint, bearer service
    //   tokens, /v1/models, and a tool-calling request using this exact Llama model id.
    // - nscale.com/policies/terms-conditions identifies Nscale AS as the service operator and
    //   covers customers using its public-cloud inference offering. Maintainer: @olddonkey;
    //   no affiliation with Nscale.
    id: "nscale",
    label: "Nscale Serverless Inference",
    baseUrl: "https://inference.api.nscale.com/v1",
    adapter: "openai-chat",
    authKind: "key",
    dashboardUrl: "https://console.nscale.com",
    defaultModel: "meta-llama/Llama-3.1-8B-Instruct",
    models: ["meta-llama/Llama-3.1-8B-Instruct"],
    liveModels: true,
    preserveCustomDestination: true,
    // Nscale documents tools but not parallel tool calls. Keep requests serialized.
    parallelToolCalls: false,
    // The API schema accepts reasoning_effort, but does not publish per-model tiers.
    reasoningEfforts: [],
    modelDiscovery: {
      path: "models",
      maxResponseBytes: 256 * 1024,
      maxModels: 256,
      filter: {
        // Nscale's catalog mixes chat, image, and embedding rows without a modality field.
        // Admit only the exact model used in its official tool-calling API example.
        allOf: [{ path: ["id"], equalsAny: ["meta-llama/Llama-3.1-8B-Instruct"] }],
      },
    },
    note: "Serverless OpenAI-compatible inference. Live discovery admits only the tool-capable model established by Nscale's official API example; other mixed-catalog rows remain hidden pending equivalent evidence.",
  },
  {
    // Primary sources checked 2026-08-03:
    // - docs.vultr.com documents the fixed OpenAI-compatible base URL, per-subscription bearer
    //   key, /v1/models, and states that tool calling is currently limited to kimi-k2-instruct.
    // - Vultr's official properties identify VULTR as a The Constant Company, LLC trademark and
    //   document customer API integrations. Maintainer: @olddonkey; no affiliation with Vultr.
    id: "vultr",
    label: "Vultr Serverless Inference",
    baseUrl: "https://api.vultrinference.com/v1",
    adapter: "openai-chat",
    authKind: "key",
    dashboardUrl: "https://my.vultr.com",
    defaultModel: "kimi-k2-instruct",
    models: ["kimi-k2-instruct"],
    liveModels: true,
    preserveCustomDestination: true,
    parallelToolCalls: false,
    reasoningEfforts: [],
    modelDiscovery: {
      path: "models",
      maxResponseBytes: 256 * 1024,
      maxModels: 256,
      filter: {
        // Vultr explicitly limits tool calling to this model. A coding agent must not select
        // another chat model that cannot complete its tool loop.
        allOf: [{ path: ["id"], equalsAny: ["kimi-k2-instruct"] }],
      },
    },
    note: "Serverless Inference subscription API. Live discovery exposes only kimi-k2-instruct because Vultr documents it as the sole tool-calling model.",
  },
  {
    id: "baseten",
    label: "Baseten Model APIs",
    baseUrl: "https://inference.baseten.co/v1",
    adapter: "openai-chat",
    authKind: "key",
    dashboardUrl: "https://app.baseten.co/settings/api_keys",
    liveModels: true,
    preserveCustomDestination: true,
    // Baseten's Chat Completions contract documents parallel_tool_calls as default-on.
    parallelToolCalls: true,
    // Baseten says models outside its reasoning table do not support reasoning. Keep
    // unknown/new live slugs conservative until an official-docs registry refresh proves it.
    reasoningEfforts: [],
    modelReasoningEfforts: BASETEN_MODEL_REASONING_EFFORTS,
    modelReasoningEffortMap: BASETEN_MODEL_REASONING_EFFORT_MAP,
    modelDefaultReasoningEfforts: BASETEN_MODEL_DEFAULT_REASONING_EFFORTS,
    modelInputModalities: BASETEN_MODEL_INPUT_MODALITIES,
    modelDiscovery: {
      path: "models",
      maxResponseBytes: 1_048_576,
      maxModels: 256,
    },
    note: "Shared Model APIs only (personal API key, or team key with Call Model APIs access); dedicated Truss predict endpoints are outside this preset.",
  },
  {
    id: "commandcode",
    label: "Command Code - API",
    adapter: "openai-chat",
    baseUrl: "https://api.commandcode.ai/provider/v1",
    authKind: "key",
    dashboardUrl: "https://commandcode.ai/studio/",
    liveModels: true,
    preserveCustomDestination: true,
    defaultModel: "deepseek/deepseek-v4-flash",
    // The default is also the cold-start seed: live discovery failure must not empty the catalog
    // for a freshly configured provider with no stale cache (issue #308 pattern).
    models: ["deepseek/deepseek-v4-flash"],
    // The public model catalog is unauthenticated, so a Bearer probe cannot prove key validity.
    apiKeyValidation: "unknown",
    // The public catalog reports ids/context windows only; no trustworthy reasoning contract.
    reasoningEfforts: [],
    // Official Command Code model-profile reasoning facts (shared with the OAuth
    // `command-code` entry). Without them the API-key preset never advertises a
    // reasoning picker, and the router's known-ids decode source misses the native
    // slash ids — so a Codex-facing slug like `commandcode/deepseek-deepseek-v4-pro`
    // is sent upstream verbatim and rejected with `unsupported_model`.
    modelReasoningEfforts: COMMAND_CODE_MODEL_REASONING_EFFORTS,
    // Ox Alpha (stealth preview, Command Code changelog v1.31.0) ships with a
    // 1.05M-token multimodal context; the DeepSeek vision preview id is
    // preemptive for when the catalog serves it (merges into v4-flash later).
    modelContextWindows: {
      "stealth/ox-alpha": OX_ALPHA_CONTEXT_WINDOW,
      [`deepseek/${DEEPSEEK_VISION_PREVIEW_MODEL}`]: 1_048_576,
    },
    modelInputModalities: {
      "stealth/ox-alpha": ["text", "image"],
      [`deepseek/${DEEPSEEK_VISION_PREVIEW_MODEL}`]: ["text", "image"],
    },
    modelDiscovery: {
      path: "models",
      maxResponseBytes: 256 * 1024,
      maxModels: 256,
    },
    // Verified 2026-08-03: public /provider/v1/models returns 51 rows; /chat/completions returns
    // 401 UNAUTHORIZED without a Bearer key. Primary source: https://commandcode.ai/docs/provider.
    note: "Command Code Provider API (OpenAI-compatible); API access requires the Provider plan. Use `ocx login command-code` for OAuth account login (imports an existing local Command Code CLI credential when present). Docs: https://commandcode.ai/docs/provider.",
  },
  {
    id: "sambanova",
    label: "SambaNova Cloud",
    baseUrl: "https://api.sambanova.ai/v1",
    adapter: "openai-chat",
    authKind: "key",
    dashboardUrl: "https://cloud.sambanova.ai/apis",
    liveModels: true,
    preserveCustomDestination: true,
    apiKeyValidation: "unknown",
    // SambaNova documents this request field but does not yet support parallel function calls.
    parallelToolCalls: false,
    // The public catalog does not report a trustworthy per-model reasoning contract.
    reasoningEfforts: [],
    modelDiscovery: {
      path: "models",
      maxResponseBytes: 128 * 1024,
      maxModels: 128,
    },
    note: "SambaNova Cloud text-generation models only; private SambaStudio deployment endpoints are outside this preset.",
  },
  {
    id: "nebius",
    label: "Nebius Token Factory",
    baseUrl: "https://api.tokenfactory.nebius.com/v1",
    adapter: "openai-chat",
    authKind: "key",
    dashboardUrl: "https://tokenfactory.nebius.com",
    liveModels: true,
    preserveCustomDestination: true,
    // The public tools guide documents single function selection, not parallel tool calls.
    parallelToolCalls: false,
    // Missing reasoning metadata must not promote a model to Codex's full fallback ladder.
    reasoningEfforts: [],
    modelDiscovery: {
      path: "models",
      query: { verbose: "true" },
      maxResponseBytes: 512 * 1024,
      maxModels: 512,
      filter: {
        // Keep rows whose reported architecture output includes text (for example,
        // text->text or text+image->text); embedding and image-generation rows are excluded.
        allOf: [{ path: ["architecture", "modality"], containsAny: ["->text"] }],
      },
    },
    note: "Shared Token Factory text-output inference only; live discovery excludes embedding and image-generation rows.",
  },
  {
    id: "digitalocean",
    label: "DigitalOcean Serverless Inference",
    baseUrl: "https://inference.do-ai.run/v1",
    adapter: "openai-chat",
    authKind: "key",
    dashboardUrl: "https://cloud.digitalocean.com/model-studio/manage-keys",
    liveModels: true,
    preserveCustomDestination: true,
    // The Chat Completions contract documents function calls but not universal parallel support.
    parallelToolCalls: false,
    // Unknown catalog rows must not inherit Codex's full fallback reasoning ladder.
    reasoningEfforts: [],
    modelDiscovery: {
      path: "models",
      maxResponseBytes: 256 * 1024,
      maxModels: 256,
      filter: {
        allOf: [{ path: ["id"], equalsAny: DIGITALOCEAN_CHAT_COMPLETION_MODELS }],
      },
    },
    note: "Shared Serverless Inference Chat Completions only; agent-specific, dedicated, Responses-only, embedding, and media-generation models are outside this preset.",
  },
  {
    id: "scaleway",
    label: "Scaleway Generative APIs",
    baseUrl: "https://api.scaleway.ai/v1",
    adapter: "openai-chat",
    authKind: "key",
    dashboardUrl: "https://console.scaleway.com/generative-api",
    liveModels: true,
    freeTier: true,
    preserveCustomDestination: true,
    // Parallel support varies by model; avoid advertising it as a provider-wide capability.
    parallelToolCalls: false,
    // The generic `/models` rows carry no trustworthy reasoning metadata.
    reasoningEfforts: [],
    modelInputModalities: SCALEWAY_MODEL_INPUT_MODALITIES,
    modelDiscovery: {
      path: "models",
      maxResponseBytes: 128 * 1024,
      maxModels: 128,
      filter: {
        allOf: [{ path: ["id"], equalsAny: SCALEWAY_SERVERLESS_CHAT_MODELS }],
      },
    },
    note: "Shared Generative APIs Serverless Chat Completions only; project-qualified and dedicated deployment hosts require a custom provider.",
  },
  {
    // Primary sources checked 2026-08-08:
    // - https://featherless.ai/docs/api-overview-and-common-options documents the fixed
    //   OpenAI-compatible base URL, Bearer keys, and Chat Completions.
    // - https://featherless.ai/docs/api-reference-models documents authenticated plan filtering,
    //   chat capability filtering, popularity sorting, pagination, and per-row tool metadata.
    // - https://featherless.ai/legal/terms-of-service identifies Featherless as a Delaware LLC,
    //   covers developers building on its APIs, and reserves arbitrary applications for Scale
    //   plans. Maintainer: @olddonkey; no affiliation with Featherless.
    id: "featherless",
    label: "Featherless AI",
    baseUrl: "https://api.featherless.ai/v1",
    adapter: "openai-chat",
    authKind: "key",
    dashboardUrl: "https://featherless.ai/account/api-keys",
    liveModels: true,
    preserveCustomDestination: true,
    // /v1/models is documented as callable authenticated or unauthenticated, so a 2xx catalog
    // response cannot prove that the supplied Bearer key is valid.
    apiKeyValidation: "unknown",
    // Featherless documents tool calling, but not a provider-wide parallel tool-call contract.
    parallelToolCalls: false,
    // Reasoning controls use model-specific chat_template_kwargs, not OpenAI reasoning_effort.
    reasoningEfforts: [],
    modelDiscovery: {
      path: "models",
      query: {
        available_on_current_plan: "true",
        capabilities: "chat",
        page: "1",
        per_page: "100",
        sort: "-popularity",
      },
      maxResponseBytes: 128 * 1024,
      maxModels: 100,
      filter: {
        // Treat server-side filters as a size optimization, not an authority boundary. A row must
        // independently prove plan availability, no separate Hugging Face gate, and tool support.
        allOf: [
          { path: ["available_on_current_plan"], equalsAny: [true] },
          { path: ["is_gated"], equalsAny: [false] },
          { path: ["features", "tool_use"], equalsAny: [true] },
        ],
      },
    },
    note: "Authenticated first page of popular chat models only; live discovery admits at most 100 plan-available, ungated rows whose metadata explicitly reports tool use.",
  },
  {
    // Primary sources checked 2026-08-08:
    // - https://novita.ai/docs/api-reference/model-apis-llm-create-chat-completion and
    //   https://novita.ai/docs/api-reference/model-apis-llm-list-models document the fixed
    //   OpenAI-compatible Chat Completions and model-list endpoints.
    // - https://novita.ai/docs/api-reference/basic-authentication documents Bearer API keys.
    // - https://novita.ai/legal/terms-of-service (updated 2026-08-05) expressly covers AI
    //   inference APIs, third-party Model Providers, and customer Input/Output processing.
    // - https://huggingface.co/docs/inference-providers/main/providers/novita lists Novita as an
    //   Inference Providers partner for chat/VLM traffic, independently supporting routing use.
    // - https://tsdr.uspto.gov/statusview/sn99255805 is the official use-in-commerce record
    //   connecting the NOVITA AI mark to Hivemind Labs, Inc., a Delaware corporation. The mark
    //   application is now abandoned; it is cited only as the public operator-identity record.
    // Maintainer: @olddonkey; no affiliation with Novita AI or Hivemind Labs, Inc.
    id: "novita",
    label: "Novita AI",
    baseUrl: "https://api.novita.ai/openai/v1",
    adapter: "openai-chat",
    authKind: "key",
    dashboardUrl: "https://novita.ai/settings/key-management",
    liveModels: true,
    preserveCustomDestination: true,
    // The live catalog is public even though the reference shows an Authorization header, so a
    // successful model fetch cannot prove that a supplied key is valid.
    apiKeyValidation: "unknown",
    // The request reference documents tools but not a provider-wide parallel-tool contract.
    parallelToolCalls: false,
    // Novita exposes model-specific thinking flags, not an OpenAI reasoning_effort contract.
    reasoningEfforts: [],
    modelDiscovery: {
      path: "models",
      maxResponseBytes: 512 * 1024,
      maxModels: 256,
      filter: {
        // Require both Novita's chat classification and the exact configured wire endpoint.
        allOf: [
          { path: ["model_type"], equalsAny: ["chat"] },
          { path: ["endpoints"], containsAny: ["chat/completions"] },
        ],
      },
    },
    note: "Public live catalog filtered to rows that explicitly report chat type and Chat Completions support; key validity remains unknown until an authenticated inference request.",
  },
  // FREEZE 2026-07-10: exact serverless ids remain auth-gated/unverified. Evidence: devlog/_plan/260710_provider_hardening/003_research_aggregators.md.
  { id: "together", label: "Together", baseUrl: "https://api.together.xyz/v1", adapter: "openai-chat", authKind: "key", dashboardUrl: "https://api.together.xyz/settings/api-keys" },
  { id: "fireworks", label: "Fireworks", baseUrl: "https://api.fireworks.ai/inference/v1", adapter: "openai-chat", authKind: "key", dashboardUrl: "https://fireworks.ai/account/api-keys" },
  {
    id: "firepass", label: "Fire Pass (Fireworks Kimi)", baseUrl: "https://api.fireworks.ai/inference/v1", adapter: "openai-chat", authKind: "key",
    dashboardUrl: "https://fireworks.ai/account/api-keys",
    note: "Model data frozen pending Tier-2 entitlement proof",
  },
  {
    id: "moonshot", label: "Moonshot (Kimi API)", baseUrl: MOONSHOT_INTL_BASE_URL, adapter: "openai-chat", authKind: "key",
    allowBaseUrlOverride: true,
    baseUrlChoices: MOONSHOT_BASE_URL_CHOICES,
    dashboardUrl: "https://platform.moonshot.ai/console/api-keys", defaultModel: "kimi-k2.7-code", jawcodeBundle: "moonshot",
    models: KIMI_API_MODELS,
    modelContextWindows: KIMI_API_MODEL_CONTEXT_WINDOWS,
    modelInputModalities: KIMI_API_MODEL_INPUT_MODALITIES,
    noReasoningModels: KIMI_API_NO_REASONING_MODELS,
    modelReasoningEfforts: KIMI_API_REASONING_EFFORTS,
    noTemperatureModels: KIMI_API_MODELS,
    noTopPModels: KIMI_API_MODELS,
    noPenaltyModels: KIMI_API_MODELS,
    autoToolChoiceOnlyModels: ["kimi-k2.7-code", "kimi-k2.7-code-highspeed"],
    preserveReasoningContentModels: KIMI_API_MODELS,
    note: "International default (api.moonshot.ai). China accounts: choose China (.cn) or Custom for api.moonshot.cn.",
  },
  { id: "huggingface", label: "Hugging Face", baseUrl: "https://router.huggingface.co/v1", adapter: "openai-chat", authKind: "key", dashboardUrl: "https://huggingface.co/settings/tokens" },
  // 260715 NIM hardening (issue #126, devlog/_plan/260715_issue126_nim_kimi):
  // - NIM kimi rejects `parallel_tool_calls: true` with 400 "This model only supports single
  //   tool-calls at once!" (openclaw#37048). NVIDIA's own function-calling docs default the
  //   Boolean to false, so provider-wide `false` is the documented-safe wire value.
  // - `reasoning_effort` is not portable on NIM (models use chat_template_kwargs); the kimi
  //   family is live-discovered with no capability metadata, so Codex would otherwise send
  //   reasoning_effort=medium. Exact-id lists per modelInList semantics; gpt-oss on NIM keeps
  //   its working reasoning_effort. Future kimi ids must be appended individually.
  {
    id: "nvidia", label: "NVIDIA NIM", baseUrl: "https://integrate.api.nvidia.com/v1", adapter: "openai-chat", authKind: "key", dashboardUrl: "https://build.nvidia.com",
    // Free pricing, but an API key is still required (free key from build.nvidia.com).
    freeTier: true,
    parallelToolCalls: false,
    // 260804 issue #956: NIM exposes no input modalities, so vision capability is
    // classified here. Both lists are verified per-model; unlisted ids stay unclassified
    // by design (see the comment on NVIDIA_NIM_VISION_MODELS).
    noVisionModels: NVIDIA_NIM_NO_VISION_MODELS,
    modelInputModalities: NVIDIA_NIM_VISION_INPUT_MODALITIES,
    noReasoningModels: NVIDIA_NIM_KIMI_MODELS,
    modelReasoningEfforts: Object.fromEntries(NVIDIA_NIM_KIMI_MODELS.map(id => [id, []])),
    preserveReasoningContentModels: NVIDIA_NIM_KIMI_THINKING_MODELS,
    note: "Free tier on NVIDIA NIM — API key still required (get a free key at build.nvidia.com).",
  },
  { id: "venice", label: "Venice", baseUrl: "https://api.venice.ai/api/v1", adapter: "openai-chat", authKind: "key", dashboardUrl: "https://venice.ai/settings/api" },
  // 260710 GLM-5.2 context and path-specific ids: Tier-2 evidence in
  // devlog/_plan/260710_provider_hardening/002_research_cn.md.
  // 260814: glm-5.3 / glm-5.3[1m] added per docs.z.ai/devpack/latest-model, which lists them as
  // Coding Plan ids on this same endpoint.
  // 260815: docs.z.ai/guides/llm/glm-5.3 now publishes the capability table (thinking, streaming,
  // function calling, caching, structured output) and a 128K output budget, recorded here as the
  // exact 131_072 every other source in this repo uses for that model. Coding Plan pricing stays
  // unpublished, so no cost entry is asserted.
  {
    id: "zai", label: "Z.AI — GLM Coding Plan", baseUrl: "https://api.z.ai/api/coding/paas/v4", adapter: "openai-chat", authKind: "key",
    dashboardUrl: "https://z.ai/manage-apikey/apikey-list", defaultModel: "glm-5.3",
    note: "GLM-5.3 coding subscription",
    models: ["glm-5.3", "glm-5.3[1m]", "glm-5.2", "glm-5.2[1m]", "glm-5.1", "glm-5", "glm-4.6"],
    modelContextWindows: { "glm-5.3": 1_000_000, "glm-5.3[1m]": 1_000_000, "glm-5.2": 1_000_000, "glm-5.2[1m]": 1_000_000 },
    // Z.AI's OpenAI path returns 400 code 1211 for bracketed model ids.
    modelSuffixBracketStrip: true,
    noVisionModels: ZAI_GLM_5X_MODELS,
    modelReasoningEfforts: ZAI_GLM_5X_REASONING_EFFORTS,
    modelDefaultReasoningEfforts: Object.fromEntries(ZAI_GLM_53_MODELS.map(id => [id, "max"])),
    modelMaxOutputTokens: Object.fromEntries(ZAI_GLM_53_MODELS.map(id => [id, 131_072])),
    modelSupportsReasoningSummaries: Object.fromEntries(ZAI_GLM_5X_MODELS.map(id => [id, true])),
    preserveReasoningContentModels: ZAI_GLM_5X_MODELS,
  },
  // Zhipu's domestic BigModel platform: OpenAI-compatible pay-as-you-go on open.bigmodel.cn — a
  // different host and billing product from the `zai` coding-plan subscription above.
  // The id is deliberately NOT `glm` or `glm-cn`: both are already bound in FREE_PROVIDER_DIRECTORY
  // (to api.z.ai and to the BigModel *coding* path), and routedProviderConfig() canonicalizes a
  // saved provider onto the registry baseUrl — reusing either id would silently retarget an
  // existing config's endpoint and send its API key to another host.
  // Evidence: docs.bigmodel.cn/api-reference (OpenAI-compatible chat completions),
  // docs.bigmodel.cn/cn/guide/models/text/glm-4.6 (thinking: {type: enabled|disabled}).
  // Originally proposed in #536 by @Lucinegogo.
  {
    id: "zhipu-bigmodel",
    label: "Zhipu AI — BigModel",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    adapter: "openai-chat",
    authKind: "key",
    dashboardUrl: "https://bigmodel.cn/console/usercenter/apikeys",
    defaultModel: "glm-4.6",
    models: ZHIPU_BIGMODEL_MODELS,
    // The GLM families here are the same ones the `zai` metadata bundle already describes, so the
    // bundle owns context windows and modalities for the whole list instead of a hand-copied table.
    jawcodeBundle: "zai",
    // Declared explicitly for the default model so its window survives a bundle-lookup miss:
    // without it, catalog normalization falls back to a generic 128k and compacts ~76,800 early.
    modelContextWindows: { "glm-4.6": 204_800 },
    modelInputModalities: ZHIPU_BIGMODEL_INPUT_MODALITIES,
    // GLM exposes a binary thinking knob, not an effort ladder: the adapter emits
    // `thinking: {type}` for these ids and would otherwise send a rejected reasoning_effort.
    thinkingToggleModels: ZHIPU_BIGMODEL_THINKING_TOGGLE_MODELS,
    modelReasoningEfforts: Object.fromEntries(
      ZHIPU_BIGMODEL_THINKING_TOGGLE_MODELS.map(id => [id, THINKING_TOGGLE_EFFORTS]),
    ),
    modelReasoningEffortMap: Object.fromEntries(
      ZHIPU_BIGMODEL_THINKING_TOGGLE_MODELS.map(id => [id, THINKING_TOGGLE_MAP]),
    ),
    modelSupportsReasoningSummaries: Object.fromEntries(
      ZHIPU_BIGMODEL_THINKING_TOGGLE_MODELS.map(id => [id, true]),
    ),
    preserveReasoningContentModels: ZHIPU_BIGMODEL_THINKING_TOGGLE_MODELS,
    // GLM thinking is a binary toggle (low maps to disabled), so a legitimate
    // tool round can carry no reasoning at all; never fabricate a placeholder
    // for it, only replay real recorded text (P2 on #1205).
    requiresReasoningPlaceholderModels: [],
    // No liveModels: GET /api/paas/v4/models has not been observed to answer on this host, and a
    // false live claim yields an empty picker at runtime. Flip it on once someone verifies it.
    note: "Domestic BigModel pay-as-you-go endpoint (open.bigmodel.cn)",
  },
  // BigModel's Coding Plan is a SEPARATE endpoint from the pay-as-you-go row above, and that is
  // the whole reason this one exists. #1100 was reported against
  // `https://open.bigmodel.cn/api/coding/paas/v4`; the row above covers only `/api/paas/v4`, so
  // destination enrichment matched nothing, `modelSupportsReasoningSummaries` stayed unset, and
  // Codex kept dropping the inbound reasoning object — effort displayed as `-`.
  //
  // A prefix or fuzzy endpoint match would have been the shortcut. It is also how a config
  // pointed at one vendor route silently inherits another route's metadata, so endpoints stay
  // exact and each one gets its own row.
  //
  // The id is NOT `glm-cn`, which the free-provider directory already binds to this same coding
  // path: registering it here would let routedProviderConfig() canonicalize a saved `glm-cn`
  // config onto this baseUrl. Same reasoning as `zhipu-bigmodel` above.
  //
  // Models follow Z.AI's coding-plan list rather than the pay-as-you-go one. This endpoint is
  // the subscription product, and the reporter's `glm-5.2` is only on that side.
  {
    id: "zhipu-bigmodel-coding",
    label: "Zhipu AI — BigModel Coding Plan",
    baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
    adapter: "openai-chat",
    authKind: "key",
    dashboardUrl: "https://bigmodel.cn/console/usercenter/apikeys",
    defaultModel: "glm-5.3",
    models: ["glm-5.3", "glm-5.3[1m]", "glm-5.2", "glm-5.2[1m]", "glm-5.1", "glm-5", "glm-4.6"],
    jawcodeBundle: "zai",
    modelContextWindows: { "glm-5.3": 1_000_000, "glm-5.3[1m]": 1_000_000, "glm-5.2": 1_000_000, "glm-5.2[1m]": 1_000_000 },
    modelSuffixBracketStrip: true,
    noVisionModels: ZAI_GLM_5X_MODELS,
    modelReasoningEfforts: ZAI_GLM_5X_REASONING_EFFORTS,
    modelSupportsReasoningSummaries: Object.fromEntries(ZAI_GLM_5X_MODELS.map(id => [id, true])),
    preserveReasoningContentModels: ZAI_GLM_5X_MODELS,
    // No liveModels: the same reasoning as the pay-as-you-go row — an unverified live claim
    // yields an empty picker at runtime.
    note: "Domestic BigModel Coding Plan endpoint (open.bigmodel.cn)",
  },
  { id: "nanogpt", label: "NanoGPT", baseUrl: "https://nano-gpt.com/api/v1", adapter: "openai-chat", authKind: "key", dashboardUrl: "https://nano-gpt.com/api" },
  { id: "synthetic", label: "Synthetic", baseUrl: "https://api.synthetic.new/openai/v1", adapter: "openai-chat", authKind: "key", dashboardUrl: "https://synthetic.new" },
  // SiliconFlow publishes an OpenAI-compatible chat endpoint and a dynamic model catalog. Do not
  // freeze reasoning controls here: enable_thinking/thinking_budget support and limits vary by
  // model, so live metadata or an explicit user override must own those capabilities.
  // Evidence: https://docs.siliconflow.cn/en/api-reference/chat-completions/chat-completions
  {
    id: "siliconflow",
    label: "SiliconFlow",
    baseUrl: "https://api.siliconflow.cn/v1",
    adapter: "openai-chat",
    authKind: "key",
    dashboardUrl: "https://cloud.siliconflow.cn/account/ak",
    liveModels: true,
    note: "OpenAI-compatible live model catalog; reasoning controls vary by model.",
  },
  // Qwen Cloud: token plan is the preset default; GUI offers pay-as-you-go + custom via baseUrlChoices.
  // Formerly `qwen-portal` / portal.qwen.ai — that host is outdated.
  {
    id: "qwen-cloud",
    label: "Qwen Cloud",
    baseUrl: QWEN_CLOUD_TOKEN_PLAN_BASE_URL,
    adapter: "openai-chat",
    authKind: "key",
    allowBaseUrlOverride: true,
    baseUrlChoices: QWEN_CLOUD_BASE_URL_CHOICES,
    dashboardUrl: "https://docs.qwencloud.com",
    note: "Pick token plan, pay as you go, or a custom compatible-mode base URL",
  },
  {
    id: "tencent-coding-plan",
    label: "Tencent Cloud Coding Plan",
    baseUrl: "https://api.lkeap.cloud.tencent.com/coding/v3",
    adapter: "openai-chat",
    authKind: "key",
    dashboardUrl: "https://console.cloud.tencent.com/tokenhub/codingplan",
    defaultModel: "tc-code-latest",
    models: TENCENT_CODING_PLAN_MODELS,
    liveModels: true,
    modelInputModalities: Object.fromEntries(TENCENT_CODING_PLAN_MODELS.map(id => [id, ["text"]])),
    noVisionModels: TENCENT_CODING_PLAN_MODELS,
    note: "Coding tools only. Tencent forbids general API automation, custom backends, and non-interactive batch use.",
  },
  {
    id: "volcengine",
    label: "Volcengine Ark",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    adapter: "openai-chat",
    authKind: "key",
    preserveCustomDestination: true,
    dashboardUrl: "https://console.volcengine.com/ark/region:ark+cn-beijing/apikey",
    defaultModel: "doubao-seed-2-1-pro-260628",
    models: VOLCENGINE_ARK_MODELS,
    liveModels: false,
    modelReasoningEfforts: Object.fromEntries(
      VOLCENGINE_DOUBAO_THINKING_MODELS.map(id => [id, THINKING_TOGGLE_EFFORTS]),
    ),
    modelReasoningEffortMap: Object.fromEntries(
      VOLCENGINE_DOUBAO_THINKING_MODELS.map(id => [id, THINKING_TOGGLE_MAP]),
    ),
    thinkingToggleModels: VOLCENGINE_DOUBAO_THINKING_MODELS,
    preserveReasoningContentModels: [
      "deepseek-v4-pro-260425",
      "deepseek-v4-flash-260425",
      "glm-5-2-260617",
      "glm-4-7-251222",
    ],
    noVisionModels: [
      "deepseek-v4-pro-260425",
      "deepseek-v4-flash-260425",
      "deepseek-v3-2-251201",
      "glm-5-2-260617",
      "glm-4-7-251222",
    ],
    note: "Pay-as-you-go Ark API with a curated text/agent catalog. Calls on this endpoint do not consume Coding Plan or Agent Plan quota.",
  },
  {
    id: "volcengine-coding-plan",
    label: "Volcengine Ark Coding Plan",
    baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3",
    adapter: "openai-chat",
    authKind: "key",
    preserveCustomDestination: true,
    dashboardUrl: "https://console.volcengine.com/ark/region:ark+cn-beijing/overview",
    defaultModel: "ark-code-latest",
    models: VOLCENGINE_CODING_PLAN_MODELS,
    liveModels: false,
    modelInputModalities: VOLCENGINE_PLAN_INPUT_MODALITIES,
    noVisionModels: VOLCENGINE_PLAN_TEXT_ONLY_MODELS,
    modelReasoningEfforts: Object.fromEntries(
      DEEPSEEK_THINKING_MODELS.map(id => [id, deepseekThinkingEffortsFor(id)]),
    ),
    modelReasoningEffortMap: Object.fromEntries(
      DEEPSEEK_THINKING_MODELS.map(id => [id, deepseekReasoningMapFor(id)]),
    ),
    preserveReasoningContentModels: DEEPSEEK_THINKING_MODELS,
    note: "Coding tools only. Volcengine restricts Coding Plan quota to supported AI coding tools and warns that using this key for general API calls may suspend the subscription or ban the account. Use the plan key issued by the Ark console.",
  },
  {
    id: "volcengine-agent-plan",
    label: "Volcengine Ark Agent Plan",
    baseUrl: "https://ark.cn-beijing.volces.com/api/plan/v3",
    responsesPath: "/responses",
    adapter: "openai-responses",
    authKind: "key",
    // Ark's plan route does not document `service_tier`; fail closed like DeepSeek.
    supportsServiceTier: false,
    preserveCustomDestination: true,
    dashboardUrl: "https://console.volcengine.com/ark/region:ark+cn-beijing/overview",
    defaultModel: "deepseek-v4-pro",
    models: VOLCENGINE_AGENT_PLAN_MODELS,
    liveModels: false,
    modelInputModalities: VOLCENGINE_PLAN_INPUT_MODALITIES,
    noVisionModels: VOLCENGINE_PLAN_TEXT_ONLY_MODELS,
    note: "Coding tools only. Agent Plan is a subscription endpoint over the native Responses API with a static fallback catalog; Ark plan quota is intended for supported AI coding and agent tools, so avoid using this key as a general-purpose API key.",
  },
  // 2026-07-10: docs unverified; model data frozen. Evidence: devlog/_plan/260710_provider_hardening/002_research_cn.md.
  { id: "qianfan", label: "Qianfan (Baidu)", baseUrl: "https://qianfan.baidubce.com/v2", adapter: "openai-chat", authKind: "key", dashboardUrl: "https://console.bce.baidu.com/iam/#/iam/apikey/list" },
  // 2026-07-10: docs unverified; model data frozen. Evidence: devlog/_plan/260710_provider_hardening/002_research_cn.md.
  { id: "alibaba", label: "Alibaba Coding Plan", baseUrl: ALIBABA_CODING_INTL_BASE_URL, adapter: "openai-chat", authKind: "key", allowBaseUrlOverride: true, baseUrlChoices: ALIBABA_CODING_BASE_URL_CHOICES, dashboardUrl: "https://dashscope.console.aliyun.com/apiKey" },
  {
    id: "alibaba-token-plan",
    label: "Alibaba Token Plan (Beijing)",
    baseUrl: "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
    adapter: "openai-chat",
    authKind: "key",
    dashboardUrl: "https://bailian.console.aliyun.com/cn-beijing?tab=plan",
    defaultModel: "qwen3.8-max",
    models: ALIBABA_TOKEN_PLAN_MODELS,
    liveModels: false,
    note: "Token Plan Personal Edition · China (Beijing)",
    modelInputModalities: ALIBABA_TOKEN_PLAN_INPUT_MODALITIES,
    modelContextWindows: {
      "qwen3.8-max": 983_616, "qwen3.7-max": 1_000_000, "qwen3.7-plus": 1_000_000,
      "qwen3.6-flash": 1_000_000, "glm-5.3": 1_000_000, "glm-5.2": 1_000_000, "deepseek-v4-pro": 1_000_000,
    },
    modelReasoningEfforts: {
      ...Object.fromEntries(ALIBABA_TOKEN_PLAN_QWEN_MODELS.map(id => [id, THINKING_BUDGET_EFFORTS])),
      "qwen3.8-max": QWEN38_REASONING_EFFORTS,
      "glm-5.3": ZAI_GLM_53_REASONING_EFFORTS,
      "glm-5.2": ZAI_GLM_52_REASONING_EFFORTS,
      "deepseek-v4-pro": deepseekThinkingEffortsFor("deepseek-v4-pro"),
    },
    modelDefaultReasoningEfforts: { "qwen3.8-max": "xhigh" },
    modelReasoningEffortMap: { "deepseek-v4-pro": deepseekReasoningMapFor("deepseek-v4-pro") },
    directReasoningEffortModels: ["qwen3.8-max"],
    thinkingBudgetModels: ALIBABA_TOKEN_PLAN_QWEN_MODELS.filter(id => id !== "qwen3.8-max"),
    preserveReasoningContentModels: ["glm-5.3", "glm-5.2", "deepseek-v4-pro", "qwen3.8-max", "qwen3.7-max", "qwen3.7-plus", "qwen3.6-flash"],
    noVisionModels: ["glm-5.3", "glm-5.2", "deepseek-v4-pro"],
  },
  {
    id: "alibaba-token-plan-intl",
    label: "Alibaba Token Plan (International)",
    baseUrl: ALIBABA_INTL_TOKEN_PLAN_BASE_URL,
    adapter: "openai-chat",
    authKind: "key",
    allowBaseUrlOverride: true,
    baseUrlChoices: ALIBABA_INTL_BASE_URL_CHOICES,
    dashboardUrl: "https://modelstudio.console.alibabacloud.com/?tab=api#/api",
    defaultModel: "qwen3.7-max",
    models: ALIBABA_INTL_TOKEN_PLAN_MODELS,
    liveModels: false,
   note: "Token Plan Team Edition · Singapore (ap-southeast-1)",
    metadataModelIdNormalize: "case-insensitive",
   modelInputModalities: ALIBABA_INTL_TOKEN_PLAN_INPUT_MODALITIES,
    modelContextWindows: {
      "qwen3.8-max": 983_616,
      "qwen3.7-max": 1_000_000, "qwen3.7-plus": 1_000_000, "qwen3.6-plus": 1_000_000, "qwen3.6-flash": 1_000_000,
      "deepseek-v4-pro": 1_000_000, "deepseek-v4-flash": 1_000_000, "deepseek-v3.2": 131_072,
      "kimi-k2.7-code": 262_144, "kimi-k2.6": 262_144, "kimi-k2.5": 262_144,
      "glm-5.3": 1_000_000, "glm-5.2": 1_000_000, "glm-5.1": 1_000_000, "glm-5": 1_000_000,
      "MiniMax-M2.5": 204_800,
    },
    modelReasoningEfforts: {
      ...Object.fromEntries(ALIBABA_INTL_TOKEN_PLAN_QWEN_MODELS.map(id => [id, THINKING_BUDGET_EFFORTS])),
      "qwen3.8-max": QWEN38_REASONING_EFFORTS,
      "glm-5.3": ZAI_GLM_53_REASONING_EFFORTS,
      "glm-5.2": ZAI_GLM_52_REASONING_EFFORTS,
      "deepseek-v4-pro": deepseekThinkingEffortsFor("deepseek-v4-pro"),
      "deepseek-v4-flash": deepseekThinkingEffortsFor("deepseek-v4-flash"),
    },
    modelReasoningEffortMap: {
      "deepseek-v4-pro": deepseekReasoningMapFor("deepseek-v4-pro"),
      "deepseek-v4-flash": deepseekReasoningMapFor("deepseek-v4-flash"),
    },
    directReasoningEffortModels: ["qwen3.8-max"],
    thinkingBudgetModels: ALIBABA_INTL_TOKEN_PLAN_QWEN_MODELS.filter(id => id !== "qwen3.8-max"),
    preserveReasoningContentModels: ["glm-5.3", "glm-5.2", "deepseek-v4-pro", "deepseek-v4-flash", "qwen3.8-max", "qwen3.7-max", "qwen3.7-plus", "qwen3.6-plus", "qwen3.6-flash"],
    noVisionModels: ["deepseek-v4-pro", "deepseek-v4-flash", "deepseek-v3.2", "glm-5.3", "glm-5.2", "glm-5.1", "glm-5", "MiniMax-M2.5"],
    noReasoningModels: ["kimi-k2.7-code", "kimi-k2.6", "kimi-k2.5", "deepseek-v3.2", "glm-5.1", "glm-5", "MiniMax-M2.5"],
    modelDefaultReasoningEfforts: { "qwen3.8-max": "xhigh" },
  },
  // NEEDS_HUMAN 2026-07-10: kept for config compatibility, but this is a dashboard URL,
  // no /models endpoint is documented, and tools are silently ignored upstream per docs.parallel.ai.
  // Evidence: devlog/_plan/260710_provider_hardening/003_research_aggregators.md.
  { id: "parallel", label: "Parallel", baseUrl: "https://platform.parallel.ai", adapter: "openai-chat", authKind: "key", dashboardUrl: "https://platform.parallel.ai" },
  // ZenMux native ids are vendor-namespaced (`<vendor>/<model>`), verified live against
  // https://zenmux.ai/api/v1/models on 2026-07-18. The static seed doubles as the
  // cold-cache decode source for the Codex slug codec (src/providers/slug-codec.ts);
  // live discovery still owns the full catalog.
  {
    id: "zenmux", label: "ZenMux", baseUrl: "https://zenmux.ai/api/v1", adapter: "openai-chat", authKind: "key", dashboardUrl: "https://zenmux.ai",
    models: ["moonshotai/kimi-k3-free", "moonshotai/kimi-k3"],
  },
  {
    id: "litellm", label: "LiteLLM (self-hosted)", baseUrl: "http://localhost:4000/v1", adapter: "openai-chat", authKind: "key",
    dashboardUrl: "https://docs.litellm.ai/docs/proxy/quick_start",
    allowPrivateNetworkByDefault: true,
    allowBaseUrlOverride: true,
    // A self-hosted proxy may legitimately run without a master key.
    keyOptional: true,
  },
  {
    id: "ollama-cloud",
    label: "Ollama Cloud",
    baseUrl: "https://ollama.com/v1",
    adapter: "openai-chat",
    authKind: "key",
    dashboardUrl: "https://ollama.com/settings/keys",
    // Live IDs verified 2026-07-10; qwen3-coder:480b retires 2026-07-15.
    models: ["glm-5.3", "glm-5.2", "deepseek-v4-pro", "qwen3-coder:480b", "gpt-oss:120b", "kimi-k2.6", "minimax-m3", "qwen3.5:397b", "gemma4:31b"],
    defaultModel: "glm-5.3",
    noVisionModels: [
      "glm-5.3", "glm-5.2", "glm-5.1", "glm-5", "glm-4.7",
      "minimax-m2.7", "minimax-m2.5", "minimax-m2.1",
      "nemotron-3-ultra", "nemotron-3-super",
      "deepseek-v4-pro", "deepseek-v4-flash",
      "gpt-oss", "qwen3-coder:480b",
    ],
  },
  // FREEZE 2026-07-10: codestral-latest is unconfirmed behind auth. Evidence: devlog/_plan/260710_provider_hardening/003_research_aggregators.md.
  { id: "mistral", label: "Mistral", baseUrl: "https://api.mistral.ai/v1", adapter: "openai-chat", authKind: "key", dashboardUrl: "https://console.mistral.ai/api-keys", defaultModel: "codestral-latest" },
  {
    id: "minimax", label: "MiniMax — Coding Plan", baseUrl: "https://api.minimax.io/v1", adapter: "openai-chat", authKind: "key",
    dashboardUrl: "https://platform.minimax.io", defaultModel: "MiniMax-M3", models: MINIMAX_MODELS,
    modelContextWindows: MINIMAX_MODEL_CONTEXT_WINDOWS,
    modelReasoningEfforts: { "MiniMax-M3": MINIMAX_M3_REASONING_EFFORTS },
    modelDefaultReasoningEfforts: { "MiniMax-M3": "medium" },
    modelReasoningEffortMap: { "MiniMax-M3": MINIMAX_M3_REASONING_EFFORT_MAP },
    preserveReasoningContentModels: MINIMAX_MODELS,
    // MiniMax-M3 low effort maps to thinking disabled, so a legitimate tool
    // round can carry no reasoning at all; only replay real recorded text,
    // never a fabricated placeholder (chatgpt-codex-connector P2 on #1205).
    requiresReasoningPlaceholderModels: [],
    reasoningSplitModels: MINIMAX_MODELS,
    thinkingToggleModels: ["MiniMax-M3"],
    jawcodeBundle: "minimax", metadataModelIdNormalize: "case-insensitive", note: "Subscription Key or API Key",
  },
  {
    id: "minimax-cn", label: "MiniMax — Coding Plan (CN)", baseUrl: "https://api.minimaxi.com/v1", adapter: "openai-chat", authKind: "key",
    dashboardUrl: "https://platform.minimaxi.com", defaultModel: "MiniMax-M3", models: MINIMAX_MODELS,
    modelContextWindows: MINIMAX_MODEL_CONTEXT_WINDOWS,
    modelReasoningEfforts: { "MiniMax-M3": MINIMAX_M3_REASONING_EFFORTS },
    modelDefaultReasoningEfforts: { "MiniMax-M3": "medium" },
    modelReasoningEffortMap: { "MiniMax-M3": MINIMAX_M3_REASONING_EFFORT_MAP },
    preserveReasoningContentModels: MINIMAX_MODELS,
    requiresReasoningPlaceholderModels: [],
    reasoningSplitModels: MINIMAX_MODELS,
    thinkingToggleModels: ["MiniMax-M3"],
    jawcodeBundle: "minimax", metadataModelIdNormalize: "case-insensitive", note: "中国区 Subscription Key",
  },
  {
    id: "kimi-code", label: "Kimi (coding)", baseUrl: "https://api.kimi.com/coding/v1", adapter: "openai-chat", authKind: "key",
    dashboardUrl: "https://platform.moonshot.cn/console/api-keys", defaultModel: "kimi-k2.7-code",
    modelSuffixBracketStrip: true,
    // API-key form of the same Kimi Code Plan transport; keep cache affinity identical to OAuth.
    promptCacheKey: true,
    models: KIMI_CODING_MODELS,
    modelContextWindows: KIMI_CODING_MODEL_CONTEXT_WINDOWS,
    modelInputModalities: KIMI_CODING_MODEL_INPUT_MODALITIES,
    noReasoningModels: KIMI_CODING_NO_REASONING_MODELS,
    modelReasoningEfforts: KIMI_CODING_REASONING_EFFORTS,
    modelDefaultReasoningEfforts: KIMI_CODING_DEFAULT_REASONING_EFFORTS,
    modelReasoningEffortMap: KIMI_CODING_REASONING_EFFORT_MAPS,
    noTemperatureModels: KIMI_LOCKED_PARAMETER_MODELS,
    noTopPModels: KIMI_LOCKED_PARAMETER_MODELS,
    noPenaltyModels: KIMI_LOCKED_PARAMETER_MODELS,
    autoToolChoiceOnlyModels: KIMI_AUTO_TOOL_CHOICE_ONLY_MODELS,
    preserveReasoningContentModels: KIMI_THINKING_MODELS,
  },
  {
    id: "opencode-zen", label: "opencode zen", baseUrl: "https://opencode.ai/zen/v1", adapter: "openai-chat", authKind: "key", dashboardUrl: "https://opencode.ai/auth",
    // Same opencode.ai/zen/v1 gateway as `opencode-free` (keyed tier): DeepSeek thinking mode
    // requires the assistant's original reasoning_content to be replayed on tool-call
    // continuations, or the gateway answers HTTP 400 (issues #950/#994). Mirror the DeepSeek
    // reasoning + thinking metadata so `opencode-zen/deepseek-v4-flash-free` — and the other
    // Zen DeepSeek thinking models — never serialize a bare tool-call turn.
    note: "Keyed OpenCode Zen gateway. Free models on this tier are often short-window rate-limited at roughly 15-20 requests/minute (community-measured; OpenCode does not publish RPM). Zen may return generic 429s without Retry-After / X-RateLimit headers; when Retry-After is omitted, opencodex adds a synthetic backoff hint (upstream Retry-After still wins). Distinct from the keyless opencode-free desktop quota (~200 Big Pickle/free-model requests per 5 hours). Docs: https://opencode.ai/docs/zen/. Free-model prompts may be retained for training — do not send confidential material.",
    modelReasoningEfforts: Object.fromEntries(
      [...DEEPSEEK_THINKING_MODELS, ...OPENCODE_FREE_DEEPSEEK_MODELS].map(id => [id, deepseekThinkingEffortsFor(id)]),
    ),
    modelReasoningEffortMap: Object.fromEntries(
      [...DEEPSEEK_THINKING_MODELS, ...OPENCODE_FREE_DEEPSEEK_MODELS].map(id => [id, deepseekReasoningMapFor(id)]),
    ),
    preserveReasoningContentModels: [...DEEPSEEK_THINKING_MODELS, ...OPENCODE_FREE_DEEPSEEK_MODELS],
    // Same Zen gateway as opencode-free: Ox Alpha Free (1M multimodal stealth model)
    // and the DeepSeek vision preview (merges into deepseek-v4-flash later).
    modelContextWindows: {
      [OPENCODE_OX_ALPHA_FREE_MODEL]: OX_ALPHA_CONTEXT_WINDOW,
      [DEEPSEEK_VISION_PREVIEW_MODEL]: 1_048_576,
    },
    modelInputModalities: {
      [OPENCODE_OX_ALPHA_FREE_MODEL]: ["text", "image"],
      [DEEPSEEK_VISION_PREVIEW_MODEL]: ["text", "image"],
    },
    noVisionModels: [...OPENCODE_ZEN_TEXT_ONLY_MODELS, ...DEEPSEEK_THINKING_MODELS],
  },
  { id: "vercel-ai-gateway", label: "Vercel AI Gateway", baseUrl: "https://ai-gateway.vercel.sh/v1", adapter: "openai-chat", authKind: "key", dashboardUrl: "https://vercel.com/dashboard" },
  {
    id: "opencode-free",
    label: "OpenCode Free",
    adapter: "openai-chat",
    baseUrl: "https://opencode.ai/zen/v1",
    authKind: "key",
    keyOptional: true,
    featured: true,
    liveModels: true,
    note: "No key needed — public desktop tier. OpenCode currently advertises about 200 Big Pickle/free-model requests per 5 hours. The same Zen gateway can also short-window rate-limit free models at roughly 15-20 requests/minute, and may return generic 429s without Retry-After (opencodex synthesizes backoff only when that header is omitted). Free models are discovered live from Zen. Data use: per OpenCode's Zen docs (https://opencode.ai/docs/zen/), prompts sent to free models may be retained and used for training/improvement — do not send confidential material through this provider.",
    dashboardUrl: "https://opencode.ai",
    staticHeaders: {
      // Zen answers a bare runtime User-Agent (Bun/x.y.z) more aggressively than a client
      // that identifies itself, which is what the 429 in #2067 traced to. The value is
      // deliberately unversioned: a pinned "opencode-cli/<version>" is a claim about an
      // install we do not have and goes stale on the vendor's schedule, not ours.
      // Corroboration, not authority: OmniRoute — an independent open-source broker against
      // the same Zen upstream — defaults to exactly this pair (userAgent "opencode", client
      // "desktop") in open-sse/executors/opencode.ts, and got there by RETREATING from its
      // own earlier "opencode-cli/1.0.0" pin. An operator can still override either value
      // through the provider headers API; user headers win case-insensitively at route time.
      "User-Agent": "opencode",
      "x-opencode-client": "desktop",
    },
    modelReasoningEfforts: Object.fromEntries(OPENCODE_FREE_DEEPSEEK_MODELS.map(id => [id, deepseekThinkingEffortsFor(id)])),
    modelReasoningEffortMap: Object.fromEntries(OPENCODE_FREE_DEEPSEEK_MODELS.map(id => [id, deepseekReasoningMapFor(id)])),
    preserveReasoningContentModels: OPENCODE_FREE_DEEPSEEK_MODELS,
    // Ox Alpha Free (`x-preview-f-free`): the OpenRouter stealth model on Zen's
    // free tier — 1,048,576 context, text+image input. Deliberately NOT in the
    // text-only list below. The DeepSeek vision preview id is preemptive
    // metadata for when Zen starts serving it (merges into v4-flash later).
    modelContextWindows: {
      [OPENCODE_OX_ALPHA_FREE_MODEL]: OX_ALPHA_CONTEXT_WINDOW,
      [DEEPSEEK_VISION_PREVIEW_MODEL]: 1_048_576,
    },
    modelInputModalities: {
      [OPENCODE_OX_ALPHA_FREE_MODEL]: ["text", "image"],
      [DEEPSEEK_VISION_PREVIEW_MODEL]: ["text", "image"],
    },
    // Same Zen roster behind the same base URL, so it carries the same measured
    // text-only list rather than only its DeepSeek member (#1043).
    noVisionModels: OPENCODE_ZEN_TEXT_ONLY_MODELS,
  },
  { id: "xiaomi", label: "Xiaomi MiMo", baseUrl: "https://api.xiaomimimo.com/anthropic", adapter: "anthropic", authKind: "key", dashboardUrl: "https://xiaomimimo.com", defaultModel: "mimo-v2.5-pro" },
  // Xiaomi's public OpenAI-compatible endpoint is a distinct transport from both the Anthropic
  // preset above and the paid token-plan host below. Keep a separate fixed-destination contract
  // so existing custom providers are never retargeted while the official route receives the
  // strict reasoning ladder its validator enforces (#1483).
  {
    id: "xiaomi-mimo",
    label: "Xiaomi MiMo (OpenAI Chat)",
    baseUrl: "https://api.xiaomimimo.com/v1",
    adapter: "openai-chat",
    authKind: "key",
    dashboardUrl: "https://platform.xiaomimimo.com/console/balance",
    defaultModel: "mimo-v2.5",
    models: ["mimo-v2.5"],
    reasoningEfforts: ["low", "medium", "high"],
    reasoningEffortMap: { xhigh: "high", max: "high", ultra: "high" },
    preserveCustomDestination: true,
    note: "Official Xiaomi MiMo OpenAI-compatible Chat endpoint. The upstream validator accepts reasoning_effort none/low/medium/high; higher Codex tiers are clamped to high.",
  },
  { id: "kilo", label: "Kilo", baseUrl: "https://api.kilo.ai/api/gateway", adapter: "openai-chat", authKind: "key", dashboardUrl: "https://kilo.ai" },
  {
    id: "mimo-free",
    label: "MiMo Free",
    adapter: "mimo-free",
    baseUrl: "https://api.xiaomimimo.com/api/free-ai/openai/chat",
    authKind: "key",
    keyOptional: true,
    featured: true,
    liveModels: true,
    dashboardUrl: "https://xiaomimimo.com",
    defaultModel: "mimo-auto",
    models: ["mimo-auto"],
    reasoningEfforts: ["low", "medium", "high"],
    reasoningEffortMap: { xhigh: "high", max: "high", ultra: "high" },
    note: "No key needed — uses Xiaomi MiMo's free public tier (limited-time offer). A JWT is bootstrapped automatically with an anonymous random client id stored locally. The endpoint contract mirrors the official MiMoCode client and is not publicly documented — Xiaomi may change or restrict it at any time. Prompts may be processed/retained by Xiaomi; do not send confidential material.",
  },
  // Xiaomi MiMo paid token plan. Separate host and wire from both `xiaomi` (Anthropic) and
  // `mimo-free` (free tier, bespoke adapter), so it needs its own entry rather than a variant.
  //
  // Pinned to openai-chat deliberately (#1158). The endpoint answers the Responses wire for
  // plain turns, which is why users configuring it by hand pick `openai-responses` — MiMo
  // documents Responses support. But its gateway rejects `type: "custom"` tools with
  // `400 responses_feature_not_supported`, and `apply_patch` is a custom tool, so every agentic
  // turn fails while chat turns succeed. The Chat path lowers custom tools to `{input: string}`
  // functions and restores them as `custom_tool_call`, so the capability survives intact.
  // Stripping the tools instead would stop the 400 and disable the agent loop.
  {
    id: "mimo",
    label: "Xiaomi MiMo (token plan)",
    baseUrl: "https://token-plan-cn.xiaomimimo.com/v1",
    adapter: "openai-chat",
    authKind: "key",
    dashboardUrl: "https://xiaomimimo.com",
    defaultModel: "mimo-v2.5-pro",
    models: ["mimo-v2.5-pro", "mimo-v2.5"],
    // The gateway validates the ladder strictly and rejects anything above `high`.
    reasoningEfforts: ["low", "medium", "high"],
    reasoningEffortMap: { xhigh: "high", max: "high", ultra: "high" },
    // Live token-plan verification (#1927): the Pro route rejects image input while
    // mimo-v2.5 accepts it natively. Keep this provider-scoped so a hand-rolled
    // provider with the same id but another destination does not inherit the claim.
    noVisionModels: ["mimo-v2.5-pro"],
    // A user may already have hand-rolled a provider under this id against a different host;
    // without this, routedProviderConfig() would canonicalize their base URL onto ours and send
    // their key somewhere they did not choose.
    preserveCustomDestination: true,
    note: "Xiaomi MiMo paid token plan. Pinned to the Chat wire: the Responses endpoint rejects freeform (custom) tools such as apply_patch with 400 responses_feature_not_supported, so agentic turns fail there while plain turns succeed. Reasoning tiers above high are clamped.",
  },
  { id: "cloudflare-ai-gateway", label: "Cloudflare AI Gateway", baseUrl: "https://gateway.ai.cloudflare.com/v1/{account-id}/{gateway}/anthropic", adapter: "anthropic", authKind: "key", dashboardUrl: "https://dash.cloudflare.com/?to=/:account/ai/ai-gateway" },
  {
    // Cloudflare Workers AI: OpenAI-compatible endpoint. The base URL contains {account_id}
    // which must be resolved by the user at setup time. Model IDs use the @cf/ prefix.
    // Live-verified 2026-07-21 against https://developers.cloudflare.com/workers-ai/models/
    // Official search is sibling to /ai/v1 (GET .../ai/models/search?format=openrouter).
    id: "cloudflare-workers-ai", label: "Cloudflare Workers AI",
    baseUrl: "https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1",
    adapter: "openai-chat", authKind: "key", freeTier: true,
    dashboardUrl: "https://dash.cloudflare.com/?to=/:account/ai/workers-ai",
    defaultModel: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    models: [
      "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      "@cf/qwen/qwq-32b",
      "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b",
      "@cf/moonshotai/kimi-k2.7-code",
      "@cf/zai-org/glm-5.3",
      "@cf/zai-org/glm-5.2",
      "@cf/mistralai/mistral-small-3.1-24b-instruct",
    ],
    liveModels: true,
    modelDiscovery: {
      path: "../models/search",
      query: { format: "openrouter", per_page: "1000" },
      stripIdPrefix: "workers-ai/",
      maxModels: 256,
    },
    note: "Workers AI · Free tier included · Account ID required in base URL",
  },
  // FREEZE 2026-07-10: /models was auth-gated under key login. OAuth device-flow + copilot_internal
  // exchange (issue #151) unlocks live discovery; static seed is a cold-start fallback only.
  {
    id: "github-copilot",
    label: "GitHub Copilot",
    baseUrl: "https://api.githubcopilot.com",
    adapter: "openai-chat",
    authKind: "oauth",
    allowKeyAuthOverride: true,
    featured: false,
    dashboardUrl: "https://github.com/settings/copilot",
    liveModels: true,
    models: ["gpt-4o", "gpt-4.1", "gpt-4.1-mini", "claude-sonnet-4", "gemini-2.5-pro", "gpt-5-mini", "gpt-5.3-codex", "gpt-5.4", "gpt-5.4-mini", "gpt-5.5", "gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra"],
    defaultModel: "gpt-4o",
    // Copilot fronts a mixed-wire catalog: these models reject /chat/completions for
    // real Codex-agent traffic (function tools + reasoning), so every inbound wire
    // rides Responses. Evidence: issue #748 field runs, pi.dev/models/github-copilot/*
    // wire declarations, BerriAI/litellm#23332 (gpt-5.4), JetBrains LLM-29711
    // (gpt-5.6-sol). gpt-5.4-nano is deliberately absent — it has no field report; a
    // user can opt it in with an explicit modelAdapters entry, which always wins.
    modelWireDefaults: {
      "gpt-5.3-codex": "openai-responses",
      "gpt-5.4": "openai-responses",
      "gpt-5.4-mini": "openai-responses",
      "gpt-5.5": "openai-responses",
      "gpt-5.6-luna": "openai-responses",
      "gpt-5.6-sol": "openai-responses",
      "gpt-5.6-terra": "openai-responses",
    },
    note: "Experimental unofficial Copilot bridge. Logs in via GitHub device flow using the public VS Code OAuth client id, then exchanges for a short-lived Copilot API token (copilot_internal). Requires an active Copilot subscription. GitHub may tighten or revoke this path; do not send confidential material you would not paste into Copilot Chat.",
  },
  // FREEZE 2026-07-10: no public OpenAI-compatible endpoint is documented. Evidence: devlog/_plan/260710_provider_hardening/003_research_aggregators.md.
  { id: "gitlab-duo", label: "GitLab Duo", baseUrl: "https://cloud.gitlab.com/ai/v1/proxy/openai/v1", adapter: "openai-chat", authKind: "key", dashboardUrl: "https://gitlab.com/-/user_settings/personal_access_tokens" },
];

export function providerRegistryFastWireError(
  entry: Pick<ProviderRegistryEntry, "fastWire" | "supportsServiceTier" | "modelSupportsServiceTier">,
): string | null {
  return fastWireDeclarationError(entry);
}

for (const entry of PROVIDER_REGISTRY) {
  const error = providerRegistryFastWireError(entry);
  if (error) throw new TypeError(`Invalid provider registry entry ${entry.id}: ${error}`);
}

export function getProviderRegistryEntry(id: string): ProviderRegistryEntry | undefined {
  return PROVIDER_REGISTRY.find(entry => entry.id === id);
}

/**
 * Merge a registry row's `staticHeaders` beneath a provider's own headers.
 *
 * The field is documented as "merged into every upstream request for this provider", but that
 * was only ever true for a freshly seeded config: `providerConfigSeed` copies the block once
 * (`derive.ts`), `enrichProviderFromCatalog` fills it only when the whole block is absent, and
 * nothing merged it at request time. So an install that predates a header — or that saved any
 * header of its own — never received the new one, which is exactly what #2067 would have
 * shipped for every existing opencode-free user.
 *
 * The comparison is case-insensitive on purpose. HTTP header names are case-insensitive, but a
 * plain object spread is not: merging a registry `User-Agent` over a user's `user-agent`
 * produces two entries that `Headers` serializes as one comma-joined value
 * ("opencode, custom-agent"), which is a corrupted request rather than an override. The user's
 * spelling and value both win; the registry only fills names the user has not spoken for.
 */
export function mergeRegistryStaticHeaders(
  staticHeaders: Record<string, string> | undefined,
  userHeaders: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!staticHeaders) return userHeaders;
  if (!userHeaders) return { ...staticHeaders };
  const claimed = new Set(Object.keys(userHeaders).map(name => name.toLowerCase()));
  const merged: Record<string, string> = { ...userHeaders };
  for (const [name, value] of Object.entries(staticHeaders)) {
    if (!claimed.has(name.toLowerCase())) merged[name] = value;
  }
  return merged;
}

/** Whether this registry row's per-model service-tier evidence applies to one configured target. */
export function registryModelServiceTierCapabilityApplies(
  entry: Pick<ProviderRegistryEntry, "modelServiceTierCapabilityBaseUrlGuard">,
  provider: Pick<OcxProviderConfig, "baseUrl">,
): boolean {
  const guard = entry.modelServiceTierCapabilityBaseUrlGuard;
  return guard === undefined || guard(provider.baseUrl);
}

function normalizedProviderEndpoint(value: string): string {
  const trimmed = value.trim();
  try {
    const parsed = new URL(trimmed);
    parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return trimmed.replace(/\/+$/, "");
  }
}

/**
 * Whether registry transport defaults own this configured row.
 *
 * OAuth/forward providers stay pinned because their credentials must never be sent to an
 * arbitrary same-named host. Existing key presets keep their historical pinning behavior; a new
 * preset can opt into collision preservation, in which case its fixed endpoint owns only rows
 * that still match that destination.
 */
export function providerMatchesRegistryTransport(
  id: string,
  provider: Pick<OcxProviderConfig, "baseUrl" | "adapter"> & Partial<Pick<OcxProviderConfig, "authMode">>,
): boolean {
  const entry = getProviderRegistryEntry(id);
  if (!entry) return false;
  if (entry.authKind !== "key" || entry.preserveCustomDestination !== true) return true;
  // The opt-in is intentionally limited to fixed key destinations. Fail closed if a future
  // registry edit combines it with an override/template despite the registry parity tests.
  if (entry.allowBaseUrlOverride || /\{[^}]*\}/.test(entry.baseUrl)) return false;
  if (typeof provider.baseUrl !== "string") return false;
  if (provider.adapter !== entry.adapter) return false;
  if (provider.authMode !== undefined && provider.authMode !== "key") return false;
  return normalizedProviderEndpoint(provider.baseUrl) === normalizedProviderEndpoint(entry.baseUrl);
}

/**
 * Resolve the registry entry a configured provider actually points at, by TRANSPORT
 * rather than by name.
 *
 * `providerMatchesRegistryTransport` answers "does the row named X still point at X's
 * documented destination", which is the right question for routing but the wrong one
 * for user-facing metadata: the GUI lets a preset be saved under any name, and a
 * renamed row would silently lose a usage restriction it still needs to display.
 *
 * Only fixed key destinations are matched. Entries with an overridable or templated
 * base URL are skipped, because their configured URL cannot identify one vendor route.
 */
export function registryEntryForProviderDestination(
  provider: Pick<OcxProviderConfig, "baseUrl" | "adapter"> & Partial<Pick<OcxProviderConfig, "authMode">>,
): ProviderRegistryEntry | undefined {
  if (typeof provider.baseUrl !== "string" || !provider.baseUrl) return undefined;
  if (provider.authMode !== undefined && provider.authMode !== "key") return undefined;
  const endpoint = normalizedProviderEndpoint(provider.baseUrl);
  return PROVIDER_REGISTRY.find(entry =>
    entry.authKind === "key"
    && !entry.allowBaseUrlOverride
    && !/\{[^}]*\}/.test(entry.baseUrl)
    && entry.adapter === provider.adapter
    && normalizedProviderEndpoint(entry.baseUrl) === endpoint);
}

/**
 * Resolve a registry-only default for a mixed-wire provider. Defaults only move a provider
 * between the two OpenAI-shaped adapters and never override a provider configured on another
 * wire. The resolver receives the allow-list so this helper cannot accidentally widen the
 * adapter-selection boundary when a new registry entry is added.
 */
export function providerModelWireDefault(
  id: string,
  provider: Pick<OcxProviderConfig, "baseUrl" | "adapter"> & Partial<Pick<OcxProviderConfig, "authMode">>,
  modelId: string,
  allowedWires: ReadonlySet<string>,
  inbound: InboundWire,
): string | undefined {
  if (!allowedWires.has(provider.adapter)) return undefined;
  const entry = getProviderRegistryEntry(id);
  if (!entry?.modelWireDefaults || !providerMatchesRegistryTransport(id, provider)) return undefined;
  const declared = entry.modelWireDefaults[modelId.trim().toLowerCase()];
  if (declared === undefined) return undefined;
  // A bare string applies to every inbound/auth mode; the object form may narrow either.
  if (typeof declared !== "string") {
    if (!declared.inbound.includes(inbound)) return undefined;
    const authMode = provider.authMode ?? entry.authKind;
    if (declared.authModes && !declared.authModes.includes(authMode)) return undefined;
  }
  const wire = typeof declared === "string" ? declared : declared.wire;
  return wire !== undefined && allowedWires.has(wire) ? wire : undefined;
}

/** Resolve a registry-only upstream-streaming compatibility hint for Responses turns. */
export function providerModelResponsesUpstreamStreaming(
  id: string,
  provider: Pick<OcxProviderConfig, "baseUrl" | "adapter"> & Partial<Pick<OcxProviderConfig, "authMode">>,
  modelId: string,
): boolean | undefined {
  const entry = getProviderRegistryEntry(id);
  if (!entry?.modelResponsesUpstreamStreaming || !providerMatchesRegistryTransport(id, provider)) return undefined;
  return entry.modelResponsesUpstreamStreaming[modelId.trim().toLowerCase()];
}

/** Resolve a registry-only terminal-repair policy for native Responses streams. */
export function providerModelResponsesTerminalRepair(
  id: string,
  provider: Pick<OcxProviderConfig, "baseUrl" | "adapter"> & Partial<Pick<OcxProviderConfig, "authMode">>,
  modelId: string,
): ResponsesTerminalRepairPolicy | undefined {
  const entry = getProviderRegistryEntry(id);
  if (!entry?.modelResponsesTerminalRepair || !providerMatchesRegistryTransport(id, provider)) return undefined;
  const policy = entry.modelResponsesTerminalRepair[modelId.trim().toLowerCase()];
  const graceMs = Math.floor(policy?.graceMs ?? 0);
  if (!Number.isFinite(graceMs) || graceMs <= 0) return undefined;
  return { graceMs };
}

/**
 * Effective Codex account mode for a provider. For canonical `openai`, a valid persisted
 * `codexAccountMode` on the provider config wins and a missing/invalid value defaults to
 * `"pool"`. Other providers keep registry-only metadata (there is no mode for `openai-apikey`).
 */
export function providerCodexAccountMode(id: string, provider?: OcxProviderConfig): CodexAccountMode | undefined {
  const registryMode = getProviderRegistryEntry(id)?.codexAccountMode;
  if (id !== "openai") return registryMode;
  const persisted = provider?.codexAccountMode;
  if (persisted === "pool" || persisted === "direct") return persisted;
  return registryMode ?? "pool";
}

/**
 * Effective Google wire mode for a provider: config value, else registry backfill (a saved
 * key-login config may omit `googleMode` — mirrors the router's backfill), else "ai-studio"
 * (the Generative Language API default). Null for non-google adapters.
 */
export function effectiveGoogleMode(
  providerId: string,
  prov: { adapter?: string; googleMode?: "ai-studio" | "vertex" | "cloud-code-assist" },
): "ai-studio" | "vertex" | "cloud-code-assist" | null {
  if (prov.adapter !== "google") return null;
  return prov.googleMode ?? getProviderRegistryEntry(providerId)?.googleMode ?? "ai-studio";
}
