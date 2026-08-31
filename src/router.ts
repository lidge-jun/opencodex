import type { CodexAccountMode, OcxConfig, OcxProviderConfig } from "./types";
import {
  getCombo,
  isComboTargetInCooldown,
  preservesPhysicalComboProvider,
  targetKey,
  tryPickComboModel,
  type ComboPick,
} from "./combos";
import type { NormalizedComboConfig } from "./combos/types";
import { hasOwnProvider } from "./config/provider-name";
import { resolveEnvValue } from "./config";
import { assertProviderDestinationAllowed } from "./lib/destination-policy";
import { redactSecretString, redactUrlForLog } from "./lib/redact";
import {
  PROVIDER_REGISTRY,
  mergeRegistryStaticHeaders,
  providerCodexAccountMode,
  registryModelServiceTierCapabilityApplies,
} from "./providers/registry";
import { applyDirectReasoningEffortContracts, hasLegacyClinePassReasoningEfforts } from "./providers/derive";
import { cloneFastWire } from "./providers/fastwire";
import {
  providerMatchesRegistryTransportWithStaticGuards,
  providerSupportsLiveModelDiscovery,
} from "./providers/static-model-discovery";
import {
  isCanonicalOpenAiForwardProvider,
  LEGACY_CHATGPT_PROVIDER_ID,
  LEGACY_OPENAI_MULTI_PROVIDER_ID,
  OPENAI_API_PROVIDER_ID,
  OPENAI_CODEX_PROVIDER_ID,
} from "./providers/openai-tiers";
import { decodeRoutedModelIdOrThrow, encodeRoutedModelId } from "./providers/slug-codec";
import { resolveModelAlias } from "./providers/default-aliases";
import { resolveBlockedModelRedirect } from "./lib/shadow-call";
import { getStaleCached } from "./codex/model-cache";
import { codexAccountNamespaceEntries } from "./codex/account-namespaces";
import {
  buildRouteDecisionTrace,
  type RouteDecisionKind,
  type RouteDecisionTraceV1,
  type TraceCandidateInput,
} from "./routing/trace";
import { getRoutingProfile, resolvePolicyProfileId } from "./routing/profile";
import { evaluatePolicyProfile, type PolicyRequestEvidence } from "./routing/evaluator";
import { assemblePolicyCandidateEvidence } from "./routing/compatibility/assemble";

export class NoEligiblePolicyCandidateError extends Error {
  /** Evaluation trace (with per-candidate exclusions) when nothing qualified. */
  readonly trace?: RouteDecisionTraceV1;

  constructor(readonly profileId: string, trace?: RouteDecisionTraceV1) {
    super(`No eligible candidates for policy profile: ${profileId}`);
    this.name = "NoEligiblePolicyCandidateError";
    this.trace = trace;
  }
}

export interface RouteResult {
  providerName: string;
  provider: OcxProviderConfig;
  modelId: string;
  /** Which deterministic routing path produced this route (RI-01). */
  routeKind: RouteDecisionKind;
  /** Stable wire reason code for the selected route (RI-01). */
  routeReason: string;
  codexAccountMode?: CodexAccountMode;
  /** Exact account selected by an account-qualified native model. */
  codexAccountId?: string;
  /** Public namespace used by the account-qualified selector. */
  codexAccountNamespace?: string;
  combo?: ComboPick;
  /** Bounded route-decision trace (RI-01); never contains secrets. */
  routeDecision?: RouteDecisionTraceV1;
}

const MODEL_PROVIDER_PATTERNS: Array<{ providerNames: string[]; prefixes: string[] }> = [
  {
    providerNames: ["anthropic"],
    prefixes: [
    "claude-", "claude-sonnet-", "claude-opus-", "claude-haiku-",
    ],
  },
  {
    providerNames: ["groq"],
    prefixes: [
    "llama-", "mixtral-", "gemma-",
    ],
  },
];

/**
 * Known native model ids for a provider — the decode source for the Codex slug codec
 * (src/providers/slug-codec.ts). Union of static config ids, registry seeds, and the
 * last-known-good live /models cache (may be empty on a cold start; decode then passes
 * unknown ids through unchanged for an honest upstream error).
 */
