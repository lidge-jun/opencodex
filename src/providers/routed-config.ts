/**
 * Request-time provider resolution: merge a saved config row with its registry entry.
 *
 * This lives outside `src/router.ts` because `providers/api-key-selection.ts` needs exactly
 * one function from the router, and importing the router for it dragged the whole routing
 * graph into an import cycle. The router re-exports both symbols below so every existing
 * import keeps working.
 */
import type { OcxProviderConfig } from "../types";
import { providerUsesKeyAuthOverride, resolveProviderApiKey } from "./key-store";
import { captureProviderApiKeySelection } from "./api-key-selection-capture";
import { assertProviderDestinationAllowed } from "../lib/destination-policy";
import { redactSecretString, redactUrlForLog } from "../lib/redact";
import { PROVIDER_REGISTRY, registryEntryForProviderDestination } from "./registry";
import { applyDirectReasoningEffortContracts, hasLegacyClinePassReasoningEfforts } from "./derive";
import { cloneFastWire } from "./fastwire";
import { fastSwitchOff } from "./fast-opt-in";
import {
  providerMatchesRegistryTransportWithStaticGuards,
  providerSupportsLiveModelDiscovery,
} from "./static-model-discovery";
import { resolveModelPolicy } from "./resolved-model-policy";

/** Same endpoint modulo surrounding space and trailing slashes — matches `matchBaseUrlChoice`. */
function isSameEndpoint(a: string, b: string): boolean {
  return a.trim().replace(/\/+$/, "") === b.trim().replace(/\/+$/, "");
}

/**
 * Origin of a user-configured URL, with the path withheld.
 *
 * A configured `baseUrl` is user-controlled and its path may itself be the credential — an
 * account-scoped route token such as `https://proxy.example/v1/8fK2mP7qR4nV6x` is opaque and
 * high-entropy, so it matches none of the prefix patterns in `redactSecretString`. Pattern
 * redaction cannot be trusted for this value, so no path segment is logged at all. `URL.origin`
 * also excludes userinfo, query and fragment.
 *
 * `…/…` marks that a path was present without revealing it, so a reader can tell an origin-only
 * config apart from one whose path was dropped.
 */
function configuredOriginForLog(url: string): string {
  try {
    const parsed = new URL(url.trim());
    // "null" is what URL.origin yields for non-special schemes; treat it as unusable.
    if (!parsed.origin || parsed.origin === "null") return "(unloggable URL)";
    const hasPath = parsed.pathname !== "" && parsed.pathname !== "/";
    return hasPath ? `${parsed.origin}/…` : parsed.origin;
  } catch {
    return "(unparseable URL)";
  }
}

// `routedProviderConfig` runs per request, so warn once per (provider, discarded, effective) triple.
// Keyed by the URLs too: editing config.json to a different wrong value warns again.
const discardedBaseUrlWarnings = new Set<string>();
let lastWarningReconciledGeneration = 0;

export function reconcileRouterWarningMemos(generation: number): number {
  if (generation <= lastWarningReconciledGeneration) return 0;
  const removed = discardedBaseUrlWarnings.size;
  discardedBaseUrlWarnings.clear();
  lastWarningReconciledGeneration = generation;
  return removed;
}

/**
 * A pinned registry entry — non-template `baseUrl`, no `allowBaseUrlOverride` — outranks a saved
 * `baseUrl`. Dropping it silently is a footgun: requests go to an endpoint the user never
 * configured, and a wrong-region or wrong-account URL then surfaces only as a 401 with nothing
 * pointing back at the discarded setting.
 *
 * Warns rather than throws. The effective route is exactly what it was before, so a hard error
 * here would break configs that route fine today (a stale `baseUrl` left over from an earlier
 * provider is harmless whenever it names the same endpoint the registry pins).
 */
