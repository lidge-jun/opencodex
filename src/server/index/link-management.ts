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
import { homeLinkChildParity, LINK_CHILD_PARITY_MAX_BYTES, LINK_CHILD_PARITY_PATH, parseLinkChildParityReport } from "../../link/child-parity";
import { linkStorePath } from "../../link/paths";
import { readLinkStore } from "../../link/store";
import { readBoundedResponseBytes } from "../../lib/bounded-body";
import { packageVersion } from "../../lib/package-version";

const VERSION = packageVersion("0.0.0");
const KEPT_RESPONSE_HEADERS = ["content-type", "content-language", "etag", "last-modified"];
const REPORT_READ_TIMEOUT_MS = 5_000;

function notFound(): Response {
  return Response.json({ error: "not_found" }, { status: 404, headers: { "cache-control": "no-store" } });
}

function refused(status: number, code: string): Response {
  return Response.json({ error: code }, { status, headers: { "cache-control": "no-store" } });
}

/**
 * `POST` {@link LINK_CHILD_PARITY_PATH}: the Child's apply report (OCX-6). The one write the link
 * accepts, handled here, before and apart from the read-only table, so it never widens what a
 * read may do. It is admitted only for the link the admitting key belongs to, reads at most
 * {@link LINK_CHILD_PARITY_MAX_BYTES} and changes nothing but the in-memory report.
 */
async function handleChildParityReport(req: Request, url: URL, admittedKeyId: string | undefined): Promise<Response> {
  if (req.method !== "POST" || url.search !== "" || req.headers.has("upgrade")) return notFound();
  if (!admittedKeyId) return refused(403, "link_key_required");
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > LINK_CHILD_PARITY_MAX_BYTES) return refused(413, "report_too_large");
  let bytes: Uint8Array;
  try {
    const read = await readBoundedResponseBytes(new Response(req.body), {
      maxBytes: LINK_CHILD_PARITY_MAX_BYTES,
      signal: AbortSignal.timeout(REPORT_READ_TIMEOUT_MS),
    });
    if (read.oversized) return refused(413, "report_too_large");
    bytes = read.bytes;
  } catch {
    return refused(400, "invalid_report");
  }
  let report: ReturnType<typeof parseLinkChildParityReport>;
  try {
    report = parseLinkChildParityReport(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
  } catch {
    report = null;
  }
  if (!report) return refused(400, "invalid_report");
  let links: ReturnType<typeof readLinkStore>["links"];
  try { links = readLinkStore(linkStorePath()).links; } catch { return refused(503, "link_store_unavailable"); }
  if (!links.some(link => link.id === report.linkId && link.apiKeyId === admittedKeyId)) return refused(403, "link_mismatch");
  homeLinkChildParity.record(report, new Set(links.map(link => link.id)));
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
}

export async function handleLinkManagementRequest(
  req: Request,
  url: URL,
  config: OcxConfig,
  deps: ManagementApiDeps,
  sessionControl?: ManagementSessionControl,
  admittedKeyId?: string,
): Promise<Response> {
  if (url.pathname === LINK_CHILD_PARITY_PATH) return handleChildParityReport(req, url, admittedKeyId);
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