export function knownModelIdsForProvider(
  provName: string,
  prov: OcxProviderConfig,
  config?: Pick<OcxConfig, "customModels">,
): string[] {
  const ids = new Set<string>();
  for (const id of prov.models ?? []) ids.add(id);
  if (prov.defaultModel) ids.add(prov.defaultModel);
  const registry = providerMatchesRegistryTransportWithStaticGuards(provName, prov)
    ? PROVIDER_REGISTRY.find(entry => entry.id === provName)
    : undefined;
  for (const id of registry?.models ?? []) ids.add(id);
  // Registry model-keyed hint maps double as known native ids (e.g. NVIDIA carries no
  // static models list but names `moonshotai/kimi-k2.6` in its effort/window maps).
  for (const map of [
    registry?.modelContextWindows,
    registry?.modelInputModalities,
    registry?.modelReasoningEfforts,
    registry?.modelDefaultReasoningEfforts,
    registry?.modelReasoningEffortMap,
    registry?.modelMaxOutputTokens,
    registry?.modelSupportsServiceTier,
    registry?.modelSupportsVerbosity,
  ]) {
    for (const id of Object.keys(map ?? {})) ids.add(id);
  }
  for (const cached of getStaleCached(provName) ?? []) ids.add(cached.id);
  for (const model of config?.customModels ?? []) {
    if (model.provider === provName && model.modelId) ids.add(model.modelId);
  }
  return [...ids];
}

// Merge registry-default effort maps under user values so built-in provider configs can
// carry real upstream aliases without a disk migration. User overrides win per-key.
function mergeRecord(
  seed: Record<string, string> | undefined,
  user: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!seed && !user) return undefined;
  return { ...(seed ?? {}), ...(user ?? {}) };
}

function mergeNestedRecord(
  seed: Record<string, Record<string, string>> | undefined,
  user: Record<string, Record<string, string>> | undefined,
): Record<string, Record<string, string>> | undefined {
  if (!seed && !user) return undefined;
  const out: Record<string, Record<string, string>> = {};
  for (const [key, value] of Object.entries(seed ?? {})) out[key] = { ...value };
  for (const [key, value] of Object.entries(user ?? {})) out[key] = { ...(out[key] ?? {}), ...value };
  return out;
}

function mergeStringArray(
  seed: string[] | undefined,
  user: string[] | undefined,
): string[] | undefined {
  if (!seed && !user) return undefined;
  return [...new Set([...(seed ?? []), ...(user ?? [])])];
}

function mergeRecordFill<T>(
  seed: Record<string, T> | undefined,
  user: Record<string, T> | undefined,
): Record<string, T> | undefined {
  if (!seed && !user) return undefined;
  return { ...(seed ?? {}), ...(user ?? {}) };
}

function mergePositiveNumberCaps(
  seed: Record<string, number> | undefined,
  user: Record<string, number> | undefined,
): Record<string, number> | undefined {
  if (!seed && !user) return undefined;
  const out = { ...(seed ?? {}) };
  for (const [key, value] of Object.entries(user ?? {})) {
    out[key] = typeof out[key] === "number" ? Math.min(out[key]!, value) : value;
  }
  return out;
}

function mergeStringArrayRecord(
  seed: Record<string, string[]> | undefined,
  user: Record<string, string[]> | undefined,
): Record<string, string[]> | undefined {
  if (!seed && !user) return undefined;
  const out: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(seed ?? {})) out[key] = [...value];
  for (const [key, value] of Object.entries(user ?? {})) out[key] = [...value];
  return out;
}

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
  const resolved = resolveEnvValue(apiKey);
  return typeof resolved === "string" && resolved.trim().length > 0 ? resolved : undefined;
}

