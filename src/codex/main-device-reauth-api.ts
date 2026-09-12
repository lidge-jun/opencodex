import type { OcxConfig } from "../types";
import { jsonResponse } from "../server/auth-cors";
import {
  cancelMainDeviceReauth,
  getMainDeviceReauthStatus,
  MainDeviceReauthFlowBusyError,
  startMainDeviceReauth,
} from "./main-device-reauth";
import { NativeMainReauthUnavailableError } from "./main-account";

/**
 * Dedicated native-main device reauth route (#3898).
 *
 * `/api/codex-auth/login` stays pool-only and keeps rejecting __main__;
 * this namespace is the only device-reauth surface for the native main slot.
 * DTOs carry flowId/status/verificationUrl/deviceCode and safe failure codes
 * — never tokens, emails, or raw account ids. The route is registered in
 * management-api ahead of the generic /api/codex-auth/* dispatch, so the
 * existing management origin/auth/session controls wrap it unchanged.
 */

const ROUTE = "/api/codex-auth/main/reauth-device";

function errorResponse(
  req: Request,
  config: OcxConfig,
  message: string,
  code: string,
  status: number,
): Response {
  return jsonResponse({ error: message, code }, status, req, config);
}

function flowIdFromQuery(url: URL): string | null {
  for (const key of url.searchParams.keys()) {
    if (key !== "flowId") return null;
  }
  const flowId = url.searchParams.get("flowId");
  return flowId && flowId.trim() ? flowId : null;
}

export async function handleMainDeviceReauthAPI(
  req: Request,
  url: URL,
  config: OcxConfig,
): Promise<Response | null> {
  if (url.pathname !== ROUTE) return null;

  if (req.method === "POST") {
    // Strict body: no request keys exist for start; anything supplied is an error.
    const text = await req.text();
    if (text.trim()) {
      return errorResponse(req, config, "The reauth-device start takes no request body", "invalid_request", 400);
    }
    try {
      return jsonResponse(startMainDeviceReauth(), 200, req, config);
    } catch (error) {
      if (error instanceof MainDeviceReauthFlowBusyError) {
        return errorResponse(req, config, error.message, error.code, 409);
      }
      if (error instanceof NativeMainReauthUnavailableError) {
        return errorResponse(req, config, error.message, "native_main_unavailable", 503);
      }
      throw error;
    }
  }

  if (req.method === "GET") {
    const flowId = flowIdFromQuery(url);
    if (!flowId) {
      return errorResponse(req, config, "An exact flowId query is required", "invalid_request", 400);
    }
    const status = getMainDeviceReauthStatus(flowId);
    if (!status) return errorResponse(req, config, "Unknown or expired reauth flow", "unknown_flow", 404);
    return jsonResponse(status, 200, req, config);
  }

  if (req.method === "DELETE") {
    const flowId = flowIdFromQuery(url);
    if (!flowId) {
      return errorResponse(req, config, "An exact flowId query is required", "invalid_request", 400);
    }
    const status = cancelMainDeviceReauth(flowId);
    if (!status) return errorResponse(req, config, "Unknown or expired reauth flow", "unknown_flow", 404);
    return jsonResponse(status, 200, req, config);
  }

  return errorResponse(req, config, "Method not allowed", "method_not_allowed", 405);
}
