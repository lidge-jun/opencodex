/**
 * The Home end of the Remote Link management relay (#6957).
 *
 * Reached only on the hub-link listener, after the request has passed its link-key admission
 * (`resolveApiAuth` restricted to recorded link keys) and the shared route table in
 * `src/link/management-routes.ts`. The management handler sees a fresh request built here: no
 * caller header, cookie, Origin or credential crosses from the link, and the principal is
 * absent, so no consent- or capability-gated branch can be reached. Only allowlisted reads run.
 * They run as passive reads (`src/lib/passive-read.ts`): no discovery, config write or diagnostic (#6959).
 */
import type { OcxConfig } from "../../types";
import { handleManagementAPI, type ManagementApiDeps } from "../management-api";
import type { ManagementSessionControl } from "../management-auth";
import { runPassiveRead } from "../../lib/passive-read";
import { LINK_CODEX_SETTINGS_PATH, linkManagementRouteAllowed, linkManagementTarget } from "../../link/management-routes";
import { projectHomeCodexSettings } from "../../link/codex-settings";
import { packageVersion } from "../../lib/package-version";

const VERSION = packageVersion("0.0.0");
const KEPT_RESPONSE_HEADERS = ["content-type", "content-language", "etag", "last-modified"];

function notFound(): Response {
  return Response.json({ error: "not_found" }, { status: 404, headers: { "cache-control": "no-store" } });
}

export async function handleLinkManagementRequest(
  req: Request,
  url: URL,
  config: OcxConfig,
  deps: ManagementApiDeps,
  sessionControl?: ManagementSessionControl,
): Promise<Response> {
  if (!linkManagementRouteAllowed(url, req)) return notFound();
  if (url.pathname === LINK_CODEX_SETTINGS_PATH) {
    return Response.json(projectHomeCodexSettings(config, VERSION), { headers: { "cache-control": "no-store" } });
  }
  const target = linkManagementTarget(url);
  if (!target) return notFound();
  const local = new URL(`${target.pathname}${target.search}`, "http://127.0.0.1");
  // The handlers branch on GET; an admitted HEAD runs as GET and its body is dropped below.
  const inner = new Request(local.href, {
    method: "GET",
    headers: { accept: "application/json", host: "127.0.0.1" },
  });
  const response = await runPassiveRead(() =>
    handleManagementAPI(inner, local, config, deps, undefined, sessionControl, { trustedLoopback: false }));
  if (!response) return notFound();
  const headers = new Headers({ "cache-control": "no-store" });
  for (const name of KEPT_RESPONSE_HEADERS) {
    const value = response.headers.get(name);
    if (value) headers.set(name, value);
  }
  if (req.method === "HEAD") {
    try { await response.body?.cancel(); } catch { /* best effort */ }
    return new Response(null, { status: response.status, headers });
  }
  return new Response(response.body, { status: response.status, headers });
}