export function routedProviderConfig(providerName: string, provider: OcxProviderConfig): OcxProviderConfig {
  const registryEntry = PROVIDER_REGISTRY.find(entry => entry.id === providerName);
  if (!registryEntry || !providerMatchesRegistryTransportWithStaticGuards(providerName, provider)) {
    assertProviderDestinationAllowed(providerName, provider);
    return { ...provider, apiKey: usableResolvedApiKey(provider.apiKey) };
  }
  const resolvedApiKey = usableResolvedApiKey(provider.apiKey);
  const staticModelCatalog = !providerSupportsLiveModelDiscovery(providerName, provider);
  const repairLegacyMimoFreeAuth = providerName === "mimo-free"
    && staticModelCatalog
    && (provider.authMode === undefined || provider.authMode === "local");
  const explicitKeyOverride = registryEntry.authKind === "oauth"
    && registryEntry.allowKeyAuthOverride === true
    && provider.authMode === "key"
    && resolvedApiKey !== undefined;
  const canonicalAuthMode = explicitKeyOverride
    ? "key"
    : repairLegacyMimoFreeAuth
      ? "key"
      : registryEntry.authKind === "forward" || registryEntry.authKind === "oauth"
        ? registryEntry.authKind
        : provider.authMode === "forward" ? undefined : provider.authMode;
  const reasoningEffortMap = mergeRecord(registryEntry.reasoningEffortMap, provider.reasoningEffortMap);
  const modelReasoningEffortMap = mergeNestedRecord(registryEntry.modelReasoningEffortMap, provider.modelReasoningEffortMap);
  const modelReasoningEfforts = mergeStringArrayRecord(registryEntry.modelReasoningEfforts, provider.modelReasoningEfforts);
  const modelDefaultReasoningEfforts = mergeRecordFill(registryEntry.modelDefaultReasoningEfforts, provider.modelDefaultReasoningEfforts);
  const modelContextWindows = providerName === OPENAI_API_PROVIDER_ID
    ? mergePositiveNumberCaps(registryEntry.modelContextWindows, provider.modelContextWindows)
    : mergeRecordFill(registryEntry.modelContextWindows, provider.modelContextWindows);
  const modelInputModalities = mergeRecordFill(registryEntry.modelInputModalities, provider.modelInputModalities);
  // Registry static headers are documented as applying to every upstream request, so they are
  // filled at resolve time rather than only at seed time: a config written before a header
  // existed, or one carrying any header of its own, would otherwise never receive it. User
  // headers win, matched case-insensitively so an override replaces rather than duplicates.
  const headers = mergeRegistryStaticHeaders(registryEntry.staticHeaders, provider.headers);
  const modelMaxInputTokens = providerName === OPENAI_API_PROVIDER_ID
    ? mergePositiveNumberCaps(registryEntry.modelMaxInputTokens, provider.modelMaxInputTokens)
    : mergeRecordFill(registryEntry.modelMaxInputTokens, provider.modelMaxInputTokens);
  const modelMaxOutputTokens = mergeRecordFill(registryEntry.modelMaxOutputTokens, provider.modelMaxOutputTokens);
  const modelSupportsServiceTier = mergeRecordFill(
    registryModelServiceTierCapabilityApplies(registryEntry, provider)
      ? registryEntry.modelSupportsServiceTier
      : undefined,
    provider.modelSupportsServiceTier,
  );
  const modelSupportsVerbosity = mergeRecordFill(
    registryEntry.modelSupportsVerbosity,
    provider.modelSupportsVerbosity,
  );
  const noVisionModels = mergeStringArray(registryEntry.noVisionModels, provider.noVisionModels);
  const noReasoningModels = mergeStringArray(registryEntry.noReasoningModels, provider.noReasoningModels);
  const noTemperatureModels = mergeStringArray(registryEntry.noTemperatureModels, provider.noTemperatureModels);
  const noTopPModels = mergeStringArray(registryEntry.noTopPModels, provider.noTopPModels);
  const noPenaltyModels = mergeStringArray(registryEntry.noPenaltyModels, provider.noPenaltyModels);
  const autoToolChoiceOnlyModels = mergeStringArray(registryEntry.autoToolChoiceOnlyModels, provider.autoToolChoiceOnlyModels);
  const preserveReasoningContentModels = mergeStringArray(registryEntry.preserveReasoningContentModels, provider.preserveReasoningContentModels);
  const requiresReasoningPlaceholderModels = mergeStringArray(registryEntry.requiresReasoningPlaceholderModels, provider.requiresReasoningPlaceholderModels);
  const reasoningSplitModels = mergeStringArray(registryEntry.reasoningSplitModels, provider.reasoningSplitModels);
  const thinkingToggleModels = mergeStringArray(registryEntry.thinkingToggleModels, provider.thinkingToggleModels);
  const thinkingBudgetModels = mergeStringArray(registryEntry.thinkingBudgetModels, provider.thinkingBudgetModels);
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
    ...(provider.requiresAdjacentResponsesToolResults === undefined
      && registryEntry.requiresAdjacentResponsesToolResults !== undefined
      ? { requiresAdjacentResponsesToolResults: registryEntry.requiresAdjacentResponsesToolResults }
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
    ...(noPenaltyModels ? { noPenaltyModels } : {}),
    ...(autoToolChoiceOnlyModels ? { autoToolChoiceOnlyModels } : {}),
    ...(preserveReasoningContentModels ? { preserveReasoningContentModels } : {}),
    ...(requiresReasoningPlaceholderModels ? { requiresReasoningPlaceholderModels } : {}),
    ...(reasoningSplitModels ? { reasoningSplitModels } : {}),
    ...(thinkingToggleModels ? { thinkingToggleModels } : {}),
    ...(thinkingBudgetModels ? { thinkingBudgetModels } : {}),
  };
  applyDirectReasoningEffortContracts(registryEntry, resolved, provider);
  return resolved;
}

