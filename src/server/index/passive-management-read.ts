import type { OcxConfig } from "../../types";
import { hasOwnProvider, isValidProviderName } from "../../config/provider-name";
import { runPassiveRead } from "../../lib/passive-read";
import { handleManagementAPI, type ManagementApiDeps } from "../management-api";
import type { ManagementSessionControl } from "../management-auth";

const KEPT_RESPONSE_HEADERS = ["content-type", "content-language", "etag", "last-modified"];

async function serveHubProviderKeyRows(config: OcxConfig, name: string): Promise<Response> {
  if (!isValidProviderName(name) || !hasOwnProvider(config.providers, name)) {
    return Response.json({ error: "unknown provider" }, { status: 404 });
  }
  const { listProviderApiKeys } = await import("../../providers/api-keys");
  // Account listing needs row IDs; the relay assigns positions and exposes only status.
  const keys = listProviderApiKeys(config, name).keys.map(({ active, disabled }, index) => ({
    id: `relay-key-${index + 1}`, active, ...(disabled ? { disabled: true } : {}),
  }));
  return Response.json({ activeId: keys.find(key => key.active)?.id ?? null, keys });
}

/** Dispatch an already-authorized read without caller headers, credentials or side effects. */
export async function dispatchPassiveManagementRead(
  method: string, target: string, config: OcxConfig, deps: ManagementApiDeps,
  sessionControl?: ManagementSessionControl,
  hubRelay?: { enrollment?: { keyId: string; stillAdmitted: () => boolean } },
): Promise<Response> {
  const local = new URL(target, "http://127.0.0.1");
  const inner = new Request(local.href, { headers: { accept: "application/json", host: "127.0.0.1" } });
  const enrollment = hubRelay?.enrollment;
  const response = await runPassiveRead(async () => {
    if (hubRelay && local.pathname === "/api/providers/keys") {
      return serveHubProviderKeyRows(config, (local.searchParams.get("name") ?? "").trim());
    }
    if (enrollment && local.pathname === "/api/usage") {
      const { serveKeyScopedHubUsage } = await import("../hub-usage");
      return serveKeyScopedHubUsage(local.searchParams, enrollment.keyId, enrollment.stillAdmitted);
    }
    return handleManagementAPI(inner, local, config, deps, undefined, sessionControl, { trustedLoopback: false });
  });
  const headers = new Headers({ "cache-control": "no-store" });
  if (enrollment && !enrollment.stillAdmitted()) {
    try { await response?.body?.cancel(); } catch { /* best effort */ }
    return Response.json({ error: "hub relay credential refused" }, { status: 401, headers });
  }
  if (!response) return Response.json({ error: "not_found" }, { status: 404, headers });
  for (const name of KEPT_RESPONSE_HEADERS) {
    const value = response.headers.get(name);
    if (value) headers.set(name, value);
  }
  if (method === "HEAD") {
    try { await response.body?.cancel(); } catch { /* best effort */ }
    return new Response(null, { status: response.status, headers });
  }
  return new Response(response.body, { status: response.status, headers });
}
