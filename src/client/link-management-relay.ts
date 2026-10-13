/**
 * The Child end of the Remote Link management relay (#6957).
 *
 * The Child's dashboard reaches its Home's management reads at `/api/machine/hub-relay/api/*`,
 * the same base a hub client's dashboard uses. The browser authenticates to the Child with the
 * Child's own dashboard session; this relay drops every browser header, builds a fresh GET for
 * the Home's `/v1/link-management` prefix and sends it through the connection-bound link relay,
 * which attaches the link key only after the tunnel listener proves the link identity. Anything
 * outside the shared read allowlist is refused here, before a request exists.
 */
import { HUB_RELAY_RESPONSE_BODY_MAX_BYTES } from "./hub-relay";
import type { LinkIngress } from "./link-ingress";
import { relayLinkDataRequest } from "./link-relay";
import {
  LINK_MANAGEMENT_PREFIX,
  linkChildManagementRefusal,
  linkManagementReadAllowed,
  linkManagementRouteAllowed,
} from "../link/management-routes";

export const LINK_CHILD_READ_ONLY = "link_child_read_only";

export function linkChildRefusalResponse(homePhrase: string, linkId: string, operation: string): Response {
  return Response.json({
    error: linkChildManagementRefusal(homePhrase, linkId, operation),
    code: LINK_CHILD_READ_ONLY,
    linkId,
  }, { status: 403, headers: { "cache-control": "no-store" } });
}

export async function relayLinkManagementRead(
  req: Request,
  suffix: string,
  ingress: LinkIngress,
  homePhrase: string,
): Promise<Response> {
  const linkId = ingress.linkId ?? "unknown";
  const query = suffix.indexOf("?");
  const pathname = query === -1 ? suffix : suffix.slice(0, query);
  const search = query === -1 ? "" : suffix.slice(query);
  if (!linkManagementReadAllowed(req.method, pathname, new URLSearchParams(search.slice(1)))) {
    return linkChildRefusalResponse(homePhrase, linkId, `${req.method.toUpperCase()} ${pathname}`);
  }
  const admissionKey = ingress.linkKey();
  if (!admissionKey) return Response.json({ error: "link_credential_unavailable" }, { status: 503 });
  const outbound = new Request(`http://127.0.0.1${LINK_MANAGEMENT_PREFIX}${pathname}${search}`, {
    method: req.method,
    headers: { accept: "application/json" },
    signal: req.signal,
  });
  return relayLinkDataRequest(outbound, {
    tunnelPort: ingress.tunnelPort,
    admissionKey,
    linkId: ingress.linkId,
    apiKeyId: ingress.apiKeyId,
  }, {
    ...ingress.relay,
    bodyLimitBytes: HUB_RELAY_RESPONSE_BODY_MAX_BYTES,
    routeAllowed: linkManagementRouteAllowed,
  });
}
