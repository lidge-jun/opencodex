import { reconcileLiveStateStores } from "../../lib/state-store-registrations";
import { clearModelCache } from "../../codex/model-cache";
import { jsonResponse } from "../auth-cors";
import { installReplitProviderPair } from "../../providers/replit/setup";
import { readManagementJsonBody, rethrowManagementBodyTooLarge } from "./body";
import type { ManagementContext } from "./context";

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function handleReplitProviderRoutes(ctx: ManagementContext): Promise<Response | null> {
  const { req, url, config, deps, convergeCodexCatalog } = ctx;

  if (url.pathname !== "/api/providers/replit-pair" || req.method !== "POST") {
    return null;
  }

  let body: unknown;
  try {
    body = await readManagementJsonBody(req);
  } catch (error) {
    rethrowManagementBodyTooLarge(error);
    return jsonResponse({ error: "invalid JSON body" }, 400);
  }
  if (!isPlainRecord(body)) {
    return jsonResponse({ error: "replit-pair body must be a plain object" }, 400);
  }

  const origin = typeof body.origin === "string" ? body.origin.trim() : "";
  const gatewayKey = typeof body.gatewayKey === "string" ? body.gatewayKey : "";
  if (!origin || !gatewayKey) {
    return jsonResponse({ error: "origin and gatewayKey are required" }, 400);
  }
  if (body.allowCustomDomain !== undefined && typeof body.allowCustomDomain !== "boolean") {
    return jsonResponse({ error: "allowCustomDomain must be a boolean" }, 400);
  }
  if (body.replace !== undefined && typeof body.replace !== "boolean") {
    return jsonResponse({ error: "replace must be a boolean" }, 400);
  }
  if (body.setDefault !== undefined && typeof body.setDefault !== "boolean") {
    return jsonResponse({ error: "setDefault must be a boolean" }, 400);
  }

  const result = await installReplitProviderPair(config, {
    origin,
    gatewayKey,
    allowCustomDomain: body.allowCustomDomain === true,
    replace: body.replace === true,
    setDefault: body.setDefault === true,
  }, {
    mutatePersistedConfig: deps.mutatePersistedConfig,
    probeFetch: deps.probeFetch,
  });

  if (!result.ok) {
    const status = result.code === "provider_collision"
      ? 409
      : result.code === "config_busy"
        ? 503
        : 400;
    const response = jsonResponse({
      error: result.error,
      code: result.code,
      ...(result.collisions
        ? { collisions: result.collisions.map(row => row.providerId) }
        : {}),
      ...(result.probe ? { probe: result.probe } : {}),
    }, status, req, config);
    if (result.code === "config_busy") response.headers.set("Retry-After", "1");
    return response;
  }

  reconcileLiveStateStores();
  clearModelCache("replit");
  clearModelCache("replit-anthropic");
  const catalogRefresh = await convergeCodexCatalog();

  return jsonResponse({
    success: true,
    providers: result.providers,
    probe: result.probe,
    ...(body.setDefault === true ? { defaultProvider: "replit" } : {}),
    catalogRefresh,
  });
}