function activeProviderEntries(config: OcxConfig): [string, OcxProviderConfig][] {
  return Object.entries(config.providers)
    .filter(([name, provider]) => name !== LEGACY_CHATGPT_PROVIDER_ID && provider.disabled !== true);
}

export class NoEnabledOpenAiProviderError extends Error {
  constructor(modelId: string) {
    super(
      `Model ${modelId} requires the canonical openai provider. `
      + `Run: ocx provider add openai && ocx sync && ocx restart`,
    );
    this.name = "NoEnabledOpenAiProviderError";
  }
}

/**
 * One immutable selection trace for a combo request: built once from the
 * initial pick, before any child dispatch. Fallback execution stays in the
 * usage entry's `attempts[]`; the trace never changes after selection.
 */
export function comboRouteDecisionTrace(
  config: OcxConfig,
  comboId: string,
  pick: ComboPick,
  requestedModel: string,
): RouteDecisionTraceV1 {
  const combo = getCombo(config, comboId);
  return buildRouteDecisionTrace({
    requestedModel,
    routeKind: "combo",
    selected: {
      provider: pick.target.provider,
      model: pick.target.model,
      reason: "combo-pick",
      candidateIndex: pick.targetIndex,
      ...(combo
        ? { tieBreak: combo.strategy }
        : {}),
    },
    candidates: combo ? comboRouteCandidates(config, pick, combo) : undefined,
  });
}

// Codex uses a small number of control-plane model ids that are not part of the public GPT/o
// naming families. Keep this exact: a broad `codex-*` rule could capture a third-party model.
const CODEX_INTERNAL_OPENAI_MODELS = new Set(["codex-auto-review"]);

function isBareOpenAiFamilyModel(modelId: string): boolean {
  return !modelId.includes("/")
    && (/^(?:gpt-|o1-|o3-|o4-)/.test(modelId) || CODEX_INTERNAL_OPENAI_MODELS.has(modelId));
}

function routeResult(
  config: OcxConfig | undefined,
  providerName: string,
  provider: OcxProviderConfig,
  modelId: string,
  routeKind: RouteDecisionKind,
  routeReason: string,
): RouteResult {
  const redirected = resolveBlockedModelRedirect(config, modelId);
  const effectiveModelId = redirected ?? modelId;
  const effectiveRouteReason = redirected ? "blocked-model-redirect" : routeReason;
  const codexAccountMode = providerCodexAccountMode(providerName, provider);
  return {
    providerName,
    provider: routedProviderConfig(providerName, provider),
    modelId: effectiveModelId,
    routeKind,
    routeReason: effectiveRouteReason,
    ...(codexAccountMode ? { codexAccountMode } : {}),
  };
}

/**
 * Candidate evidence for a combo route: every configured target with its
 * selection-time eligibility and exclusion reasons. Purely observational; the
 * pick already happened and this never re-selects.
 */
