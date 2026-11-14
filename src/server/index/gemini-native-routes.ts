import type { OllamaRouteDeps } from "./ollama-routes";
import { admissionFields, isAllowedRequestOrigin, resolveResponsesApiAuth, withCors } from "../auth-cors";
import { resolveAdmissionModelScope, routeAllowedByScope } from "../admission-model-scope";
import { isDraining } from "../lifecycle";
import { disableResponsesRequestTimeout } from "../responses";
import { withCallerSessionIdentity } from "../caller-session-identity";
import { nextRequestLogId, type RequestLogContext } from "../request-log";
import { classifyUsageClient } from "../../usage/client";
import { logGeminiNativeDelivery } from "../gemini-native-log";
import { geminiNativeCatalog } from "../gemini-native-catalog";
import { GEMINI_NATIVE_PATH, geminiNativeError, handleGeminiNative } from "../gemini-native";

/** Gemini is a separate native data plane, using the same admission authority as Responses. */
export async function dispatchGeminiNativeRoute(req: Request, url: URL, deps: OllamaRouteDeps): Promise<Response> {
  const reply = (response: Response) => withCors(response, req, deps.policy);
  const admission = resolveResponsesApiAuth(req, deps.policy);
  if (!admission) return reply(geminiNativeError(401, "opencodex API key required"));
  if (!isAllowedRequestOrigin(req, deps.policy)) return reply(geminiNativeError(403, "cross-origin data-plane request blocked"));
  const scope = resolveAdmissionModelScope(deps.config, admission);
  if (url.pathname === "/v1beta/models" || /^\/v1beta\/models\/gemini-[A-Za-z0-9._-]{1,120}$/.test(url.pathname)) {
    if (req.method !== "GET") {
      const response = geminiNativeError(405, "GET required"); response.headers.set("Allow", "GET"); return reply(response);
    }
    return reply(geminiNativeCatalog(deps.config, url, scope));
  }
  const match = GEMINI_NATIVE_PATH.exec(url.pathname);
  if (!match) return reply(geminiNativeError(404, "Supported Gemini native paths: /v1beta/models/gemini-*:generateContent or :streamGenerateContent"));
  if (req.method !== "POST") {
    const response = geminiNativeError(405, "POST required");
    response.headers.set("Allow", "POST"); return reply(response);
  }
  const model = match[1]!;
  if (!routeAllowedByScope(scope, { providerName: "google-antigravity", modelId: model })) {
    return reply(geminiNativeError(403, "API key does not permit this destination"));
  }
  if (isDraining()) return deps.drainingResponse(req, deps.policy);
  disableResponsesRequestTimeout(req, deps.requestServer);
  const start = Date.now(), requestId = nextRequestLogId(start);
  const context: RequestLogContext = { ...deps.requestMetricsLogContext, model, provider: "google-antigravity", client: classifyUsageClient(req.headers), ...admissionFields(admission) };
  const sessionReq = withCallerSessionIdentity(req, admission);
  return deps.runAdmittedHttpTurn(sessionReq, deps.policy, async lease => {
    const response = await handleGeminiNative(sessionReq, deps.config, model, match[2] === "streamGenerateContent", lease);
    return reply(logGeminiNativeDelivery(response, sessionReq, requestId, start, context));
  }, { requestId, start, logCtx: context });
}