function warnIfBaseUrlDiscarded(providerName: string, userBaseUrl: string, effectiveBaseUrl: string): void {
  if (isSameEndpoint(userBaseUrl, effectiveBaseUrl)) return;
  // Asymmetric on purpose. Past the guard above, `effectiveBaseUrl` is necessarily
  // `registryEntry.baseUrl`: the caller passes the resolved URL, and whenever that resolution
  // kept the user's value the two are equal and we have already returned. So the effective side
  // is a constant from this repo's registry and safe to print in full — it is also the useful
  // half, naming the endpoint requests will actually use. The configured side is untrusted.
  const discarded = configuredOriginForLog(userBaseUrl);
  const effective = redactSecretString(redactUrlForLog(effectiveBaseUrl));
  // Key off the logged forms: no raw credential is retained for the process lifetime, and
  // rotating a key embedded in the URL no longer re-warns about the same endpoint mismatch.
  // Coarser than the raw URLs — two bad paths on one host warn once, which is the right grain.
  const key = `${providerName} | ${discarded} | ${effective}`;
  if (discardedBaseUrlWarnings.has(key)) return;
  discardedBaseUrlWarnings.add(key);
  console.warn(
    // Routing is what this warning speaks for: an adapter may adjust the endpoint again
    // downstream (kiro re-derives the region), so do not promise where the request lands.
    `⚠️  config.json provider "${providerName}": configured baseUrl ${discarded} is ignored`
    + ` because this provider's endpoint is fixed at ${effective}. A URL saved for a different`
    + ` account or region is a common cause of 401s here — drop it, or use the provider whose endpoint matches.`,
  );
}

function usableResolvedApiKey(apiKey: string | undefined): string | undefined {
  const resolved = resolveProviderApiKey(apiKey);
  return typeof resolved === "string" && resolved.trim().length > 0 ? resolved : undefined;
}

