/**
 * Dispatcher arm for the Ollama-compatible inbound API. It runs before the management /api/
 * catch-all and only for the exact native paths; every other /api/ path is untouched. Admission
 * reuses the data-plane gates: generation takes the same key, origin, drain, active-turn,
 * workflow and body admission as /v1/chat/completions, and the read-only routes take the
 * model-discovery admission /v1/models uses. Refusals keep their status and retry advice and are
 * reshaped into the native { "error": string } body.
 */
import type { Server } from "bun";
import type { OcxConfig } from "../../types";
import type { WsData } from "../ws-bridge";
import { classifyUsageClient } from "../../usage/client";
import { admissionFields, isAllowedRequestOrigin, resolveApiAuth, resolveResponsesApiAuth, withCors, type RequestPolicyView } from "../auth-cors";
import { withCallerSessionIdentity } from "../caller-session-identity";
import { captureAdmissionPolicy } from "../capture-admission-policy";
import { isDraining, type ActiveTurnLease } from "../lifecycle";
import { handleOllamaGeneration, handleOllamaShow, handleOllamaTags, handleOllamaVersion, ollamaError, toOllamaRefusal } from "../ollama-inbound";
import { OLLAMA_NATIVE_ROUTES } from "../ollama-native-paths";
import { nextRequestLogId, type RequestLogContext } from "../request-log";
import { disableResponsesRequestTimeout } from "../responses";
import type { AdmittedHttpTurnOptions } from "../admitted-http-turn";
import type { WorkflowRefusalLog } from "../workflow-refusal";
import { withRequestLogId } from "./startup-warnings";

export interface OllamaRouteDeps {
  config: OcxConfig;
  policy: RequestPolicyView;
  requestServer: Server<WsData>;
  requestMetricsLogContext: Partial<RequestLogContext>;
  drainingResponse: (req: Request, policy: RequestPolicyView) => Response;
  runAdmittedHttpTurn: (
    req: Request,
    policy: RequestPolicyView,
    work: (lease: ActiveTurnLease) => Promise<Response>,
    refusalLog?: WorkflowRefusalLog,
    options?: AdmittedHttpTurnOptions,
  ) => Promise<Response>;
}

/** Returns undefined when the path is not one of the native routes. */
export async function dispatchOllamaRoute(req: Request, url: URL, deps: OllamaRouteDeps): Promise<Response | undefined> {
  const route = OLLAMA_NATIVE_ROUTES.get(url.pathname);
  if (!route) return undefined;
  const { config, policy } = deps;
  if (req.method !== route.method) {
    const refused = ollamaError(405, `method ${req.method} not allowed`);
    refused.headers.set("Allow", route.method);
    return withCors(refused, req, policy);
  }
  if (route.kind === "version" || route.kind === "tags" || route.kind === "show") {
    // Model discovery never forwards Authorization upstream, so the broader admission set is safe.
    const admission = resolveApiAuth(req, policy);
    if (!admission) return withCors(ollamaError(401, "opencodex API key required"), req, policy);
    if (!isAllowedRequestOrigin(req, policy)) return withCors(ollamaError(403, "cross-origin data-plane request blocked"), req, policy);
    const response = route.kind === "version" ? handleOllamaVersion()
      : route.kind === "tags" ? handleOllamaTags(config, req, admission)
        : await handleOllamaShow(config, req, admission);
    return withCors(response, req, policy);
  }
  const kind = route.kind;
  disableResponsesRequestTimeout(req, deps.requestServer);
  if (isDraining()) return withCors(toOllamaRefusal(deps.drainingResponse(req, policy)), req, policy);
  const admission = resolveResponsesApiAuth(req, policy);
  if (!admission) return withCors(ollamaError(401, "opencodex API key required"), req, policy);
  if (!isAllowedRequestOrigin(req, policy)) return withCors(ollamaError(403, "cross-origin data-plane request blocked"), req, policy);
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
  // Expose an id only when the handler or a logged refusal owns the history row.
  let ownsRequestLog = false;
  const advisorAdmissionPolicy = captureAdmissionPolicy(config, admission);
  const response = await deps.runAdmittedHttpTurn(sessionReq, policy, async turnAdmissionLease => {
    ownsRequestLog = true;
    return withCors(
      await handleOllamaGeneration(kind, sessionReq, config, logCtx, { requestId, start, turnAdmissionLease, admission, advisorAdmissionPolicy }),
      req,
      policy,
    );
  }, { requestId, start, logCtx, onLogged: () => { ownsRequestLog = true; } }, {
    mapRefusal: toOllamaRefusal,
    onAdmissionError: () => ollamaError(499, "request cancelled"),
  });
  return ownsRequestLog ? withRequestLogId(response, requestId) : response;
}
