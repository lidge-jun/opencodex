/**
 * Home-only file integration writes under route intent: the dashboard toggle, an integration
 * restore and every Aside profile change. Each is the Home's own decision. Before it writes, a
 * linked Home refuses an unreadable route-intent.json and saves every default its Children inherit
 * (src/routing/home-route-intent.ts), so the write cannot move one. Afterwards, once the Home uses
 * route intent, the result is recorded as a `devices.home` entry so `ocx sync` keeps it; that entry
 * is the Home's own row and never a default a Child inherits. A Home with no link saves no default,
 * and when its route-intent.json cannot be read it records nothing either: `ocx sync` cannot read
 * that file, so it cannot undo the write.
 */
import { readConfigDiagnostics } from "../../config";
import { isRouteClientId, type RouteClientIntent } from "../../link/route-intent";
import { captureRefusal, homeHasLinks } from "../../routing/home-route-capture";
import { deriveHomeAsideIntent, HomeAsideIntentDerivationError, initializeHomeRouteIntentDefaults, recordHomeAsideDecision } from "../../routing/home-route-intent";
import { homeRouteIntentInUse, readRouteIntentState, recordHomeFileIntegrationDecision, routeIntentStatePath, RouteIntentStateUnreadableError } from "../../routing/route-intent-state";
import type { OcxConfig } from "../../types";
import { jsonResponse } from "../auth-cors";
import type { ManagementContext } from "./context";

const ASIDE_UNRESOLVED = "Existing Aside ownership could not be resolved to stable userIds, so this Home decision could not be kept by ocx sync; nothing was changed. Repair the Aside accounts.json manifest and its stable userIds, or choose an explicit Home Aside intent with ocx route to aside on|off --device home, then retry.";

function durableConfig(config: OcxConfig): OcxConfig {
  const latest = readConfigDiagnostics();
  return latest.source === "file" && !latest.error ? latest.config : config;
}

/** On a Home with no link an unreadable route-intent.json means there is nothing this write may record. */
function unlinkedUnreadableState(): boolean {
  if (homeHasLinks()) return false;
  try { readRouteIntentState(); return false; }
  catch (error) {
    if (error instanceof RouteIntentStateUnreadableError) return true;
    throw error;
  }
}

function refusal(ctx: ManagementContext, clientId: string | undefined, error: unknown): Response {
  const client = clientId === undefined ? {} : { clientId };
  if (error instanceof HomeAsideIntentDerivationError) {
    return jsonResponse({ error: ASIDE_UNRESOLVED, code: "route_intent_aside_unresolved", ...client }, 409, ctx.req, ctx.config);
  }
  if (error instanceof RouteIntentStateUnreadableError) {
    return jsonResponse({ error: error.message, code: "route_intent_unavailable", ...client }, 500, ctx.req, ctx.config);
  }
  const refused = captureRefusal(error);
  return jsonResponse({ error: refused.message, code: "route_intent_unavailable", ...client, retryable: refused.retryable },
    refused.retryable ? 409 : 500, ctx.req, ctx.config);
}

/**
 * Runs before the write; a refusal means nothing changed. `asideEnabling` names the Aside profiles
 * the write may enable, so one without a stable userId refuses now instead of after the write.
 */
export function prepareHomeIntegrationDecision(ctx: ManagementContext, clientId: string | undefined,
  asideEnabling?: readonly number[] | "all"): Response | null {
  try {
    if (unlinkedUnreadableState()) return null;
    readRouteIntentState();
    // The durable config already carries the switches another process may have changed; the live
    // one is never cloned here (it can hold runtime-only values).
    initializeHomeRouteIntentDefaults(durableConfig(ctx.config), ctx.version, undefined, { whenLinked: true });
    if (asideEnabling !== undefined && homeRouteIntentInUse(readRouteIntentState())) {
      deriveHomeAsideIntent(durableConfig(ctx.config), { extraProfileIds: asideEnabling });
    }
    return null;
  } catch (error) {
    return refusal(ctx, clientId, error);
  }
}

/**
 * Runs after a successful write and returns the response to send. A file client's decision is
 * `intent`; Aside's is derived from the profiles the Home owns now.
 */
export function recordHomeIntegrationDecision(ctx: ManagementContext, clientId: string, success: Response,
  intent?: () => RouteClientIntent): Response {
  try {
    if (unlinkedUnreadableState()) return success;
    if (clientId === "aside") recordHomeAsideDecision(durableConfig(ctx.config));
    else if (isRouteClientId(clientId) && intent) recordHomeFileIntegrationDecision(clientId, intent());
    return success;
  } catch (error) {
    const reason = error instanceof HomeAsideIntentDerivationError
      ? "its Aside profiles could not be named by stable userIds"
      : `route intent in ${routeIntentStatePath()} could not record it`;
    return jsonResponse({ error: `The ${clientId} integration was changed, but ${reason}, so ocx sync may undo it. Inspect it, fix or remove it, then make the change again.`,
      code: "route_intent_unavailable", clientId, integrationChanged: true }, 500, ctx.req, ctx.config);
  }
}
