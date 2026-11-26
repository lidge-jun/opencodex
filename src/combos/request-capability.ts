import { nativeContextLimits } from "../codex/catalog/metadata";
import { effectiveAdapterContract } from "../adapters/registry";
import { getModelMetadataCaseInsensitive, resolveMetadataProvider } from "../generated/model-metadata";
import { errorDestinationText, providerErrorDestinationLabel } from "../lib/error-destination";
import { isCodexReasoningEffort, modelRecordValue, resolveEffortAtOrBelow } from "../reasoning-effort";
import { parseRequest } from "../responses/parser";
import { checkComboTargetInputAdmission, estimateInputTokens } from "../server/responses/input-admission";
import type { OcxComboTarget, OcxConfig, OcxParsedRequest, OcxProviderConfig } from "../types";
import { requiresVisionPreprocessing } from "../vision/plan";
import { customRowInputModalities } from "../vision/eligibility";
import { comboRequestHasAudioInput, comboRequestHasImageInput } from "./request";
import { jevDecisionBackendFor } from "./jev";
import { isDecisionsEndpoint } from "./jev-decision-contract";
import { targetKey, type NormalizedComboConfig } from "./types";

/**
 * How one `union` combo member serves this request.
 *
 * `native` takes it as is. `degraded` takes it after a local rewrite the child request already
 * owns (the vision sidecar describes the image). `unable` cannot take it at all and is skipped.
 */
export type ComboTargetService = "native" | "degraded" | "unable";

export interface ComboTargetRoute {
  providerName: string;
  provider: OcxProviderConfig;
  modelId: string;
  codexAccountId?: string;
}

/** Resolves a combo target to its concrete route; `undefined` when it does not resolve. */
export type ComboTargetRouter = (target: Pick<OcxComboTarget, "provider" | "model">) => ComboTargetRoute | undefined;

type ComboCapabilityConfig = Pick<OcxConfig, "providers" | "customModels" | "providerContextCaps" | "visionSidecar">;

type ComboVisionProbe = (route: ComboTargetRoute, parsed: OcxParsedRequest) => Promise<boolean>;

function comboTargetAcceptsAudio(config: ComboCapabilityConfig, route: ComboTargetRoute | undefined): boolean {
  if (!route) return false;
  const { provider, providerName, modelId } = route;
  const wire = effectiveAdapterContract(provider.adapter).wire;
  if (wire !== "openai-chat" && wire !== "openai-responses") return false;
  const declared = Object.hasOwn(provider.modelCapabilities ?? {}, modelId)
    ? provider.modelCapabilities?.[modelId]?.inputModalities : undefined;
  const modalities = declared ?? customRowInputModalities(config, providerName, modelId)
    ?? modelRecordValue(provider.modelInputModalities, modelId) ?? provider.inputModalities
    ?? getModelMetadataCaseInsensitive(resolveMetadataProvider(providerName) ?? providerName, modelId)?.input;
  return modalities?.includes("audio") === true;
}

/** What the admitted members cannot serve. */
export type ComboUnservable = false | "audio" | "image" | "context";

export interface ComboCapabilityGate {
  /** Selection filter: false only for a member that cannot serve this request. */
  eligible: (target: Pick<OcxComboTarget, "provider" | "model">) => boolean;
  /** No enabled member can serve the request as is; the caller applies `onUnservable`. */
  unservable: ComboUnservable;
  /** The child must still have a plan if it needs to describe images before sending. */
  requiresVisionPlan: ComboCapabilityGate["eligible"];
  /** Members that fit and can serve the turn once the combo permits omission. */
  imageDegradationEligible: ComboCapabilityGate["eligible"];
  /** Heuristic input-token estimate observed during capability admission, when available. */
  estimatedInputTokens?: number;
}

const OPEN_GATE: ComboCapabilityGate = {
  eligible: () => true, unservable: false, requiresVisionPlan: () => false,
  imageDegradationEligible: () => false,
};

interface ContextFit {
  fits: boolean;
  /** Known context window, or null when the target publishes none (fail-open, like the child). */
  window: number | null;
  /** Positive heuristic input-token count from admission, when computed. */
  estimatedTokens?: number;
}

