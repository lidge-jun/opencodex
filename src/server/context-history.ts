/** Native history/notes JSON relay. No interpretation of encrypted tool arguments or retries. */
import { formatErrorResponse } from "../bridge";
import {
  CodexAccountCooldownError, CodexAuthContextError, CodexMainProfileDrainingError, CodexDirectAuthenticationError,
  CodexPoolAuthenticationError, CodexThreadAffinityExpiredError,
  codexMainProfileDrainingResponse, cooldownErrorResponse,
  headersForCodexAuthContext, isCodexAuthContextUsable, resolveCodexAuthContext, releaseCodexAuthContextProbeLease,
} from "../codex/auth-context";
import { contextEndpoint } from "../codex/context-compat";
import { formatCodexProviderForLog } from "../codex/routing";
import { listOpenAiForwardSidecarCandidates } from "../providers/openai-sidecar";
import { signalWithTimeout } from "../lib/abort";
import { readBoundedResponseBytes } from "../lib/bounded-body";
import type { AdmissionLease } from "../lib/admission";
import type { OcxConfig } from "../types";
import { ForwardAdmissionCredentialError, validateForwardAdmissionCredential } from "./auth-cors";
import { readJsonRequestBody } from "./request-decompress";
import { codexLogAccountId, decodeRequestErrorResponse } from "./responses";
import { codexAccountSelectionForTurn } from "./lifecycle";
import type { RequestLogContext } from "./request-log";

const PROTOCOL_HEADERS = ["x-openai-encrypted-tool-arguments", "x-openai-tool-output-truncation-policy"];
const RESPONSE_HEADERS = ["content-type", "retry-after", "x-request-id", "openai-processing-ms", ...PROTOCOL_HEADERS];
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

export function contextSelectionHeaders(headers: Headers, sessionId: string): Headers {
  const result = new Headers(headers);
  // Codex history tools carry root session_id in JSON, unlike Responses' HTTP headers.
  // Root model requests use (session-id=root, thread-id=root); don't fabricate a parent key.
  if (!result.has("x-codex-parent-thread-id") && !result.has("session-id") && !result.has("thread-id")) {
    result.set("session-id", sessionId);
    result.set("thread-id", sessionId);
  }
  return result;
}

export async function handleContextHistory(
  req: Request, config: OcxConfig, logCtx: RequestLogContext,
  endpoint: string, turnAdmissionLease?: AdmissionLease,
): Promise<Response> {
  if (!contextEndpoint("/v1/" + endpoint) || req.method !== "POST") {
    return formatErrorResponse(404, "not_found", "Unknown context endpoint");
  }
  try { validateForwardAdmissionCredential(req.headers, config); }
  catch (err) {
    if (err instanceof ForwardAdmissionCredentialError) return formatErrorResponse(401, "authentication_error", err.message);
    throw err;
  }
  let body: unknown;
  try { body = await readJsonRequestBody(req); }
  catch (err) { return decodeRequestErrorResponse(err, "context_history"); }
  const sessionId = (body as {context?: {session_id?: unknown}} | null)?.context?.session_id;
  if (typeof sessionId !== "string" || !/^[A-Za-z0-9._:-]{1,512}$/.test(sessionId)) {
    return formatErrorResponse(400, "invalid_request_error", "context.session_id must be a bounded nonempty string");
  }
  const candidate = listOpenAiForwardSidecarCandidates(config)[0];
  if (!candidate) return formatErrorResponse(400, "invalid_request_error", "History and notes require the native ChatGPT forward provider");
  let authContext: Awaited<ReturnType<typeof resolveCodexAuthContext>>;
  const headers = new Headers(candidate.provider.headers);
  try {
    authContext = await resolveCodexAuthContext(contextSelectionHeaders(req.headers, sessionId), config, candidate.accountMode, {
      // Non-Spark context tools share the ordinary model quota/affinity scope, not legacy.
      modelId: "context_history",
      beginCodexAccountSelection: codexAccountSelectionForTurn(turnAdmissionLease),
    });
    if (authContext.kind !== "main" && authContext.probeLeaseId) {
      // History traffic must not occupy or settle the model's quota-recovery probe.
      releaseCodexAuthContextProbeLease(authContext);
      return formatErrorResponse(503, "upstream_error", "Model quota recovery is pending; retry context operation later");
    }
    if (!isCodexAuthContextUsable(authContext, config)) throw new CodexPoolAuthenticationError("Selected Codex account is unavailable");
    logCtx.provider = formatCodexProviderForLog(candidate.providerName, codexLogAccountId(authContext), config);
    // Materialization rechecks the current account policy after async selection.
    // Synthetic lane IDs are local selection metadata, never upstream headers.
    for (const [key, value] of headersForCodexAuthContext(req.headers, authContext, config, "context_history")) {
      headers.set(key, value);
    }
  } catch (err) {
    if (err instanceof CodexAccountCooldownError) return cooldownErrorResponse(err);
    if (err instanceof CodexMainProfileDrainingError) return codexMainProfileDrainingResponse();
    if (err instanceof CodexThreadAffinityExpiredError) return formatErrorResponse(409, "invalid_request_error", "Codex thread account affinity expired; start a new session");
    if (err instanceof CodexAuthContextError || err instanceof CodexPoolAuthenticationError || err instanceof CodexDirectAuthenticationError) {
      return formatErrorResponse(401, "authentication_error", "Selected Codex account is unavailable or needs reauthentication");
    }
    throw err;
  }
  headers.set("content-type", "application/json");
  for (const key of PROTOCOL_HEADERS) {
    const value = req.headers.get(key); if (value !== null) headers.set(key, value);
  }
  const deadline = signalWithTimeout(35_000, req.signal);
  let response: Response | undefined;
  try {
    response = await fetch(`${candidate.provider.baseUrl}/${endpoint}`, {
      method: "POST", headers, body: JSON.stringify(body), signal: deadline.signal, redirect: "manual",
    });
    const result = await readBoundedResponseBytes(response, {maxBytes: MAX_RESPONSE_BYTES, signal: deadline.signal});
    if (result.oversized) return formatErrorResponse(502, "upstream_error", "Context response exceeded 16 MiB");
    const outputHeaders = new Headers();
    for (const key of RESPONSE_HEADERS) {
      const value = response.headers.get(key); if (value !== null) outputHeaders.set(key, value);
    }
    // A context 403 is not evidence that the model credential is invalid. Don't mutate pool
    // health/quota or retry writes; preserve the real upstream result for the caller.
    return new Response([204,205,304].includes(response.status) ? null : result.bytes, {status:response.status, headers:outputHeaders});
  } catch {
    if (req.signal.aborted) return formatErrorResponse(499, "client_closed_request", "Context request canceled by client");
    if (deadline.signal.aborted) return formatErrorResponse(504, "upstream_error", "Context upstream timed out");
    return formatErrorResponse(502, "upstream_error", "Context upstream connection failed");
  } finally {
    deadline.cleanup();
    if (response?.body && !response.body.locked) void response.body.cancel().catch(() => undefined);
  }
}
