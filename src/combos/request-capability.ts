import { errorDestinationText, providerErrorDestinationLabel } from "../lib/error-destination";
import { isCodexReasoningEffort, resolveEffortAtOrBelow } from "../reasoning-effort";
import type { OcxComboTarget, OcxConfig, OcxProviderConfig } from "../types";
import { requiresVisionPreprocessing } from "../vision/plan";
import { comboRequestHasImageInput } from "./request";
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
}

/** Resolves a combo target to its concrete route; `undefined` when it does not resolve. */
export type ComboTargetRouter = (target: Pick<OcxComboTarget, "provider" | "model">) => ComboTargetRoute | undefined;

/**
 * Image service for one member, judged with the same predicate the child request uses to decide
 * between raw delivery and the sidecar (`request-sidecar-auth.ts`). The sidecar counts as
 * available when the configuration enables it; whether its credentials admit this particular
 * turn is decided by the child, which strips the image when no plan is dispatchable. An
 * unresolved route or an unproven capability is `native`, matching the child's pass-through.
 */
export function comboTargetImageService(
  config: OcxConfig,
  route: ComboTargetRoute | undefined,
): ComboTargetService {
  if (!route || !requiresVisionPreprocessing(config, route.provider, route.modelId, route.providerName)) return "native";
  return config.visionSidecar?.enabled === false ? "unable" : "degraded";
}

export interface ComboCapabilityGate {
  /** Selection filter: false only for a member that cannot serve this request. */
  eligible: (target: Pick<OcxComboTarget, "provider" | "model">) => boolean;
  /** Every enabled member is `unable`; the caller applies `onUnservable`. */
  unservable: boolean;
}

const OPEN_GATE: ComboCapabilityGate = { eligible: () => true, unservable: false };

/**
 * Request-side half of `capabilityPolicy: "union"`. The catalog advertises the union of member
 * capabilities, so a request may need something only some members have. Members that can
 * degrade stay eligible (keeping the subscription order and the prompt cache); only `unable`
 * members are filtered. When every enabled member is `unable` the filter opens again so the
 * request is never stranded on a 503; `unservable` tells the caller to warn or reject.
 */
export function comboCapabilityGate(
  config: OcxConfig,
  combo: Pick<NormalizedComboConfig, "capabilityPolicy" | "targets">,
  body: unknown,
  route: ComboTargetRouter,
): ComboCapabilityGate {
  if (combo.capabilityPolicy !== "union" || !comboRequestHasImageInput(body)) return OPEN_GATE;
  const services = new Map<string, ComboTargetService>();
  const service = (target: Pick<OcxComboTarget, "provider" | "model">): ComboTargetService => {
    const key = targetKey(target);
    let value = services.get(key);
    if (value === undefined) {
      value = comboTargetImageService(config, route(target));
      services.set(key, value);
    }
    return value;
  };
  const enabled = combo.targets.filter(target => config.providers[target.provider]?.disabled !== true);
  const unservable = enabled.length > 0 && enabled.every(target => service(target) === "unable");
  return {
    eligible: target => unservable || service(target) !== "unable",
    unservable,
  };
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