function positiveTokenCount(value: number): number | undefined {
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/**
 * Context fit for one member: the estimated input must sit inside the member's input ceiling, and,
 * when the caller declares an output allowance, the strict combo admission the child applies
 * (`checkComboTargetInputAdmission`) must also pass. Without a declared allowance the child falls
 * back to the loose 2.5x pathological-input gate, which would let a member far too small through,
 * so the filter is the stricter of the two. The estimator overcounts on purpose, so the filter
 * leaves a member slightly early rather than late. An unresolved route or unknown window fits,
 * matching the child's fail-open.
 */
function comboTargetContextFit(
  config: ComboCapabilityConfig,
  parsed: OcxParsedRequest | undefined,
  route: ComboTargetRoute | undefined,
): ContextFit {
  if (!parsed || !route) return { fits: true, window: null };
  const result = checkComboTargetInputAdmission(
    { ...parsed, modelId: route.modelId }, route.provider, route.providerName, route.modelId, nativeContextLimits(config),
  );
  if (result.ceiling === null) return { fits: true, window: null };
  const estimatedTokens = positiveTokenCount(result.estimatedTokens);
  return {
    fits: result.admitted && result.estimatedTokens <= result.ceiling,
    window: result.contextWindow ?? result.ceiling,
    ...(estimatedTokens !== undefined ? { estimatedTokens } : {}),
  };
}

/** The request as the child will parse it. */
function parseComboInput(body: unknown): OcxParsedRequest | undefined {
  try {
    return parseRequest(body);
  } catch {
    return undefined;
  }
}

/** Heuristic input-token estimate for an arbitrary combo body; returns undefined for unparseable or compaction turns. */
export function estimateComboInputTokens(body: unknown, modelId = ""): number | undefined {
  const parsed = parseComboInput(body);
  if (!parsed || parsed._compactionRequest) return undefined;
  return positiveTokenCount(estimateInputTokens(parsed, modelId));
}

/**
 * Resolve the heuristic input-token estimate for a JEV decision turn without re-parsing a
 * `union` body or doing estimation work for backends that omit `signals.estimated_tokens`.
 */
export function resolveJevEstimatedInputTokens(
  config: Pick<OcxConfig, "providers">,
  combo: Pick<NormalizedComboConfig, "capabilityPolicy" | "decisionProvider" | "decisionModel">,
  capability: Pick<ComboCapabilityGate, "estimatedInputTokens">,
  body: unknown,
): number | undefined {
  if (jevDecisionBackendFor(combo) !== "systemone") return undefined;
  const providerId = combo.decisionProvider?.trim();
  const baseUrl = providerId && Object.hasOwn(config.providers, providerId)
    ? config.providers[providerId]?.baseUrl
    : undefined;
  if (typeof baseUrl === "string" && isDecisionsEndpoint(baseUrl)) return undefined;
  if (combo.capabilityPolicy === "union") return capability.estimatedInputTokens;
  return estimateComboInputTokens(body);
}

/**
 * Request-side half of `capabilityPolicy: "union"`. The catalog advertises the union of member
 * capabilities and the minimum member window (or the largest when `contextWindowPolicy: "max"`).
 * Dispatch can try the largest compatible member
 * when context is unservable, so a request may need something only some members
 * have. Audio requires a member that accepts it. Members that can degrade an image stay
 * eligible (keeping the subscription order and the prompt cache); members that cannot take the
 * image, or whose window cannot hold the input, are filtered.
 *
 * When no enabled, admitted member can serve, the gate reports why:
 * - `"audio"`: no member declares audio input. The caller refuses without discarding audio.
 * - `"context"`: no member can hold the input. Only the members with the largest known window stay
 *   eligible; the caller sends there with the loose direct-request admission (`onUnservable:
 *   "degrade"`) or refuses before any send (`"reject"`).
 * - `"image"`: every member that can hold the input is unable to take the image. Those members stay
 *   eligible and the child strips the image, or the caller refuses.
 */
export async function comboCapabilityGate(
  config: ComboCapabilityConfig,
  combo: Pick<NormalizedComboConfig, "capabilityPolicy" | "targets">,
  body: unknown,
  route: ComboTargetRouter,
  isAdmitted: (target: NormalizedComboConfig["targets"][number], route: ComboTargetRoute | undefined, parsed: OcxParsedRequest | undefined) => boolean = () => true,
  canDescribe?: ComboVisionProbe,
): Promise<ComboCapabilityGate> {
  if (combo.capabilityPolicy !== "union") return OPEN_GATE;
  const hasImage = comboRequestHasImageInput(body);
  const hasAudio = comboRequestHasAudioInput(body);
  const parsed = parseComboInput(body);
  const contextInput = parsed?._compactionRequest ? undefined : parsed;
  if (!hasImage && !hasAudio && !contextInput) return OPEN_GATE;
  let hasAdmittedTarget = false;
  let estimatedInputTokens: number | undefined;
  const visionChecks = new Map<string, ComboTargetRoute>();
  const judged = new Map<string, { image: ComboTargetService; context: ContextFit }>();
  for (const target of combo.targets) {
    if (config.providers[target.provider]?.disabled === true) continue;
    const key = targetKey(target);
    const resolved = route(target);
    if (!isAdmitted(target, resolved, parsed)) continue;
    hasAdmittedTarget = true;
    if (judged.has(key)) continue;
    if (hasAudio && !comboTargetAcceptsAudio(config, resolved)) continue;
    const context = comboTargetContextFit(config, contextInput, resolved);
    if (estimatedInputTokens === undefined && context.estimatedTokens !== undefined) {
      estimatedInputTokens = context.estimatedTokens;
    }
    const needsDescription = hasImage && context.fits && resolved
      && requiresVisionPreprocessing(config, resolved.provider, resolved.modelId, resolved.providerName);
    judged.set(key, { image: needsDescription ? "unable" : "native", context });
    if (needsDescription && parsed && config.visionSidecar?.enabled !== false) visionChecks.set(key, resolved);
  }
  // Finish evaluating admission metadata for all members before any asynchronous
  // sidecar planning can observe or trigger a configuration change.
  if (parsed && canDescribe) {
    for (const [key, resolved] of visionChecks) {
      if (await canDescribe(resolved, parsed)) judged.get(key)!.image = "degraded";
    }
  }
  if (!hasAdmittedTarget) return OPEN_GATE;
  if (estimatedInputTokens === undefined && contextInput) {
    estimatedInputTokens = positiveTokenCount(estimateInputTokens(contextInput, ""));
  }
  const verdicts = [...judged.values()];
  const estimated = estimatedInputTokens !== undefined ? { estimatedInputTokens } : {};
  if (verdicts.length === 0) return { ...OPEN_GATE, ...estimated, eligible: () => false, unservable: "audio" };
  const filter = (keep: (verdict: { image: ComboTargetService; context: ContextFit }) => boolean): ComboCapabilityGate["eligible"] =>
    target => {
      const verdict = judged.get(targetKey(target));
      return verdict !== undefined && keep(verdict);
    };
  if (verdicts.some(v => v.context.fits && v.image !== "unable")) {
    return {
      eligible: filter(v => v.context.fits && v.image !== "unable"),
      unservable: false,
      requiresVisionPlan: filter(v => v.image === "degraded"),
      imageDegradationEligible: filter(v => v.context.fits && v.image !== "native"),
      ...estimated,
    };
  }
  if (verdicts.some(v => v.context.fits)) {
    return { ...OPEN_GATE, ...estimated, eligible: filter(v => v.context.fits), unservable: "image" };
  }
  const largest = Math.max(...verdicts.map(v => v.context.window ?? 0));
  return { ...OPEN_GATE, ...estimated, eligible: filter(v => (v.context.window ?? 0) === largest), unservable: "context" };
}

/**
 * `union` + `adaptive` combos advertise the union of their members' effort ladders, so a caller
 * can pick a rung this member lacks (xhigh against a low/medium/high lane). Snap it to the
 * highest rung at or below, the rule the default effort already uses, instead of forwarding a
 * value the member would reject or silently ignore. A rung below the whole ladder rises to its
 * lowest rung, as `resolveEffortAtOrBelow` does for the default effort.
 */
export function clampComboCallerEffort(
  body: Record<string, unknown>,
  ladder: readonly string[] | undefined,
  target: Pick<OcxComboTarget, "provider">,
): void {
  if (!ladder || ladder.length === 0) return;
  const clamp = (effort: unknown): string | undefined => {
    if (typeof effort !== "string" || !isCodexReasoningEffort(effort) || ladder.includes(effort)) return undefined;
    const clamped = resolveEffortAtOrBelow(effort, ladder);
    if (clamped) {
      console.debug("[opencodex] combo effort clamped to target ladder", {
        provider: errorDestinationText(providerErrorDestinationLabel(target.provider)),
        requestedEffort: effort,
        effort: clamped,
      });
    }
    return clamped;
  };
  const reasoning = body.reasoning;
  if (reasoning && typeof reasoning === "object" && !Array.isArray(reasoning)) {
    const clamped = clamp((reasoning as Record<string, unknown>).effort);
    if (clamped) body.reasoning = { ...(reasoning as Record<string, unknown>), effort: clamped };
  }
  const flat = clamp(body.reasoning_effort);
  if (flat) body.reasoning_effort = flat;
}
