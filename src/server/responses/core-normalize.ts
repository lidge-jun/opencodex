import { sanitizeLogMetadataString } from "../../lib/redact";
import type { RouteResult } from "../../router";
import type { InboundWire } from "../../providers/registry";
import { resolveWireProtocolOverride } from "../adapter-resolve";
import type { OcxConfig, OcxParsedRequest, OcxProviderConfig, TierDecision } from "../../types";
import {
  resolveCodexModelEntitlements,
  entitledCodexAccountIdsForModel,
} from "../../codex/model-entitlements";
import type { SubagentModelEligibleAccountIds } from "../../codex/subagent-model-fallback";
import { subagentFallbackNeedsModelEntitlements } from "../../codex/subagent-model-fallback";
import { MAIN_CODEX_ACCOUNT_ID } from "../../codex/main-account";
import type { RequestLogContext } from "../request-log";
import type { HandleResponsesOptions } from "./core-options";
import { prepareEffortNormalization } from "../effort-policy";
import { resolveOpenCodeGoTransport } from "../../providers/opencode-go-transport";
import { getOrAllocateRequestSessionLane } from "../request-log-conversation";
import { shouldPreparePlaintextV2AgentMessages } from "../../responses/plaintext-v2-agent-messages";
import { isCanonicalOpenAiForwardProvider } from "../../providers/openai-tiers";
import { applyOpenAiVirtualModel } from "../../providers/openai-virtual-models";
import {
  fastPolicyForModel,
  serviceTierSupportFromPolicy,
  SERVICE_TIER_ADAPTERS,
} from "../../providers/service-tier";
import {
  tierObservationContext,
  decideTier,
  tierValueAfterDecision,
  canonicalFastTierMarker,
} from "../../providers/fastwire";
import { multiAgentGuidanceText, injectDeveloperMessage, collabSurface } from "./collaboration";
import { multiAgentGuidanceEnabled } from "../../config";
import { isInjectionDebugEnabled } from "../../lib/debug-settings";
import { injectionDebugLog } from "../../lib/injection-debug-log";
import { recordAttemptRequestedEffort } from "../request-log";
import type { ResolvedFastPolicy } from "../../providers/fastwire";

export const MAX_FAST_WIRE_CAPABILITY_WARNINGS = 256;

export const warnedFastWireCapabilityGaps = new Set<string>();


export function warnFastWireCapabilityGap(providerName: string, modelId: string): void {
  const safeProvider = sanitizeLogMetadataString(providerName) ?? "unknown";
  const safeModel = sanitizeLogMetadataString(modelId) ?? "unknown";
  const key = `${safeProvider}\0${safeModel}`;
  if (warnedFastWireCapabilityGaps.has(key)) return;
  if (warnedFastWireCapabilityGaps.size >= MAX_FAST_WIRE_CAPABILITY_WARNINGS) {
    const oldest = warnedFastWireCapabilityGaps.values().next().value;
    if (oldest !== undefined) warnedFastWireCapabilityGaps.delete(oldest);
  }
  warnedFastWireCapabilityGaps.add(key);
  console.warn(
    `[opencodex] Fast policy for ${safeProvider}/${safeModel} has service-tier capability but no Fast wire; preserving only caller-permitted tier behavior`,
  );
}


/**
 * Keep this trust boundary deliberately narrow: only a key-auth Responses route may consume
 * opaque child-task ciphertext, and the model's final wire override must still be Responses.
 * Callers keep combo attempts on their existing native-only recovery/fail-closed behavior.
 */
export function canPassThroughEncryptedV2AgentTask(
  route: RouteResult,
  inboundWire: InboundWire,
): boolean {
  if (route.combo !== undefined) return false;
  const provider = route.provider;
  if (
    inboundWire !== "responses"
    || provider.allowEncryptedV2AgentTasks !== true
    || (provider.authMode ?? "key") !== "key"
  ) return false;

  return resolveWireProtocolOverride(
    route.providerName,
    route.modelId,
    provider,
    inboundWire,
    route.staticPolicy,
  ).adapter === "openai-responses";
}


