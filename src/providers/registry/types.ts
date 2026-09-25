import type { CodexAccountMode, FastWire, OcxProviderConfig } from "../../types";
import type { ProviderBaseUrlChoice } from "../base-url-choices";

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
  /** Top-level response key containing model rows; defaults to `data`. */
  envelopeKey?: string;
  /** Model-row field containing the provider-native identifier; defaults to `id`. */
  idField?: string;
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
  alias?: string;
  authKind: ProviderAuthKind;
  /**
   * Credential preset for an auxiliary service rather than a model transport.
   * Its adapter is an identity marker and is intentionally absent from the
   * routable adapter registry.
   */
  credentialOnly?: boolean;
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
  /**
   * Paid provider sponsorship under SPONSORS.md. `main` is reserved for model developers,
   * `standard` for relays and gateways. The picker pins sponsor rows first (alphabetical among
   * themselves) and labels them; nothing else reads this field. Routing, failover, quota, and
   * defaults never consult it — that boundary is what SPONSORS.md promises users.
   */
  sponsor?: { tier: "main" | "standard"; url: string };
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
   * Relative send path for the `openai-chat` wire, seeded into saved config exactly like
   * `responsesPath`. Needed when one upstream serves both wires under different prefixes,
   * because a per-model wire override changes the adapter and not the base URL.
   */
  chatCompletionsPath?: string;
  /**
   * Endpoints this entry used to live at, kept so a saved custom provider that still points
   * at one keeps receiving this row's metadata through `registryEntryForProviderDestination`.
   * Destination matching is by adapter plus normalized base URL, so moving a row's wire or
   * prefix would otherwise orphan every config a user wrote against the old address.
   */
  destinationAliases?: readonly { readonly baseUrl: string; readonly adapter: string }[];
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
   * Responses upstream that also rejects a tool call with no matching output anywhere in the
   * replayed input. Seeded/backfilled like other fixed wire capabilities.
   */
  requiresPairedResponsesToolResults?: boolean;
  /**
   * When enabled, tool results that are present but empty are annotated on the wire.
   * Seeded/backfilled like other fixed wire capabilities.
   */
  annotateEmptyToolOutputs?: boolean;
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
   * The Fast lane is billed beyond the plan, so it stays off until the operator sets
   * `providers.<name>.fastEnabled: true` (see `providerFastSwitchOff`).
   */
  fastOptIn?: boolean;
  /**
   * Registry-only destination guard for `modelSupportsServiceTier`. This scopes vendor evidence
   * without changing provider ownership, routing, authentication, or config validation.
   */
  modelServiceTierCapabilityBaseUrlGuard?: (baseUrl: string) => boolean;
  /** Registry default for plaintext reasoning replay; see `OcxProviderConfig.preserveResponsesReasoningContent`. Registry-only like `supportsServiceTier`. */
  preserveResponsesReasoningContent?: boolean;
  /** Registry default for dropping replayed reasoning items for Responses upstreams that reject them. */
  dropResponsesReasoningItems?: boolean;
  /** Registry defaults for per-model Codex reasoning propagation; explicit user keys win during enrichment. */
  modelSupportsReasoningSummaries?: Record<string, boolean>;
  /** Registry defaults for per-model Codex Responses verbosity support. */
  modelSupportsVerbosity?: Record<string, boolean>;
  /**
   * Registry default applied to EVERY model of this provider, including ids that arrive from
   * live discovery after this table was written.
   *
   * `modelSupportsVerbosity` only covers the ids enumerated here, so a newly discovered model
   * fell through and re-advertised a control the upstream accepts and ignores. Where the opt-out
   * is a property of the provider's API rather than of one model, declare it here; a per-model
   * entry still wins over it.
   */
  supportsVerbosity?: boolean;
  modelDiscovery?: ProviderModelDiscoverySpec;
  contextWindow?: number;
  modelContextWindows?: Record<string, number>;
  /**
   * Registry-supplied picker labels. Without these a routed row shows its raw slug,
   * because `routedDisplayName` (codex/catalog/sync.ts) passes the slug through for every
   * provider. An operator's `modelDisplayNames` still wins: derive only fills when absent.
   */
  modelDisplayNames?: Record<string, string>;
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
  noStopModels?: string[];
  noPenaltyModels?: string[];
  /**
   * Registry-only seed for `OcxProviderConfig.noJsonSchemaModels`. Merged into the
   * resolved provider at route time rather than persisted as user config, the same way
   * `directReasoningEffortModels` above is registry-owned.
   */
  noJsonSchemaModels?: string[];
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
  /**
   * Opt this provider into visible thinking summaries (see OcxProviderConfig.showThinkingSummary).
   */
  showThinkingSummary?: boolean;
  reasoningSplitModels?: string[];
  /** See OcxProviderConfig.inlineThinkTagModels. */
  inlineThinkTagModels?: string[];
  reasoningDetailsModels?: string[];
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
  "adapter" | "baseUrl" | "apiKeyTransport" | "responsesPath" | "chatCompletionsPath" | "authMode" | "keyOptional" | "freeTier" | "modelSuffixBracketStrip" | "defaultModel" | "models"
  | "liveModels" | "contextWindow" | "modelContextWindows" | "modelInputModalities"
  | "modelDisplayNames"
  | "modelMaxInputTokens" | "defaultMaxOutputTokens" | "modelMaxOutputTokens"
  | "reasoningEfforts" | "modelReasoningEfforts" | "modelDefaultReasoningEfforts" | "reasoningEffortMap" | "modelReasoningEffortMap" | "reasoningWireFormat"
  | "noVisionModels" | "noReasoningModels" | "noTemperatureModels" | "noTopPModels" | "noStopModels" | "noPenaltyModels"
  | "autoToolChoiceOnlyModels" | "preserveReasoningContentModels" | "requiresReasoningPlaceholderModels" | "reasoningSplitModels" | "inlineThinkTagModels" | "reasoningDetailsModels" | "thinkingToggleModels" | "thinkingBudgetModels" | "escapeBuiltinToolNames" | "openaiChatEofTolerance" | "showThinkingSummary"
  | "googleMode" | "project" | "location" | "headers"
>;
