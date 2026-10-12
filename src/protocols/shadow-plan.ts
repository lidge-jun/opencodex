/**
 * Shadow plan recording (PF-12, `protocols.rollout.shadowPlan`, default off).
 *
 * SERVER SIDE (not a leaf): it reads config through `plan-snapshot.ts`. An ingress calls
 * `recordProtocolShadowPlan` right after its entry mark. With the switch off it returns before
 * reading anything else. With it on it builds the same side-effect-free snapshot the dashboard
 * preview uses, with basis `dispatch`, from the selector the client sent and the features the
 * entry mark already collected, and stores it beside the marks. `trace.ts` runs the pure planner
 * on it at finalize and compares.
 *
 * Nothing here sends, fetches, advances combo state or writes: the snapshot expands combos and
 * policies from config and uses `routeModel`'s deterministic branches only. The stored input is
 * fixed vocabulary plus the provider and model names the server already exposes. Any throw is
 * swallowed: a shadow plan is diagnostics and never fails or changes the request it describes.
 */
import type { OcxConfig } from "../types";
import type { Protocol } from "./contract";
import { buildProtocolPlanSnapshot } from "./plan-snapshot";
import { resolveProtocolSettings } from "./settings";
import { markProtocolShadowPlanInput, protocolMarkFeatures } from "./trace";

export function recordProtocolShadowPlan(
  logCtx: object,
  config: OcxConfig,
  request: { inbound: Protocol; model: unknown },
): void {
  try {
    if (!resolveProtocolSettings(config).rollout.shadowPlan) return;
    if (typeof request.model !== "string" || request.model.length === 0) return;
    const features = protocolMarkFeatures(logCtx) ?? [];
    const input = buildProtocolPlanSnapshot(config, { model: request.model, inbound: request.inbound, features }, "dispatch");
    markProtocolShadowPlanInput(logCtx, input);
  } catch {
    /* a shadow plan must never fail the request it describes */
  }
}