function comboRouteCandidates(
  config: OcxConfig,
  pick: NonNullable<RouteResult["combo"]>,
  combo: NormalizedComboConfig,
): TraceCandidateInput[] {
  const now = Date.now();
  return combo.targets.map((target, index) => {
    const key = targetKey(target);
    const provider = config.providers[target.provider];
    const configured = provider !== undefined;
    const enabled = configured && provider.disabled !== true;
    const inCooldown = isComboTargetInCooldown(pick.comboId, target, now);
    const isSelected = index === pick.targetIndex;
    // The pick's `attempted` list includes the winner itself; only non-selected
    // targets can be "already-attempted" (fallback picks exclude earlier tries).
    const alreadyAttempted = !isSelected && pick.attempted.includes(key);
    const exclusions: TraceCandidateInput["exclusions"] = [];
    if (!configured) exclusions.push({ code: "unconfigured" });
    if (configured && !enabled) exclusions.push({ code: "disabled" });
    if (inCooldown) exclusions.push({ code: "cooldown" });
    if (isSelected && inCooldown) exclusions.push({ code: "selected-despite-cooldown" });
    if (!isSelected && alreadyAttempted && exclusions.length === 0) {
      exclusions.push({ code: "already-attempted" });
    }
    if (!isSelected && exclusions.length === 0) exclusions.push({ code: "not-selected" });
    return {
      provider: target.provider,
      model: target.model,
      eligible: enabled && !inCooldown && !alreadyAttempted,
      exclusions,
    };
  });
}

