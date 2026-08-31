// AUTO-SPLIT barrel: src/types.ts re-exports every historical name; bodies live in src/types/*.
// Values (runtime): tools + wire. Types (erased): request + config + provider + accounts.

export type { OcxTool, OcxToolChoice } from "./types/tools";
export {
  CODE_MODE_EXEC_TOOL_NAME,
  namespacedToolName,
  normalizeDeclaredToolName,
  toolChoiceAliases,
  createToolChoiceResolver,
  toolChoiceCandidates,
  toolAllowedByChoice,
  resolveToolChoiceWireName,
  modelInList,
  isAllowedToolChoice,
  toolChoiceToolPredicate,
} from "./types/tools";

export type { UpstreamHttpVersion, ReasoningSummaryDelivery, CodexAccountMode } from "./types/wire";
export {
  UPSTREAM_HTTP_VERSION_VALUES,
  REASONING_SUMMARY_DELIVERY_VALUES,
  OPENAI_PROVIDER_TIER_VERSION,
  MODEL_ADAPTER_OVERRIDE_ALLOWED,
  captureWireAdapterHardPins,
  isWirePinnedModel,
  pinnedWireAdapter,
} from "./types/wire";

export type {
  OcxReasoningReplayIdentity,
  OcxReasoningReplayScopeRef,
  OcxParsedRequest,
  OcxContext,
  OcxMessage,
  OcxUserMessage,
  OcxAssistantMessage,
  OcxDeveloperMessage,
  OcxToolResultMessage,
  OcxTextContent,
  OcxImageContent,
  OcxContentPart,
  OcxThinkingContent,
  OcxToolCall,
  OcxProviderOpaqueToolCallMetadata,
  OcxAssistantContentPart,
  OcxRequestOptions,
  OcxMessagePhase,
  OcxProviderContinuationOwner,
  OcxProviderContinuationState,
  AdapterEvent,
  OcxUrlCitation,
  OcxUsage,
} from "./types/request";

export type {
  OcxClaudeCodeConfig,
  OcxClaudeDesktopFamily,
  OcxClaudeDesktopAssignment,
  OcxClaudeDesktopProfile,
  StorageCleanupPolicy,
  OcxCustomModel,
  OcxApiKeyEntry,
  OcxClientIntegrationsConfig,
  OcxConfigRebaseProvenance,
  OcxConfig,
  OcxAccountPoolRotationStrategy,
  OcxAccountPoolQuotaWindow,
  OcxComboStrategy,
  OcxComboDefaultEffort,
  OcxComboTarget,
  OcxComboConfig,
  OcxRoutingUnknownEvidenceMode,
  OcxRoutingProfileCandidate,
  OcxRoutingProfileRequirements,
  OcxRoutingProfileOptimize,
  OcxRoutingUnknownCostCapMode,
  OcxRoutingProfileLimits,
  OcxRoutingProfileUnknownEvidence,
  OcxRoutingProfileCompatibilitySuite,
  OcxRoutingProfileCompatibility,
  OcxRoutingProfileConfig,
  OcxTokenGuardianConfig,
  OcxImagesConfig,
  OcxSearchConfig,
  OcxVisionSidecarConfig,
  OcxWebSearchSidecarConfig,
} from "./types/config";

export type {
  RefreshPolicy,
  OpenRouterProviderRouting,
  VercelGatewayRouting,
  ResponsesItemIdRepairConfig,
  RateLimitRetryPolicy,
  TransientRetryPolicy,
  ProviderCostOverlay,
  RequestPacingRule,
  ProviderRequestPacingConfig,
  FastWire,
  AttemptTierOutcome,
  TierObservationContext,
  TierDecision,
  OcxProviderConfig,
} from "./types/provider";

export type {
  CodexAccount,
  CodexAccountCredentials,
  CodexAccountCredentialRecord,
} from "./types/accounts";
