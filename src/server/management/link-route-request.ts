/**
 * The explicit route fields of a link enrollment request (structure/remote-link.md, "Explicit route").
 * probe, confirm-host and apply each accept optional explicitRoute and exclusive beside their own keys.
 * probe binds them to the pending host; confirm-host and apply must name the same values (absent is
 * none), so a probe made by another caller with another route can never be confirmed or applied here.
 */
import { checkExplicitRoute, sameExplicitRoute, type ExplicitRoute } from "../../link/explicit-route";
import { fail, isRecord } from "./link-route-state";

export interface RouteRequest {
  explicitRoute: ExplicitRoute | null;
  exclusive: boolean;
}

export const NO_ROUTE_REQUEST: RouteRequest = { explicitRoute: null, exclusive: false };

/** The body without the route keys, and the route it asked for; a refusal is a 400 before any SSH. */
export function splitRouteRequest(value: unknown): { body: unknown; route: RouteRequest } | { error: Response } {
  if (!isRecord(value) || (!("explicitRoute" in value) && !("exclusive" in value))) return { body: value, route: NO_ROUTE_REQUEST };
  const { explicitRoute, exclusive, ...body } = value;
  if (exclusive !== undefined && exclusive !== true) return { error: fail("invalid_body", "exclusive must be true when present.", 400) };
  let route: ExplicitRoute | null = null;
  if (explicitRoute !== undefined) {
    const checked = checkExplicitRoute(explicitRoute);
    if (!checked.ok) return { error: fail("invalid_explicit_route", "explicitRoute must be {proxyCommand, user, port} in the accepted form.", 400, checked.reason) };
    route = checked.route;
    if (exclusive !== true) return { error: fail("explicit_route_requires_exclusive", "A link with an explicit route must be exclusive.", 400) };
  }
  return { body, route: { explicitRoute: route, exclusive: exclusive === true } };
}

/** The route a pending or confirmed host was probed with. */
export function routeOf(host: { explicitRoute?: ExplicitRoute; exclusive?: true }): RouteRequest {
  return { explicitRoute: host.explicitRoute ?? null, exclusive: host.exclusive === true };
}

export function sameRouteRequest(left: RouteRequest, right: RouteRequest): boolean {
  return left.exclusive === right.exclusive && sameExplicitRoute(left.explicitRoute, right.explicitRoute);
}

/** The optional record fields for a route request: nothing at all for a link without one. */
export function routeFields(route: RouteRequest): { explicitRoute?: ExplicitRoute; exclusive?: true } {
  return { ...(route.explicitRoute ? { explicitRoute: route.explicitRoute } : {}), ...(route.exclusive ? { exclusive: true as const } : {}) };
}

export function routeMismatch(): Response {
  return fail("route_mismatch", "The explicit route or exclusive flag differs from the one the host was probed with; probe the host again.", 409);
}