function routeModelInternal(
  config: OcxConfig,
  modelId: string,
  bypassCombos: boolean,
  policyEvidence?: PolicyRequestEvidence,
): RouteResult {
  const slash = modelId.indexOf("/");
  // Policy namespace is system-reserved: an explicit `policy/<id>` or a
  // configured profile alias executes the policy evaluator and routes the
  // selected candidate. Only explicit requests reach this branch; concrete
  // recursive targets skip policy resolution entirely (bypassCombos) so an
  // alias matching a selected candidate can never recurse, and a
  // `policy/<id>` without a configured profile falls through to normal
  // provider/default resolution instead of failing.
  const policyId = !bypassCombos ? resolvePolicyProfileId(config, modelId) : null;
  const profile = policyId ? getRoutingProfile(config, policyId) : undefined;
  if (profile && policyId) {
    // One clock read per decision keeps candidate evidence, exclusions, and
    // scores mutually consistent and reproducible.
    const now = Date.now();
    const candidateEvidence = assemblePolicyCandidateEvidence(config, profile, now, {
      routedProviderConfig,
    });
    const evaluation = evaluatePolicyProfile(config, policyId, policyEvidence ?? {}, candidateEvidence, now);
    if (evaluation.selectedIndex === null) {
      throw new NoEligiblePolicyCandidateError(policyId, evaluation.trace);
    }
    const selected = evaluation.candidates[evaluation.selectedIndex]!;
    const concrete = `${selected.provider}/${selected.model}`;
    const routed = routeModelInternal(config, concrete, true);
    return {
      ...routed,
      routeKind: "policy" as const,
      routeReason: "policy-selected",
      routeDecision: evaluation.trace,
    };
  }
  if (slash > 0) {
    const namespace = modelId.slice(0, slash);
    const binding = codexAccountNamespaceEntries(config)
      .find(([candidate]) => candidate === namespace);
    if (binding) {
      const nativeModelId = modelId.slice(slash + 1);
      if (!isBareOpenAiFamilyModel(nativeModelId)) {
        throw new Error(`Codex account namespace ${namespace} only supports native OpenAI model ids`);
      }
      const provider = config.providers[OPENAI_CODEX_PROVIDER_ID];
      if (!provider || provider.disabled === true) {
        throw new NoEnabledOpenAiProviderError(nativeModelId);
      }
      // Registry routing backfills an omitted authMode on the built-in OpenAI row to forward.
      // Mirror only that default here; explicit non-forward modes still fail closed.
      const providerForCanonicalCheck = provider.authMode === undefined
        ? { ...provider, authMode: "forward" as const }
        : provider;
      if (!isCanonicalOpenAiForwardProvider(providerForCanonicalCheck)) {
        throw new NoEnabledOpenAiProviderError(nativeModelId);
      }
      return {
        ...routeResult(config, OPENAI_CODEX_PROVIDER_ID, provider, nativeModelId, "explicit-account", "account-namespace"),
        // Exact account injection uses the pool credential machinery even when the canonical
        // provider is globally Direct. The fixed id bypasses pool selection entirely.
        codexAccountMode: "pool",
        codexAccountId: binding[1],
        codexAccountNamespace: namespace,
      };
    }
  }

  if (!bypassCombos && !preservesPhysicalComboProvider(config)) {
    const combo = tryPickComboModel(config, modelId);
    if (combo) {
      const concrete = `${combo.target.provider}/${combo.target.model}`;
      // The selected target is already a concrete provider/model reference. Resolve it without
      // consulting combo aliases again, otherwise an alias that shadows the target can recurse.
      const routed = routeModelInternal(config, concrete, true, undefined);
      return { ...routed, combo, routeKind: "combo" as const, routeReason: "combo-pick" };
    }
  }

  // 0. Explicit "<provider>/<model>" namespace (e.g. "opencode-go/deepseek-v4-pro").
  //    Only triggers when the prefix matches a CONFIGURED provider, so genuine
  //    slash-containing model ids (e.g. "anthropic/claude-...") fall through when
  //    no such provider exists.
  if (slash > 0) {
    const requestedProvider = modelId.slice(0, slash);
    const provName = hasOwnProvider(config.providers, requestedProvider)
      ? requestedProvider
      : Object.entries(config.providers).find(([, provider]) =>
        typeof provider.alias === "string" && provider.alias.toLowerCase() === requestedProvider.toLowerCase())?.[0];
    if (!provName) {
      // A genuine slash-containing native model id still falls through unchanged.
    } else {
    if (provName === LEGACY_CHATGPT_PROVIDER_ID || provName === LEGACY_OPENAI_MULTI_PROVIDER_ID) {
      throw new Error(`No provider configured for model: ${modelId}`);
    }
    if (hasOwnProvider(config.providers, provName)) {
      const prov = config.providers[provName];
      if (prov.disabled === true) throw new Error(`Provider is disabled: ${provName}`);
      const known = knownModelIdsForProvider(provName, prov, config);
      // Self-namespaced native id — the vendor segment equals the provider id, so the FULL ref is
      // itself a known model (e.g. orcarouter/auto). Route it whole instead of stripping to the
      // remainder, which would send a bare `auto` the upstream cannot resolve.
      if (known.includes(modelId)) {
        return routeResult(config, provName, prov, modelId, "explicit-provider", "explicit-provider-namespace");
      }
      // Codex-facing alias ids (`provider/vendor-model`) decode back to the native
      // slash id via an exact known-id lookup; raw full-slash selectors keep working.
      const requestedModel = modelId.slice(slash + 1);
      const decoded = decodeRoutedModelIdOrThrow(requestedModel, known);
      const nativeModel = known.includes(decoded)
        ? decoded
        : resolveModelAlias(config, prov, known, requestedModel) ?? decoded;
      return routeResult(
        config,
        provName,
        prov,
        nativeModel,
        "explicit-provider",
        "explicit-provider-namespace",
      );
    }
    }
  }

  if (isBareOpenAiFamilyModel(modelId)) {
    const provider = config.providers[OPENAI_CODEX_PROVIDER_ID];
    if (provider && provider.disabled !== true) {
      return routeResult(config, OPENAI_CODEX_PROVIDER_ID, provider, modelId, "native", "native-family");
    }
    throw new NoEnabledOpenAiProviderError(modelId);
  }

  for (const [provName, prov] of activeProviderEntries(config)) {
    if (prov.defaultModel === modelId
      || (typeof prov.defaultModel === "string" && encodeRoutedModelId(prov.defaultModel) === modelId)) {
      return routeResult(config, provName, prov, prov.defaultModel as string, "explicit-provider", "configured-default-model");
    }
  }

  const patternRoute = routeByKnownModelPattern(config, modelId);
  if (patternRoute) return patternRoute;

  for (const [provName, prov] of activeProviderEntries(config)) {
    if (prov.models && Array.isArray(prov.models)) {
      const hit = (prov.models as string[]).find(id => id === modelId || encodeRoutedModelId(id) === modelId);
      if (hit !== undefined) {
        return routeResult(config, provName, prov, hit, "explicit-provider", "configured-model-list");
      }
    }
  }

  const aliasMatches: Array<{ provider: string; model: string; qualified: string }> = [];
  for (const [provName, prov] of activeProviderEntries(config)) {
    const known = knownModelIdsForProvider(provName, prov, config);
    const native = resolveModelAlias(config, prov, known, modelId);
    if (native) aliasMatches.push({
      provider: provName,
      model: native,
      qualified: `${prov.alias || provName}/${modelId}`,
    });
  }
  if (aliasMatches.length > 1) {
    throw new Error(`model alias '${modelId}' is ambiguous: ${aliasMatches.map(match => match.qualified).sort().join(", ")}`);
  }
  if (aliasMatches[0]) {
    const match = aliasMatches[0];
    return routeResult(config, match.provider, config.providers[match.provider], match.model, "explicit-provider", "model-alias");
  }

  if (config.defaultProvider === LEGACY_CHATGPT_PROVIDER_ID) {
    throw new Error(`No provider configured for model: ${modelId}`);
  }
  if (hasOwnProvider(config.providers, config.defaultProvider)) {
    const defaultProv = config.providers[config.defaultProvider];
    if (defaultProv.disabled === true) throw new Error(`Default provider is disabled: ${config.defaultProvider}`);
    return routeResult(config, config.defaultProvider, defaultProv, modelId, "default-provider", "default-provider");
  }

  throw new Error(`No provider configured for model: ${modelId}`);
}

