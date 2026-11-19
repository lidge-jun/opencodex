/**
 * Dispatcher arm for the Gemini-compatible inbound API (the google-genai SDK with a custom base
 * URL, `agy` with the genai wire protocol). Like the Ollama arm it runs only for the exact native
 * paths and reuses the data-plane gates; refusals keep their status and retry advice and are
 * reshaped into the Gemini error body. Gemini clients authenticate with `x-goog-api-key` or a
 * `?key=` query parameter, so the request is cloned with that credential moved onto
 * `x-opencodex-api-key` and the query key dropped; the key is never logged or forwarded.
 */
import { ADVISOR_INTERNAL_CAPABILITY_HEADER } from "../../lib/local-internal-call-capability";
import { clientFacingModelLabel, clientFacingModelText } from "../../lib/error-destination";
import { classifyUsageClient } from "../../usage/client";
import { admissionFields, isAllowedRequestOrigin, resolveApiAuth, resolveResponsesApiAuth, withCors } from "../auth-cors";
import { AdmissionModelDeniedError, projectAdmissionModelDeniedLog, routeAllowedByScope } from "../admission-model-scope";
import { SIDECAR_INTERNAL_CAPABILITY_HEADER } from "../advisor-admission-scope";
import { withCallerSessionIdentity } from "../caller-session-identity";
import { captureAdmissionPolicy } from "../capture-admission-policy";
import { isDraining } from "../lifecycle";
import { geminiRouteAllowHeader, geminiRouteAllows, parseGeminiNativePath, type GeminiNativeRoute } from "../gemini-native-paths";
import { geminiError, handleGeminiCountTokens, handleGeminiGeneration, handleGeminiModel, handleGeminiModels, toGeminiRefusal } from "../gemini-inbound";
import { handleGeminiInteraction, handleGeminiInteractionResource } from "../gemini-interactions-inbound";
import { nativeGeminiDestination } from "../gemini-native-catalog";
import { handleGeminiNative } from "../gemini-native";
import { logGeminiNativeDelivery } from "../gemini-native-log";
import { nativeInnerErrorMessage } from "../native-chat-bridge";
import { nextRequestLogId, type RequestLogContext } from "../request-log";
import { runAdmittedBodyWork } from "../inbound-body-admission";
import { disableResponsesRequestTimeout } from "../responses";
import { withRequestLogId } from "./startup-warnings";
import type { OllamaRouteDeps } from "./ollama-routes";

export type GeminiRouteDeps = OllamaRouteDeps;

/** Move the Gemini credential onto the proxy's dedicated header and drop it from the URL. */
function withProxyCredential(req: Request, url: URL): Request {
  const headers = new Headers(req.headers);
  const key = headers.get("x-goog-api-key")?.trim() || url.searchParams.get("key")?.trim();
  headers.delete("x-goog-api-key");
  if (key && !headers.get("x-opencodex-api-key")?.trim()) headers.set("x-opencodex-api-key", key);
  const clean = new URL(url);
  clean.searchParams.delete("key");
  const init: RequestInit & { duplex?: "half" } = { method: req.method, headers, signal: req.signal };
  if (req.body) { init.body = req.body; init.duplex = "half"; }
  return new Request(clean, init);
}

/** Returns undefined when the path is not one of the native routes. */
export async function dispatchGeminiRoute(original: Request, url: URL, deps: GeminiRouteDeps): Promise<Response | undefined> {
  const route = parseGeminiNativePath(url.pathname);
  if (!route) return undefined;
  const response = await handleGeminiRoute(route, original, url, deps);
  if (route.kind === "interactions" || route.kind === "interaction" || route.kind === "interaction-cancel") {
    // A cached success or miss must never cross the interaction owner's credential boundary.
    response.headers.set("Cache-Control", "no-store");
  }
  return response;
}

