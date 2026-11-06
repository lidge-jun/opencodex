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
import { HUB_RELAY_DEFAULT_TIMEOUT_MS, HUB_RELAY_RESPONSE_BODY_MAX_BYTES } from "./hub-relay";
import type { LinkIngress } from "./link-ingress";
import { relayLinkDataRequest } from "./link-relay";
import { parseUsageSource } from "../usage/source-filter";
import { readBoundedResponseBytes } from "../lib/bounded-body";
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
  const source = pathname === "/api/usage" ? parseUsageSource(new URLSearchParams(search.slice(1))) : { kind: "legacy" as const };
  if (source.kind !== "legacy") {
    if (source.kind !== "filtered" || source.filter.device.kind !== "key"
      || !ingress.apiKeyId || source.filter.device.id !== ingress.apiKeyId) {
      return Response.json({ error: "link_usage_scope_refused" }, { status: 403 });
    }
    // HEAD has no body in which the Home can confirm the filter; never present it as verified.
    if (req.method.toUpperCase() === "HEAD") return new Response(null, { status: 405 });
  }
  const admissionKey = ingress.linkKey();
  if (!admissionKey) return Response.json({ error: "link_credential_unavailable" }, { status: 503 });
  const outbound = new Request(`http://127.0.0.1${LINK_MANAGEMENT_PREFIX}${pathname}${search}`, {
    method: req.method,
    headers: { accept: "application/json" },
    signal: req.signal,
  });
  const response = await relayLinkDataRequest(outbound, {
    tunnelPort: ingress.tunnelPort,
    admissionKey,
    linkId: ingress.linkId,
    apiKeyId: ingress.apiKeyId,
  }, {
    ...ingress.relay,
    bodyLimitBytes: HUB_RELAY_RESPONSE_BODY_MAX_BYTES,
    routeAllowed: linkManagementRouteAllowed,
  });
  if (source.kind !== "filtered" || !response.ok) return response;
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json" && !contentType?.endsWith("+json")) {
    try { void response.body?.cancel().catch(() => {}); } catch { /* best effort */ }
    return Response.json({ error: "link_usage_filter_unconfirmed" }, { status: 502 });
  }
  try {
    const requestedTimeout = ingress.relay?.headerTimeoutMs;
    const deadline = requestedTimeout && requestedTimeout > 0
      ? Math.min(requestedTimeout, HUB_RELAY_DEFAULT_TIMEOUT_MS) : HUB_RELAY_DEFAULT_TIMEOUT_MS;
    const result = await readBoundedResponseBytes(response, { maxBytes: HUB_RELAY_RESPONSE_BODY_MAX_BYTES,
      signal: AbortSignal.any([req.signal, AbortSignal.timeout(deadline)]), inactivityTimeoutMs: deadline });
    if (result.oversized) throw new Error("response too large");
    const body: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(result.bytes));
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("invalid response");
    const echo = (body as Record<string, unknown>).sourceFilter;
    if (!echo || typeof echo !== "object" || Array.isArray(echo)) throw new Error("missing source filter");
    const value = echo as Record<string, unknown>;
    const device = value.device;
    if (value.client !== source.filter.client || !device || typeof device !== "object" || Array.isArray(device)
      || (device as Record<string, unknown>).kind !== "key"
      || (device as Record<string, unknown>).id !== ingress.apiKeyId) throw new Error("source filter mismatch");
    return Response.json(body, { status: response.status, headers: response.headers });
  } catch {
    return Response.json({ error: "link_usage_filter_unconfirmed" }, { status: 502 });
  }
}