export async function resolveSubagentFallbackModelEligibility(args: {
  config: OcxConfig;
  fallbackChain: readonly string[] | null;
  nativeMainReadsForbidden: boolean;
  resolver: typeof resolveCodexModelEntitlements;
}): Promise<SubagentModelEligibleAccountIds | undefined> {
  if (!subagentFallbackNeedsModelEntitlements(args.fallbackChain, args.config)) return undefined;
  const excludeAccountIds = args.nativeMainReadsForbidden
    ? new Set([MAIN_CODEX_ACCOUNT_ID])
    : undefined;
  const snapshot = await args.resolver(args.config, { excludeAccountIds });
  return (modelId) => {
    const entitledAccountIds = entitledCodexAccountIdsForModel(snapshot, modelId);
    return entitledAccountIds
      ? new Set([...entitledAccountIds].filter(accountId => !excludeAccountIds?.has(accountId)))
      : undefined;
  };
}


/**
 * Apply every route-dependent request mutation against the final selected route.
 * Must run only after subagent fallback has settled the model/provider.
 */
export async function applyFinalRouteRequestNormalization(args: {
  parsed: OcxParsedRequest;
  route: RouteResult;
  config: OcxConfig;
  req: Request;
  logCtx: RequestLogContext;
  inboundWire: InboundWire;
  inboundTransport?: "websocket";
  claudeGoAffinity?: HandleResponsesOptions["claudeGoAffinity"];
}): Promise<void> {
  const { parsed, route, config, req, logCtx, inboundWire, inboundTransport } = args;
  const effortSelector = prepareEffortNormalization(parsed, route);

  // Only Anthropic message routes retain the Codex-facing selector. Other providers must keep
  // their existing response.model contract even when their public and wire model ids differ.
  const responseModelId = parsed.modelId;
  const preserveAnthropicResponseModel = route.providerName === "anthropic"
    || route.provider.adapter === "anthropic";
  const finalSelectedModelId = route.modelId;
  const virtualModel = applyOpenAiVirtualModel(parsed, route, logCtx, inboundWire);

  // Apply the routed model id upstream: routing may strip a "<provider>/" namespace.
  if (route.modelId !== parsed.modelId) {
    if (parsed._rawBody && typeof parsed._rawBody === "object") {
      (parsed._rawBody as { model?: string }).model = route.modelId;
    }
    parsed.modelId = route.modelId;
  }
  // Transport-neutral reliability policy (#875): applies to any Responses
  // upstream whose final adapter is openai-responses, not only WS turns.
  const responsesUpstreamStreaming = route.staticPolicy.model.responsesUpstreamStreaming;

  // Preserve the routed destination for Go recognition, then settle the wire before
  // deriving protocol-scoped affinity. Recognition must not inspect the flipped adapter.
  const routedProvider = route.provider;
  const wireProvider = resolveWireProtocolOverride(
    route.providerName,
    route.modelId,
    routedProvider,
    inboundWire,
    route.staticPolicy,
  );
  route.provider = resolveOpenCodeGoTransport(wireProvider,
    args.claudeGoAffinity ? args.claudeGoAffinity.sessionLane : getOrAllocateRequestSessionLane(req),
    routedProvider);
  parsed._plaintextV2AgentMessages = shouldPreparePlaintextV2AgentMessages({
    enabled: config.plaintextV2AgentMessages === true,
    inboundWire,
    canonicalChatGpt: isCanonicalOpenAiForwardProvider(route.provider),
    requestBody: parsed._rawBody,
  });
  // Recompute from the original wire preference on every route, including fallback.
  // A provider default never converts raw reasoning into a summary.
  if (inboundWire === "responses" && parsed._rawBody) {
    const summary = (parsed._rawBody as { reasoning?: { summary?: unknown } }).reasoning?.summary;
    parsed.options.hideThinkingSummary = summary === "none"
      || (!summary && route.provider.showThinkingSummary !== true);
  }
  if (preserveAnthropicResponseModel) parsed._responseModelId = responseModelId;
  logCtx.model = virtualModel?.selectedModelId ?? route.modelId;
  logCtx.provider = route.providerName;
  logCtx.providerAdapter = route.provider.adapter;
  logCtx.routeDecision = route.routeDecision;
  if (route.routeReason === "model-alias" || route.modelId !== responseModelId && responseModelId.includes("/")) logCtx.requestedAlias = responseModelId;

  if (responsesUpstreamStreaming === false && route.provider.adapter === "openai-responses") {
    parsed.stream = false;
    if (parsed._rawBody && typeof parsed._rawBody === "object") {
      (parsed._rawBody as Record<string, unknown>).stream = false;
    }
  }

  // Generic Responses clients (e.g. AI-SDK apps) omit `store`, but the canonical
  // forward Codex backend rejects a native request without an explicit store:false.
  // Default it only there — every other Responses upstream (key-auth providers and
  // custom forward gateways) intentionally keeps the omitted-store server-side
  // default for previous_response_id reuse — and never override an explicit value.
  if (
    isCanonicalOpenAiForwardProvider(route.provider)
    && parsed._rawBody && typeof parsed._rawBody === "object"
    && (parsed._rawBody as Record<string, unknown>).store === undefined
  ) {
    (parsed._rawBody as Record<string, unknown>).store = false;
  }

  if (parsed._responseModelId !== undefined && parsed._responseModelId !== parsed.modelId) {
    logCtx.resolvedModel = route.modelId;
    logCtx.preserveResolvedModelFromRoute = true;
  }

  // Resolve Fast policy after the final route/wire settles. A1 records the decision on parsed
  // options; the Responses adapter owns the final outbound body write.
  const fastPolicy = fastPolicyForModel(
    route.provider,
    route.modelId,
    route.providerName,
    inboundWire,
    config.providers[route.providerName],
  );
  const modelServiceTierSupport = serviceTierSupportFromPolicy(fastPolicy);
  const callerTier = parsed.options.serviceTier;
  // The ChatGPT-internal Codex backend echoes `service_tier: "default"` even on turns it
  // scheduled as priority, so its echo cannot confirm OR deny Fast. Believing it reported every
  // Fast request as `response-declined` (#2558). The public API's echo stays authoritative.
  parsed.options.tierObservation = tierObservationContext(
    fastPolicy,
    config.fastMode,
    callerTier,
    isCanonicalOpenAiForwardProvider(route.provider) ? false : undefined,
  );
  parsed.options.tierDecision = decideTier(fastPolicy, config.fastMode, callerTier);
  parsed.options.serviceTier = tierValueAfterDecision(parsed.options.tierDecision, callerTier);
  if (fastPolicy.capability === true && fastPolicy.fastWire === null) {
    warnFastWireCapabilityGap(route.providerName, route.modelId);
  }
  applyServiceTierGate(
    route.provider,
    parsed._rawBody,
    parsed.options,
    route.modelId,
    route.providerName,
    inboundWire,
    fastPolicy,
  );
  if (modelServiceTierSupport === false) {
    logCtx.requestedServiceTier = undefined;
    logCtx.requestedSpeedLabel = undefined;
  }

  {
    const guidance = await multiAgentGuidanceText(parsed, {
      multiAgentGuidanceEnabled: config.multiAgentGuidanceEnabled,
      codexAccountNamespace: route.codexAccountNamespace,
      injectionModel: config.injectionModel,
      injectionEffort: config.injectionEffort,
      subagentModels: config.subagentModels,
      subagentModelFallback: config.subagentModelFallback,
      injectionPrompt: config.injectionPrompt,
    });
    if (guidance) {
      injectDeveloperMessage(parsed, guidance);
      if (isInjectionDebugEnabled()) {
        injectionDebugLog(`[opencodex] ${route.modelId}: multi-agent guidance injected (surface=${collabSurface(parsed)}, guidanceEnabled=${multiAgentGuidanceEnabled(config)}, ${guidance.length} chars)`);
      }
    } else if (isInjectionDebugEnabled() && collabSurface(parsed) !== null) {
      injectionDebugLog(`[opencodex] ${route.modelId}: collab surface=${collabSurface(parsed)}, guidance silent (effort=${parsed.options.reasoning ?? "unset"}, injectionModel=${config.injectionModel ?? "unset"})`);
    }
  }

  {
    const { applyPinnedEffort } = await import("../effort-policy");
    const pinned = applyPinnedEffort(parsed, route, config, effortSelector);
    if (pinned) {
      logCtx.requestedEffort = pinned.from ? `${pinned.from}->${pinned.to}` : pinned.to;
      if (isInjectionDebugEnabled()) {
        injectionDebugLog(`[opencodex] ${route.modelId}: pinned reasoning effort applied (${pinned.from ?? "none"} -> ${pinned.to})`);
      }
    }
  }

  {
    const { applyEffortCap, effortCapAppliesTo, supportedLadderFor } = await import("../effort-policy");
    const surface = collabSurface(parsed);
    if (effortCapAppliesTo(surface, req.headers, config, parsed._compactionRequest === true)) {
      const capped = applyEffortCap(parsed, req.headers, config, supportedLadderFor(route));
      if (capped) {
        logCtx.requestedEffort = `${capped.from}->${capped.to}`;
        if (isInjectionDebugEnabled()) {
          injectionDebugLog(`[opencodex] ${route.modelId}: effort cap applied (${capped.from} -> ${capped.to}, ${capped.subagent ? "sub-agent" : "main"} turn)`);
        }
      }
    } else if (isInjectionDebugEnabled() && (config.effortCap || config.subagentEffortCap)) {
      injectionDebugLog(`[opencodex] ${route.modelId}: effort cap skipped (surface=${surface ?? "none"}, v2 feature only)`);
    }
  }

  {
    const { nativeEffortClamp, shouldApplyNativeEffortClamp } = await import("../../codex/catalog");
    const clamped = shouldApplyNativeEffortClamp(route.providerName, route.provider, finalSelectedModelId)
      ? nativeEffortClamp(route.modelId, parsed.options.reasoning)
      : null;
    if (clamped) {
      parsed.options.reasoning = clamped;
      const raw = parsed._rawBody as { reasoning?: { effort?: string } } | undefined;
      if (raw?.reasoning && typeof raw.reasoning === "object") raw.reasoning.effort = clamped;
      logCtx.requestedEffort = `${logCtx.requestedEffort ?? "max"}->${clamped}`;
    }
  }
  recordAttemptRequestedEffort(logCtx);
  logCtx.modelSupportsServiceTier = SERVICE_TIER_ADAPTERS.has(route.provider.adapter)
    ? modelServiceTierSupport
    : undefined;
}