async function handleGeminiRoute(route: GeminiNativeRoute, original: Request, url: URL, deps: GeminiRouteDeps): Promise<Response> {
  const { config, policy } = deps;
  if (!geminiRouteAllows(route, original.method)) {
    const refused = geminiError(405, `method ${original.method} not allowed`);
    refused.headers.set("Allow", geminiRouteAllowHeader(route));
    return withCors(refused, original, policy);
  }
  const generation = route.kind === "interactions"
    || (route.kind === "method" && (route.method === "generateContent" || route.method === "streamGenerateContent"));
  if (generation) disableResponsesRequestTimeout(original, deps.requestServer);
  const req = withProxyCredential(original, url);
  if (route.kind === "interaction" || route.kind === "interaction-cancel") {
    // Stored interactions take the same admission as creating them, so the keys that can read or
    // delete one are exactly the keys that can create one.
    const admission = resolveResponsesApiAuth(req, policy);
    if (!admission) return withCors(geminiError(401, "opencodex API key required"), original, policy);
    if (!isAllowedRequestOrigin(req, policy)) return withCors(geminiError(403, "cross-origin data-plane request blocked"), original, policy);
    return withCors(handleGeminiInteractionResource(route, req, config, admission), original, policy);
  }
  if (!generation) {
    // Model discovery never forwards Authorization upstream, so the broader admission set is safe.
    const admission = resolveApiAuth(req, policy);
    if (!admission) return withCors(geminiError(401, "opencodex API key required"), original, policy);
    if (!isAllowedRequestOrigin(req, policy)) return withCors(geminiError(403, "cross-origin data-plane request blocked"), original, policy);
    const response = route.kind === "models" ? handleGeminiModels(config, req, admission)
      : route.kind === "model" ? handleGeminiModel(config, req, admission, route.model)
        // countTokens reads and decodes a body, so it holds the shared body allowance until its
        // answer settles; it sends nothing upstream and takes no turn slot.
        : route.kind === "method" && route.method === "countTokens"
          ? await runAdmittedBodyWork(req, policy, config.maxInboundBodyBytes,
            () => handleGeminiCountTokens(config, req, admission, route.model), undefined, toGeminiRefusal,
            () => geminiError(499, "request cancelled"))
          : route.kind === "method" ? geminiError(501, `${route.method} is not supported`)
            : geminiError(405, "method not allowed");
    return withCors(response, original, policy);
  }
  if (isDraining()) return withCors(toGeminiRefusal(deps.drainingResponse(req, policy)), original, policy);
  const admission = resolveResponsesApiAuth(req, policy);
  if (!admission) return withCors(geminiError(401, "opencodex API key required"), original, policy);
  if (!isAllowedRequestOrigin(req, policy)) return withCors(geminiError(403, "cross-origin data-plane request blocked"), original, policy);
  const start = Date.now();
  const requestId = nextRequestLogId(start);
  const logCtx: RequestLogContext = {
    model: "unknown",
    provider: "unknown",
    ...deps.requestMetricsLogContext,
    client: classifyUsageClient(req.headers),
    ...admissionFields(admission),
  };
  const sessionReq = withCallerSessionIdentity(req, admission);
  // Discovery-style clients spell the parameter `$alt`.
  const sse = (url.searchParams.get("alt") ?? url.searchParams.get("$alt")) === "sse";
  // Expose an id only when the handler or a logged refusal owns the history row.
  let ownsRequestLog = false;
  const advisorAdmissionPolicy = captureAdmissionPolicy(config, admission);
  const response = await deps.runAdmittedHttpTurn(sessionReq, policy, async turnAdmissionLease => {
    ownsRequestLog = true;
    // Internal Advisor and sidecar hops keep the Chat bridge's capability and inherited-policy checks.
    const native = route.kind === "method" && url.pathname.startsWith("/v1beta/") && !sessionReq.headers.has(ADVISOR_INTERNAL_CAPABILITY_HEADER)
      && !sessionReq.headers.has(SIDECAR_INTERNAL_CAPABILITY_HEADER)
      ? nativeGeminiDestination(config, sessionReq, route.model) : undefined;
    if (native && route.kind === "method") {
      const modelLabel = clientFacingModelLabel(route.model);
      logCtx.requestedModel = clientFacingModelText(modelLabel);
      let result: Response;
      if (!routeAllowedByScope(advisorAdmissionPolicy.modelScope, native.route)) {
        projectAdmissionModelDeniedLog(new AdmissionModelDeniedError(modelLabel, native.route), logCtx);
        result = geminiError(403, nativeInnerErrorMessage(403));
      } else {
        logCtx.model = native.route.modelId;
        logCtx.provider = native.route.providerName;
        logCtx.routeDecision = native.route.routeDecision;
        const delivery = route.method === "streamGenerateContent" ? (sse ? "sse" : "array") : undefined;
        result = await handleGeminiNative(sessionReq, config, native.wireModel, delivery, turnAdmissionLease, undefined, logCtx, start);
      }
      return withCors(logGeminiNativeDelivery(result, sessionReq, requestId, start, logCtx), original, policy);
    }
    const ids = { requestId, start, turnAdmissionLease, admission, advisorAdmissionPolicy };
    return withCors(
      route.kind === "method"
        ? await handleGeminiGeneration(route.method as "generateContent" | "streamGenerateContent", route.model, sse, sessionReq, config, logCtx, ids)
        : await handleGeminiInteraction(sessionReq, config, logCtx, ids),
      original,
      policy,
    );
  }, { requestId, start, logCtx, onLogged: () => { ownsRequestLog = true; } }, {
    mapRefusal: toGeminiRefusal,
    onAdmissionError: () => geminiError(499, "request cancelled"),
  });
  return ownsRequestLog ? withRequestLogId(response, requestId) : response;
}
