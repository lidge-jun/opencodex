import { nativeContextLimits } from "../codex/catalog/metadata";
import { effectiveAdapterContract } from "../adapters/registry";
import { getModelMetadataCaseInsensitive, resolveMetadataProvider } from "../generated/model-metadata";
import { errorDestinationText, providerErrorDestinationLabel } from "../lib/error-destination";
import { isCodexReasoningEffort, modelRecordValue, resolveEffortAtOrBelow } from "../reasoning-effort";
import { parseRequest } from "../responses/parser";
import { checkComboTargetInputAdmission } from "../server/responses/input-admission";
import type { OcxComboTarget, OcxConfig, OcxParsedRequest, OcxProviderConfig } from "../types";
import { requiresVisionPreprocessing } from "../vision/plan";
import { customRowInputModalities } from "../vision/eligibility";
import { comboRequestHasAudioInput, comboRequestHasImageInput } from "./request";
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

type ComboVisionProbe = (route: ComboTargetRoute, parsed: OcxParsedRequest) => Promise<boolean>;

/** Unknown image capability keeps the child's native pass-through behavior. */
async function comboTargetImageService(
  config: OcxConfig,
  route: ComboTargetRoute | undefined,
  parsed: OcxParsedRequest | undefined,
  canDescribe: ComboVisionProbe | undefined,
): Promise<ComboTargetService> {
  if (!route || !requiresVisionPreprocessing(config, route.provider, route.modelId, route.providerName)) return "native";
  return parsed && config.visionSidecar?.enabled !== false && await canDescribe?.(route, parsed)
    ? "degraded" : "unable";
}

function comboTargetAcceptsAudio(config: OcxConfig, route: ComboTargetRoute | undefined): boolean {
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
}

const OPEN_GATE: ComboCapabilityGate = {
  eligible: () => true, unservable: false, requiresVisionPlan: () => false,
};

interface ContextFit {
  fits: boolean;
  /** Known context window, or null when the target publishes none (fail-open, like the child). */
  window: number | null;
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
  config: OcxConfig,
  parsed: OcxParsedRequest | undefined,
  route: ComboTargetRoute | undefined,
): ContextFit {
  if (!parsed || !route) return { fits: true, window: null };
  const result = checkComboTargetInputAdmission(
    { ...parsed, modelId: route.modelId }, route.provider, route.providerName, route.modelId, nativeContextLimits(config),
  );
  if (result.ceiling === null) return { fits: true, window: null };
  return { fits: result.admitted && result.estimatedTokens <= result.ceiling, window: result.contextWindow ?? result.ceiling };
}

/** The request as the child will parse it. */
function parseComboInput(body: unknown): OcxParsedRequest | undefined {
  try {
    return parseRequest(body);
  } catch {
    return undefined;
  }
}

/**
 * Request-side half of `capabilityPolicy: "union"`. The catalog advertises the union of member
 * capabilities and the largest member window, so a request may need something only some members
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
  config: OcxConfig,
  combo: Pick<NormalizedComboConfig, "capabilityPolicy" | "targets">,
  body: unknown,
  route: ComboTargetRouter,
  isAdmitted: (target: NormalizedComboConfig["targets"][number], route: ComboTargetRoute | undefined) => boolean = () => true,
  canDescribe?: ComboVisionProbe,
): Promise<ComboCapabilityGate> {
  if (combo.capabilityPolicy !== "union") return OPEN_GATE;
  const hasImage = comboRequestHasImageInput(body);
  const hasAudio = comboRequestHasAudioInput(body);
  const parsed = parseComboInput(body);
  const contextInput = parsed?._compactionRequest ? undefined : parsed;
  if (!hasImage && !hasAudio && !contextInput) return OPEN_GATE;
  let hasAdmittedTarget = false;
  const judged = new Map<string, { image: ComboTargetService; context: ContextFit }>();
  for (const target of combo.targets) {
    if (config.providers[target.provider]?.disabled === true) continue;
    const key = targetKey(target);
    const resolved = route(target);
    if (!isAdmitted(target, resolved)) continue;
    hasAdmittedTarget = true;
    if (judged.has(key)) continue;
    if (hasAudio && !comboTargetAcceptsAudio(config, resolved)) continue;
    const context = comboTargetContextFit(config, contextInput, resolved);
    judged.set(key, {
      image: hasImage && context.fits ? await comboTargetImageService(config, resolved, parsed, canDescribe) : "native",
      context,
    });
  }
  if (!hasAdmittedTarget) return OPEN_GATE;
  const verdicts = [...judged.values()];
  if (verdicts.length === 0) return { ...OPEN_GATE, eligible: () => false, unservable: "audio" };
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
    };
  }
  if (verdicts.some(v => v.context.fits)) {
    return { ...OPEN_GATE, eligible: filter(v => v.context.fits), unservable: "image" };
  }
  const largest = Math.max(...verdicts.map(v => v.context.window ?? 0));
  return { ...OPEN_GATE, eligible: filter(v => (v.context.window ?? 0) === largest), unservable: "context" };
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
