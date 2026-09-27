import type { Server } from "bun";
import { formatErrorResponse } from "../bridge";
import { readServiceApiTokenState, type ServiceApiTokenState } from "../lib/service-secrets";
import { linkRouteAllowed } from "../link/routes";
import { isAllowedRequestOrigin, type RequestPolicyView } from "../server/auth-cors";
import { relayLinkDataRequest, type LinkRelayDeps } from "./link-relay";

/** How often an unavailable link key is looked for again. A valid key is never re-read. */
export const LINK_KEY_RETRY_MS = 1_000;

export interface LinkKeySourceDeps {
  readToken?: () => ServiceApiTokenState;
  now?: () => number;
}

/**
 * The link key for relayed requests, read from the service token file once and then held in
 * memory, so no data-plane request touches the disk. The file must still hold the key this
 * connection committed (`tokenFingerprint`); anything else yields null. Only while the key is
 * unavailable is the file read again, at most once per `LINK_KEY_RETRY_MS`. The key is never
 * logged, returned in a response, or written anywhere.
 */
export function createLinkKeySource(expectedFingerprint: string, deps: LinkKeySourceDeps = {}): () => string | null {
  const readToken = deps.readToken ?? readServiceApiTokenState;
  const now = deps.now ?? Date.now;
  let key: string | null = null;
  let lastRead = 0;
  const load = (): void => {
    lastRead = now();
    try {
      const state = readToken();
      key = state.kind === "present" && state.fingerprint === expectedFingerprint ? state.token : null;
    } catch {
      key = null;
    }
  };
  load();
  return () => {
    if (key === null && now() - lastRead >= LINK_KEY_RETRY_MS) load();
    return key;
  };
}

export interface LinkIngress {
  tunnelPort: number;
  /** The listener's loopback policy: the standalone Host and Origin anti-rebinding gate. */
  policy: RequestPolicyView;
  linkKey: () => string | null;
  relay?: LinkRelayDeps;
}

const RESPONSES_WEBSOCKET_DISABLED = "Responses WebSocket transport is disabled; use HTTP";

/**
 * Lift Bun's per-request idle timer for a relayed request, as the standalone does on its data
 * routes (`disableResponsesRequestTimeout`). Without it the listener's idle limit cuts a quiet
 * stretch of a long generation: an SSE gap between events, or a Home that holds a turn after
 * its headers. The relay bounds the wait itself (header deadline, SSE idle limit, caller abort).
 * It is a local call rather than the standalone helper's import, which would load the Responses
 * WebSocket upstream modules into every Child.
 */
function liftRequestIdleTimer(req: Request, server: Pick<Server<unknown>, "timeout"> | undefined): void {
  if (!server) return;
  try { server.timeout(req, 0); } catch { /* the request may already be closed */ }
}

/**
 * The link-mode data plane of the client machine listener. It answers only the requests it
 * owns and returns null for everything else, which the listener handles as before.
 *
 * - A `/v1/responses` WebSocket upgrade gets 426, the answer codex-rs turns into an HTTP
 *   fallback; the link never carries a WebSocket.
 * - Every relayed route passes the standalone loopback Host/Origin gate before any upstream
 *   fetch, so a rebinding or cross-site browser page cannot reach the Home through this port.
 * - Without the committed link key nothing is fetched, and the caller gets
 *   `503 link_credential_unavailable`.
 * - `/readyz` stays local: it reports this listener, not the tunnel.
 * - A relayed request is exempt from the listener's idle limit, like a standalone data route.
 */
export function handleLinkIngress(
  req: Request,
  url: URL,
  ingress: LinkIngress,
  server?: Pick<Server<unknown>, "timeout">,
): Response | Promise<Response> | null {
  const upgrade = req.headers.get("upgrade");
  if (upgrade !== null) {
    if (url.pathname !== "/v1/responses" || upgrade.trim().toLowerCase() !== "websocket") return null;
    if (!isAllowedRequestOrigin(req, ingress.policy)) {
      return formatErrorResponse(403, "origin_rejected", "WebSocket upgrade blocked: non-local Origin");
    }
    return formatErrorResponse(426, "upgrade_required", RESPONSES_WEBSOCKET_DISABLED);
  }
  if (url.pathname === "/readyz" || !linkRouteAllowed(url, req)) return null;
  if (!isAllowedRequestOrigin(req, ingress.policy)) {
    return formatErrorResponse(403, "origin_rejected", "cross-origin data-plane request blocked");
  }
  const admissionKey = ingress.linkKey();
  if (!admissionKey) return Response.json({ error: "link_credential_unavailable" }, { status: 503 });
  liftRequestIdleTimer(req, server);
  return relayLinkDataRequest(req, { tunnelPort: ingress.tunnelPort, admissionKey }, ingress.relay);
}
