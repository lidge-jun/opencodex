import { previewRouteModel, type RouteResult } from "../router";
import type { OcxConfig } from "../types";

/** Only exempt a route when the Advisor selector resolves to the same concrete destination. */
export function isAdvisorDestination(route: RouteResult, config: OcxConfig, model: string): boolean {
  try {
    const destination = previewRouteModel(config, model);
    if (destination.combo || destination.routeKind === "combo" || destination.routeKind === "policy") return false;
    return destination.providerName === route.providerName && destination.modelId === route.modelId;
  } catch {
    return false;
  }
}