export function routeModel(
  config: OcxConfig,
  modelId: string,
  policyEvidence?: PolicyRequestEvidence,
): RouteResult {
  const route = routeModelInternal(config, modelId, false, policyEvidence);
  // Policy routes carry a full evaluation trace already; never rebuild it.
  if (route.routeDecision) return route;
  const accountRef = route.codexAccountNamespace;
  const combo = route.combo ? getCombo(config, route.combo.comboId) : undefined;
  route.routeDecision = buildRouteDecisionTrace({
    requestedModel: modelId,
    routeKind: route.routeKind,
    selected: {
      provider: route.providerName,
      model: route.modelId,
      ...(accountRef ? { accountRef } : {}),
      reason: route.routeReason,
      ...(route.combo ? { candidateIndex: route.combo.targetIndex } : {}),
      ...(combo
        ? { tieBreak: combo.strategy }
        : {}),
    },
    candidates: route.routeKind === "combo" && route.combo && combo
      ? comboRouteCandidates(config, route.combo, combo)
      : undefined,
  });
  return route;
}

/** Resolve a combo-selected provider/model target without consulting public combo aliases again. */
export function routeConcreteModel(config: OcxConfig, modelId: string): RouteResult {
  return routeModelInternal(config, modelId, true, undefined);
}

function routeByKnownModelPattern(config: OcxConfig, modelId: string): RouteResult | undefined {
  for (const { providerNames, prefixes } of MODEL_PROVIDER_PATTERNS) {
    if (prefixes.some(prefix => modelId.startsWith(prefix))) {
      const matchingProvider = Object.entries(config.providers).find(
        ([name, prov]) => prov.disabled !== true && providerNames.some(providerName => name === providerName || name.startsWith(`${providerName}-`))
      );
      if (matchingProvider) {
        const [provName, prov] = matchingProvider;
        return routeResult(config, provName, prov, modelId, "explicit-provider", "model-pattern");
      }
      // Deliberately no "first provider with an Anthropic adapter" fallback here. Picking by
      // object insertion order, without checking `models`, `selectedModels`, `disabledModels` or
      // discovery state, silently moves a request onto a provider the operator never chose, with
      // its own privacy and billing consequences (#1697). A classifier turn that needs a specific
      // target gets it from operator-declared `claudeCode.classifierModel` / `classifierFallbacks`.
    }
  }
  return undefined;
}
