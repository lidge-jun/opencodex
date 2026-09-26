/**
 * Transparent relay for Codex Desktop ChatGPT-account RPCs, used by the quota mask.
 *
 * The mask injection points the root `chatgpt_base_url` at the dedicated loopback listener,
 * so every BackendClient call Codex makes with the SIGNED-IN account (profiles/me,
 * settings/user, wham/usage, …) arrives here. We forward it to chatgpt.com verbatim — same
 * method, body, and Authorization header — and pass the answer back untouched, with one
 * exception: `{base}/wham/usage` reports whether usage is allowed, and Desktop blocks the
 * composer on `allowed: false` even when every model is routed to another provider. That one
 * verdict is rewritten to allowed; `account_id`, `user_id`, windows, and every other field
 * pass through, because the app-server nulls account fields it cannot match to the signed-in
 * account.
 *
 * Nothing here is logged: the forwarded Authorization header is a live account credential.
 */
import type { OcxConfig } from "../types";
import { isEffectiveCodexQuotaMask } from "../codex/loopback-target";

const CHATGPT_BACKEND_ORIGIN = "https://chatgpt.com";

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export function chatgptBackendRelayEnabled(
  config: Pick<OcxConfig, "runtimeRole" | "unauthenticatedLoopbackListener" | "codexQuotaMask"> | undefined,
): boolean {
  return isEffectiveCodexQuotaMask(config);
}

/** The listener allowlist entry: account RPCs only, GET/POST only, while the mask is on. */
export function chatgptBackendRelayRouteAllowed(url: URL, req: Request): boolean {
  if (!url.pathname.startsWith("/backend-api/")) return false;
  return req.method === "GET" || req.method === "POST";
}

/** Pure rewrite of the usage verdict; every identifying field is preserved. */
export function maskWhamUsageBody<T extends Record<string, unknown>>(body: T): T & Record<string, unknown> {
  return {
    ...body,
    rate_limit: { ...(body.rate_limit as Record<string, unknown> | undefined), allowed: true, limit_reached: false },
    rate_limit_upsell: null,
    rate_limit_reached_type: null,
  };
}

function forwardRequestHeaders(req: Request): Headers {
  const headers = new Headers();
  for (const [name, value] of req.headers) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower) || lower === "host" || lower === "content-length") continue;
    headers.set(name, value);
  }
  return headers;
}

function forwardResponseHeaders(upstream: Response): Headers {
  const headers = new Headers();
  for (const [name, value] of upstream.headers) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower) || lower === "content-length") continue;
    headers.set(name, value);
  }
  return headers;
}

export async function relayChatGptBackendRequest(req: Request): Promise<Response> {
  const incoming = new URL(req.url);
  const target = `${CHATGPT_BACKEND_ORIGIN}${incoming.pathname}${incoming.search}`;
  const body = req.method === "POST" ? await req.arrayBuffer() : undefined;
  let upstream: Response;
  try {
    upstream = await fetch(target, { method: req.method, headers: forwardRequestHeaders(req), body });
  } catch {
    // The account RPC is not worth a retry ladder: Codex surfaces the 502 and the next
    // poll retries naturally.
    return Response.json({ error: "chatgpt_backend_relay_unreachable" }, { status: 502 });
  }
  if (upstream.ok && incoming.pathname === "/backend-api/wham/usage") {
    try {
      return Response.json(maskWhamUsageBody(await upstream.json() as Record<string, unknown>), {
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      });
    } catch {
      // A non-JSON usage body falls through to passthrough; nothing is masked on it.
    }
  }
  return new Response(upstream.body, { status: upstream.status, headers: forwardResponseHeaders(upstream) });
}