export function routedProviderConfig(providerName: string, provider: OcxProviderConfig): OcxProviderConfig {
  provider = { ...provider, _apiKeyAttempt: provider._apiKeyAttempt ?? captureProviderApiKeySelection(provider) };
  const registryEntry = PROVIDER_REGISTRY.find(entry => entry.id === providerName);
  if (!registryEntry || !providerMatchesRegistryTransportWithStaticGuards(providerName, provider)) {
    assertProviderDestinationAllowed(providerName, provider);
    // A row whose adapter no longer matches its registry entry still reaches the Responses
    // adapter when one model opts in through `modelAdapters` — a Volcengine Coding Plan config
    // saved on Chat, for instance. The replay-drop flag belongs to the DESTINATION rather than
    // to the provider-wide wire, so it is filled here too; without it that continuation forwards
    // the reasoning item the upstream answers 400 to. Destination matching refuses templated and
    // overridable base URLs, so this cannot follow a retargeted row, and an explicit value wins.
    const destination = registryEntryForProviderDestination(provider);
    return {
      ...provider,
      apiKey: usableResolvedApiKey(provider.apiKey),
      ...(provider.dropResponsesReasoningItems === undefined && destination?.dropResponsesReasoningItems !== undefined
        ? { dropResponsesReasoningItems: destination.dropResponsesReasoningItems }
        : {}),
    };
  }
  const resolvedApiKey = usableResolvedApiKey(provider.apiKey);
  const staticModelCatalog = !providerSupportsLiveModelDiscovery(providerName, provider);
  const repairLegacyMimoFreeAuth = providerName === "mimo-free"
    && staticModelCatalog
    && (provider.authMode === undefined || provider.authMode === "local");
  const explicitKeyOverride = providerUsesKeyAuthOverride(registryEntry, provider, resolvedApiKey);
  const canonicalAuthMode = explicitKeyOverride
    ? "key"
    : repairLegacyMimoFreeAuth
      ? "key"
      : registryEntry.authKind === "forward" || registryEntry.authKind === "oauth"
        ? registryEntry.authKind
        : provider.authMode === "forward" ? undefined : provider.authMode;
  const staticPolicy = resolveModelPolicy({
    providerName,
    modelId: "__provider_static__",
    provider,
    registryEntry,
    transportMatchedRegistry: true,
    ...(canonicalAuthMode ? { effectiveAuth: { authMode: canonicalAuthMode } } : {}),
  }).provider;
  const reasoningEffortMap = staticPolicy.reasoningEffortMap;
  const modelReasoningEffortMap = staticPolicy.modelReasoningEffortMap;
  const modelReasoningEfforts = staticPolicy.modelReasoningEfforts;
  const modelDefaultReasoningEfforts = staticPolicy.modelDefaultReasoningEfforts;
  const modelContextWindows = staticPolicy.modelContextWindows;
  const modelInputModalities = staticPolicy.modelInputModalities;
  // Registry static headers are documented as applying to every upstream request, so they are
  // filled at resolve time rather than only at seed time: a config written before a header
  // existed, or one carrying any header of its own, would otherwise never receive it. User
  // headers win, matched case-insensitively so an override replaces rather than duplicates.
  const headers = staticPolicy.headers;
  const modelMaxInputTokens = staticPolicy.modelMaxInputTokens;
  const modelMaxOutputTokens = staticPolicy.modelMaxOutputTokens;
  const modelSupportsServiceTier = staticPolicy.modelSupportsServiceTier;
  const modelSupportsVerbosity = staticPolicy.modelSupportsVerbosity;
  const noVisionModels = staticPolicy.noVisionModels;
  const noReasoningModels = staticPolicy.noReasoningModels;
  const noTemperatureModels = staticPolicy.noTemperatureModels;
  const noTopPModels = staticPolicy.noTopPModels;
  const noStopModels = staticPolicy.noStopModels;
  const noPenaltyModels = staticPolicy.noPenaltyModels;
  const noJsonSchemaModels = staticPolicy.noJsonSchemaModels;
  const autoToolChoiceOnlyModels = staticPolicy.autoToolChoiceOnlyModels;
  const preserveReasoningContentModels = staticPolicy.preserveReasoningContentModels;
  const requiresReasoningPlaceholderModels = staticPolicy.requiresReasoningPlaceholderModels;
  const reasoningSplitModels = staticPolicy.reasoningSplitModels;
  const inlineThinkTagModels = staticPolicy.inlineThinkTagModels;
  const reasoningDetailsModels = staticPolicy.reasoningDetailsModels;
  const thinkingToggleModels = staticPolicy.thinkingToggleModels;
  const thinkingBudgetModels = staticPolicy.thinkingBudgetModels;
  const registryBaseUrlIsTemplate = /\{[^}]*\}/.test(registryEntry.baseUrl);
  const userBaseUrl = typeof provider.baseUrl === "string" ? provider.baseUrl.trim() : "";
  const userBaseUrlIsResolved = userBaseUrl.length > 0 && !/\{[^}]*\}/.test(userBaseUrl);
  if (registryEntry.allowBaseUrlOverride && !userBaseUrlIsResolved) {
    throw new Error(`Invalid baseUrl for provider "${providerName}": expected a nonblank URL without unresolved placeholders`);
  }
  // Registry template URLs are presets; local/self-hosted entries opt in explicitly.
  const baseUrl = (registryBaseUrlIsTemplate || registryEntry.allowBaseUrlOverride) && userBaseUrlIsResolved
    ? userBaseUrl
    : registryEntry.baseUrl;
  if (userBaseUrlIsResolved) warnIfBaseUrlDiscarded(providerName, userBaseUrl, baseUrl);
  assertProviderDestinationAllowed(providerName, { baseUrl, allowPrivateNetwork: provider.allowPrivateNetwork });

  const resolved: OcxProviderConfig = {
    ...provider,
    adapter: registryEntry.adapter,
    baseUrl,
    ...(provider.responsesPath === undefined && registryEntry.responsesPath !== undefined
      ? { responsesPath: registryEntry.responsesPath }
      : {}),
    ...(provider.chatCompletionsPath === undefined && registryEntry.chatCompletionsPath !== undefined
      ? { chatCompletionsPath: registryEntry.chatCompletionsPath }
      : {}),
    ...(provider.requiresAdjacentResponsesToolResults === undefined
      && registryEntry.requiresAdjacentResponsesToolResults !== undefined
      ? { requiresAdjacentResponsesToolResults: registryEntry.requiresAdjacentResponsesToolResults }
      : {}),
    ...(provider.requiresPairedResponsesToolResults === undefined
      && registryEntry.requiresPairedResponsesToolResults !== undefined
      ? { requiresPairedResponsesToolResults: registryEntry.requiresPairedResponsesToolResults }
      : {}),
    ...(provider.annotateEmptyToolOutputs === undefined
      && registryEntry.annotateEmptyToolOutputs !== undefined
      ? { annotateEmptyToolOutputs: registryEntry.annotateEmptyToolOutputs }
      : {}),
    ...(provider.fastWire === undefined && registryEntry.fastWire !== undefined
      ? {
        fastWire: cloneFastWire(registryEntry.fastWire),
      }
      : {}),
    ...(provider.supportsServiceTier === undefined && registryEntry.supportsServiceTier !== undefined
      ? { supportsServiceTier: registryEntry.supportsServiceTier }
      : {}),
    // An off Fast switch is a provider-wide denial on the runtime provider, so a Fast policy
    // resolved without the provider name still refuses (providerFastSwitchOff).
    ...(fastSwitchOff(provider, registryEntry) ? { supportsServiceTier: false } : {}),
    // Registry-only web-search capability: without this backfill a saved provider row reaches
    // the Responses adapter with the flag `undefined`, so the capability gate added in #2262
    // reads "unclassified" and forwards Codex's OpenAI-only `web_search` config fields. xAI
    // rejects the whole request before inference ("Argument not supported:
    // external_web_access"), which killed every routed Grok turn on the Responses lane.
    // enrichProviderFromRegistry() already fills this, but the request path resolves through
    // routedProviderConfig() and never called it.
    ...(provider.supportsOpenAiWebSearchToolFields === undefined
      && registryEntry.supportsOpenAiWebSearchToolFields !== undefined
      ? { supportsOpenAiWebSearchToolFields: registryEntry.supportsOpenAiWebSearchToolFields }
      : {}),
    ...(provider.supportsResponsesCustomTools === undefined && registryEntry.supportsResponsesCustomTools !== undefined
      ? { supportsResponsesCustomTools: registryEntry.supportsResponsesCustomTools }
      : {}),
    ...(provider.preserveResponsesReasoningContent === undefined && registryEntry.preserveResponsesReasoningContent !== undefined
      ? { preserveResponsesReasoningContent: registryEntry.preserveResponsesReasoningContent }
      : {}),
    ...(provider.preserveResponsesInputItemIds === undefined && registryEntry.preserveResponsesInputItemIds !== undefined
      ? { preserveResponsesInputItemIds: registryEntry.preserveResponsesInputItemIds }
      : {}),
    ...(provider.preserveResponsesMessageMetadata === undefined && registryEntry.preserveResponsesMessageMetadata !== undefined
      ? { preserveResponsesMessageMetadata: registryEntry.preserveResponsesMessageMetadata }
      : {}),
    ...(provider.dropResponsesReasoningItems === undefined && registryEntry.dropResponsesReasoningItems !== undefined
      ? { dropResponsesReasoningItems: registryEntry.dropResponsesReasoningItems }
      : {}),
    // The request path resolves through routedProviderConfig() and never calls
    // enrichProviderFromRegistry(), so a saved provider row written before the
    // registry learned this flag must be backfilled here or route.provider never
    // carries it and the showThinkingSummary opt-in stays dead.
    ...(provider.showThinkingSummary === undefined && registryEntry.showThinkingSummary !== undefined
      ? { showThinkingSummary: registryEntry.showThinkingSummary }
      : {}),
    // Registry-only client-facing repair policy (#938): fill only when the
    // saved provider has no explicit policy; clone so runtime never aliases
    // the registry constant.
    ...(provider.responsesItemIdRepair === undefined && registryEntry.responsesItemIdRepair
      ? {
        responsesItemIdRepair: {
          ...(registryEntry.responsesItemIdRepair.message ? { message: [...registryEntry.responsesItemIdRepair.message] } : {}),
          ...(registryEntry.responsesItemIdRepair.reasoning ? { reasoning: [...registryEntry.responsesItemIdRepair.reasoning] } : {}),
          ...(registryEntry.responsesItemIdRepair.repairMissingTerminalIds !== undefined
            ? { repairMissingTerminalIds: registryEntry.responsesItemIdRepair.repairMissingTerminalIds }
            : {}),
          ...(registryEntry.responsesItemIdRepair.repairInvalidIds !== undefined
            ? { repairInvalidIds: registryEntry.responsesItemIdRepair.repairInvalidIds }
            : {}),
        },
      }
      : {}),
    authMode: canonicalAuthMode,
    apiKey: resolvedApiKey,
    ...(staticModelCatalog ? { liveModels: false } : {}),
    ...(headers ? { headers } : {}),
    // Backfill the Google wire mode + Vertex project/location from the registry when the user
    // config omits them, so a minimal `google-vertex`/`google-antigravity` entry still routes
    // through the correct branch (CCA/Vertex) instead of falling back to AI Studio.
    ...(provider.googleMode === undefined && registryEntry.googleMode !== undefined ? { googleMode: registryEntry.googleMode } : {}),
    ...(provider.project === undefined && registryEntry.project !== undefined ? { project: registryEntry.project } : {}),
    ...(provider.location === undefined && registryEntry.location !== undefined ? { location: registryEntry.location } : {}),
    ...(provider.contextWindow === undefined && registryEntry.contextWindow !== undefined ? { contextWindow: registryEntry.contextWindow } : {}),
    ...((provider.reasoningEfforts === undefined || hasLegacyClinePassReasoningEfforts(providerName, provider))
      && registryEntry.reasoningEfforts !== undefined
      ? { reasoningEfforts: [...registryEntry.reasoningEfforts] }
      : {}),
    ...(provider.escapeBuiltinToolNames === undefined && registryEntry.escapeBuiltinToolNames !== undefined ? { escapeBuiltinToolNames: registryEntry.escapeBuiltinToolNames } : {}),
    ...(provider.keyOptional === undefined && registryEntry.keyOptional !== undefined ? { keyOptional: registryEntry.keyOptional } : {}),
    ...(provider.modelSuffixBracketStrip === undefined && registryEntry.modelSuffixBracketStrip !== undefined ? { modelSuffixBracketStrip: registryEntry.modelSuffixBracketStrip } : {}),
    // Scalar backfill: a persisted config created before the flag shipped inherits the registry
    // opt-in, while an explicit user `false` keeps overriding registry `true`.
    ...(provider.parallelToolCalls === undefined && registryEntry.parallelToolCalls !== undefined ? { parallelToolCalls: registryEntry.parallelToolCalls } : {}),
    ...(provider.promptCacheKey === undefined && registryEntry.promptCacheKey !== undefined ? { promptCacheKey: registryEntry.promptCacheKey } : {}),
    ...(provider.chatServiceTier === undefined && registryEntry.chatServiceTier !== undefined ? { chatServiceTier: registryEntry.chatServiceTier } : {}),
    ...(provider.openaiChatEofTolerance === undefined && registryEntry.openaiChatEofTolerance !== undefined
      ? { openaiChatEofTolerance: registryEntry.openaiChatEofTolerance }
      : {}),
    ...(provider.reasoningWireFormat === undefined && registryEntry.reasoningWireFormat !== undefined
      ? { reasoningWireFormat: registryEntry.reasoningWireFormat }
      : {}),
    ...(provider.defaultMaxOutputTokens === undefined && registryEntry.defaultMaxOutputTokens !== undefined
      ? { defaultMaxOutputTokens: registryEntry.defaultMaxOutputTokens }
      : {}),
    ...(modelContextWindows ? { modelContextWindows } : {}),
    ...(modelInputModalities ? { modelInputModalities } : {}),
    ...(modelMaxInputTokens ? { modelMaxInputTokens } : {}),
    ...(modelMaxOutputTokens ? { modelMaxOutputTokens } : {}),
    ...(modelSupportsServiceTier ? { modelSupportsServiceTier } : {}),
    ...(modelSupportsVerbosity ? { modelSupportsVerbosity } : {}),
    ...(modelReasoningEfforts ? { modelReasoningEfforts } : {}),
    ...(modelDefaultReasoningEfforts ? { modelDefaultReasoningEfforts } : {}),
    ...(reasoningEffortMap ? { reasoningEffortMap } : {}),
    ...(modelReasoningEffortMap ? { modelReasoningEffortMap } : {}),
    ...(noVisionModels ? { noVisionModels } : {}),
    ...(noReasoningModels ? { noReasoningModels } : {}),
    ...(noTemperatureModels ? { noTemperatureModels } : {}),
    ...(noTopPModels ? { noTopPModels } : {}),
    ...(noStopModels ? { noStopModels } : {}),
    ...(noPenaltyModels ? { noPenaltyModels } : {}),
    ...(noJsonSchemaModels ? { noJsonSchemaModels } : {}),
    ...(autoToolChoiceOnlyModels ? { autoToolChoiceOnlyModels } : {}),
    ...(preserveReasoningContentModels ? { preserveReasoningContentModels } : {}),
    ...(requiresReasoningPlaceholderModels ? { requiresReasoningPlaceholderModels } : {}),
    ...(reasoningSplitModels ? { reasoningSplitModels } : {}),
    ...(inlineThinkTagModels ? { inlineThinkTagModels } : {}),
    ...(reasoningDetailsModels ? { reasoningDetailsModels } : {}),
    ...(thinkingToggleModels ? { thinkingToggleModels } : {}),
    ...(thinkingBudgetModels ? { thinkingBudgetModels } : {}),
  };
  applyDirectReasoningEffortContracts(registryEntry, resolved, provider);
  return resolved;
}
