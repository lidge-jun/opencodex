/**
 * Dispatcher arm for the Gemini-compatible inbound API (the google-genai SDK with a custom base
 * URL, `agy` with the genai wire protocol). Like the Ollama arm it runs only for the exact native
 * paths and reuses the data-plane gates; refusals keep their status and retry advice and are
 * reshaped into the Gemini error body. Gemini clients authenticate with `x-goog-api-key` or a
 * `?key=` query parameter, so the request is cloned with that credential moved onto
 * `x-opencodex-api-key` and the query key dropped; the key is never logged or forwarded.
 */
import { classifyUsageClient } from "../../usage/client";
import { admissionFields, isAllowedRequestOrigin, resolveApiAuth, resolveResponsesApiAuth, withCors, type RequestPolicyView } from "../auth-cors";
import { withCallerSessionIdentity } from "../caller-session-identity";
import { captureAdmissionPolicy } from "../capture-admission-policy";
import { isDraining } from "../lifecycle";
import { parseGeminiNativePath } from "../gemini-native-paths";
import { geminiError, handleGeminiGeneration, handleGeminiModel, handleGeminiModels, toGeminiRefusal } from "../gemini-inbound";
import { nextRequestLogId, type RequestLogContext } from "../request-log";
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
  const { config, policy } = deps;
  if (original.method !== route.httpMethod) {
    const refused = geminiError(405, `method ${original.method} not allowed`);
    refused.headers.set("Allow", route.httpMethod);
    return withCors(refused, original, policy);
  }
  const generation = route.kind === "method" && (route.method === "generateContent" || route.method === "streamGenerateContent");
  if (generation) disableResponsesRequestTimeout(original, deps.requestServer);
  const req = withProxyCredential(original, url);
  if (!generation) {
    // Model discovery never forwards Authorization upstream, so the broader admission set is safe.
    const admission = resolveApiAuth(req, policy);
    if (!admission) return withCors(geminiError(401, "opencodex API key required"), original, policy);
    if (!isAllowedRequestOrigin(req, policy)) return withCors(geminiError(403, "cross-origin data-plane request blocked"), original, policy);
    const response = route.kind === "models" ? handleGeminiModels(config, req, admission)
      : route.kind === "model" ? handleGeminiModel(config, req, admission, route.model)
        : geminiError(501, `${route.method} is not supported`);
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
  const sse = url.searchParams.get("alt") === "sse";
  // Expose an id only when the handler or a logged refusal owns the history row.
  let ownsRequestLog = false;
  const advisorAdmissionPolicy = captureAdmissionPolicy(config, admission);
  const method = route.method as "generateContent" | "streamGenerateContent";
  const response = await deps.runAdmittedHttpTurn(sessionReq, policy, async turnAdmissionLease => {
    ownsRequestLog = true;
    return withCors(
      await handleGeminiGeneration(method, route.model, sse, sessionReq, config, logCtx, { requestId, start, turnAdmissionLease, admission, advisorAdmissionPolicy }),
      original,
      policy,
    );
  }, { requestId, start, logCtx, onLogged: () => { ownsRequestLog = true; } }, {
    mapRefusal: toGeminiRefusal,
    onAdmissionError: () => geminiError(499, "request cancelled"),
  });
  return ownsRequestLog ? withRequestLogId(response, requestId) : response;
}