/**
 * Service-tier capability gate, applied after the final route/wire is settled. A
 * provider explicitly documented as NOT supporting `service_tier` must never
 * receive it: strip the field and clear the logging value even when the caller
 * supplied one (fail closed). A policy-produced canonical Fast decision has
 * already passed capability validation and cannot be vetoed by Chat's caller
 * forwarding permission. On unclassified routes every caller tier remains subject
 * to `forwardCallerTier`.
 */
export function applyServiceTierGate(
  provider: OcxProviderConfig,
  rawBody: unknown,
  options: { serviceTier?: string; tierDecision?: TierDecision },
  modelId?: string,
  providerName?: string,
  inbound: InboundWire = "responses",
  resolvedPolicy?: ResolvedFastPolicy,
): void {
  // A direct unit caller without a model id retains the historical tri-state behavior for
  // adapters outside the OpenAI service-tier family. Once a model is known, resolve the final
  // model adapter as well: an explicit override to Anthropic (or another non-OpenAI wire) must
  // not carry a caller-supplied `service_tier` through a route that cannot forward it.
  if (modelId === undefined && !SERVICE_TIER_ADAPTERS.has(provider.adapter)) return;
  const policy = modelId === undefined
    ? undefined
    : resolvedPolicy ?? fastPolicyForModel(provider, modelId, providerName, inbound);
  const forwardCallerTier = modelId === undefined
    ? provider.supportsServiceTier !== false
    : policy!.forwardCallerTier;
  const rawTier = rawBody && typeof rawBody === "object"
    ? (rawBody as Record<string, unknown>).service_tier
    : undefined;
  const canonicalDecision = options.tierDecision?.kind === "set";
  const callerTierIsForeign = rawTier !== undefined
    && (typeof rawTier !== "string" || canonicalFastTierMarker(rawTier) === undefined);
  const dropForeignCallerTier = policy?.capability === true
    && policy.fastWire?.kind === "service-tier"
    && policy.fastWire?.foreignCallerTiers === "drop"
    && callerTierIsForeign;
  if (policy && policy.capability !== false && canonicalDecision) return;
  if (forwardCallerTier && !dropForeignCallerTier) return;
  if (rawBody && typeof rawBody === "object") {
    delete (rawBody as Record<string, unknown>).service_tier;
  }
  options.serviceTier = undefined;
}
