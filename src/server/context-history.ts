/** Native history/notes JSON relay. No interpretation of encrypted tool arguments or retries. */
import { formatErrorResponse } from "../bridge";
import {
  CodexAccountCooldownError, CodexAuthContextError, CodexMainProfileDrainingError, CodexDirectAuthenticationError,
  CodexPoolAuthenticationError, CodexThreadAffinityExpiredError, CodexMainSubstitutionUnavailableError,
  codexMainProfileDrainingResponse, cooldownErrorResponse,
  materializeCodexUpstreamAuth, isCodexAuthContextUsable, resolveCodexAuthContext, releaseCodexAuthContextProbeLease,
} from "../codex/auth-context";
import { getContextSessionOwner, contextSessionOwnerMatches } from "../codex/context-owner";
import { contextEndpoint, contextRelayActivated } from "../codex/context-compat";
import { formatCodexProviderForLog } from "../codex/routing";
import { listOpenAiForwardSidecarCandidates } from "../providers/openai-sidecar";
import { clearableDeadline, type ClearableDeadline } from "../lib/abort";
import { readBoundedResponseBytes } from "../lib/bounded-body";
import type { AdmissionLease } from "../lib/admission";
import type { OcxConfig } from "../types";
import { resolveContextPrincipal, ForwardAdmissionCredentialError, validateForwardAdmissionCredential, type DataPlaneAdmission } from "./auth-cors";
import { readBoundedJsonRequestBody } from "./request-decompress";
import { codexLogAccountId, decodeRequestErrorResponse } from "./responses";
import { codexAccountSelectionForTurn } from "./lifecycle";
import type { RequestLogContext } from "./request-log";

const PROTOCOL_HEADERS = ["x-openai-encrypted-tool-arguments", "x-openai-tool-output-truncation-policy"];
const RESPONSE_HEADERS = ["content-type", "retry-after", "x-request-id", "openai-processing-ms", ...PROTOCOL_HEADERS];
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_REQUEST_BYTES = 16 * 1024 * 1024;
const RELAY_DEADLINE_MS = 35_000;

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

/**
 * One deadline covers the whole operation, starting before the body is read.
 *
 * Reading the body and selecting a credential are both waits a caller controls, and this route
 * holds an admitted turn slot for their duration. A deadline that started at dispatch would let
 * an unfinished body or a stalled refresh hold that slot with no bound at all.
 */
export async function handleContextHistory(
  req: Request, config: OcxConfig, logCtx: RequestLogContext,
  endpoint: string, turnAdmissionLease?: AdmissionLease, admission?: DataPlaneAdmission,
  revalidateAdmission?: () => DataPlaneAdmission | null,
): Promise<Response> {
  const deadline = clearableDeadline(RELAY_DEADLINE_MS, req.signal);
  try {
    return await relayContextHistory(req, config, logCtx, endpoint, deadline, turnAdmissionLease,
      admission, revalidateAdmission);
  } finally {
    deadline.clear();
  }
}

async function relayContextHistory(
  req: Request, config: OcxConfig, logCtx: RequestLogContext,
  endpoint: string, deadline: ClearableDeadline,
  turnAdmissionLease?: AdmissionLease, admission?: DataPlaneAdmission,
  revalidateAdmission?: () => DataPlaneAdmission | null,
): Promise<Response> {
  // The feature is opt-in, and the opt-in has to hold here rather than only where the injected
  // base URL is rewritten: a caller that can reach the data plane can POST these paths directly.
  // While it is off the endpoints do not exist, which is also what a disabled route should look
  // like from outside.
  if (!contextEndpoint("/v1/" + endpoint) || req.method !== "POST" || !contextRelayActivated()) {
    return formatErrorResponse(404, "not_found", "Unknown context endpoint");
  }
  // Only a trusted listener admission authorizes replacing a proxy bearer with Codex auth.
  const substituteMainCredential = admission?.source === "bearer";
  try { if (!substituteMainCredential) validateForwardAdmissionCredential(req.headers, config); }
  catch (err) {
    if (err instanceof ForwardAdmissionCredentialError) return formatErrorResponse(401, "authentication_error", err.message);
    throw err;
  }
  // A workspace is not a person and a local socket is not a caller. Ownership is keyed by the
  // admission secret that was actually matched, so an admission that carries no principal —
  // loopback — cannot own or reach a session.
  const principalId = resolveContextPrincipal(req, config, admission);
  if (!principalId) {
    return formatErrorResponse(403, "context_principal_required",
      "Context history requires an opencodex API key on the request; admission alone carries no caller identity");
  }
  let body: unknown;
  try { body = await readBoundedJsonRequestBody(req, MAX_REQUEST_BYTES, undefined, { signal: deadline.signal }); }
  catch (err) {
    const cancelled = cancellationResponse(req, deadline);
    if (cancelled) return cancelled;
    return decodeRequestErrorResponse(err, "context_history");
  }
  const sessionId = (body as {context?: {session_id?: unknown}} | null)?.context?.session_id;
  if (typeof sessionId !== "string" || !/^[A-Za-z0-9._:-]{1,512}$/.test(sessionId)) {
    return formatErrorResponse(400, "invalid_request_error", "context.session_id must be a bounded nonempty string");
  }
  const candidate = listOpenAiForwardSidecarCandidates(config)[0];
  if (!candidate) return formatErrorResponse(400, "invalid_request_error", "History and notes require the native ChatGPT forward provider");
  const rootHeader = req.headers.get("x-codex-parent-thread-id")?.trim() || req.headers.get("session-id")?.trim();
  if (rootHeader && rootHeader !== sessionId) {
    return formatErrorResponse(409, "context_account_unavailable", "Context root does not match this request");
  }
  const owner = getContextSessionOwner(principalId, sessionId, candidate.provider.baseUrl);
  if (!owner || owner.ambiguous || (owner.kind === "caller" && substituteMainCredential)) {
    return formatErrorResponse(409, "context_account_unavailable",
      "Context account ownership is unavailable; start a new session and preserve needed state before resetting context");
  }
  let authContext: Awaited<ReturnType<typeof resolveCodexAuthContext>>;
  const headers = new Headers(candidate.provider.headers);
  try {
    authContext = await resolveCodexAuthContext(contextSelectionHeaders(req.headers, sessionId), config, owner.kind === "stored" ? "pool" : "direct", {
      // The same deadline bounds credential selection and refresh waits.
      signal: deadline.signal,
      // Resolve the proven physical owner as an explicit account. Context operations
      // never create affinity, rotate on quota, or inspect file-main for a caller owner.
      modelId: "context_history",
      ...(owner.kind === "stored" ? { accountId: owner.accountId } : { requestScopedMainCredential: true }),
      admission,
      substituteMainCredentialForDirect: substituteMainCredential,
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
    for (const [key, value] of materializeCodexUpstreamAuth(req.headers, authContext, {
      config, modelId: "context_history", admission, substituteMainCredential,
    })) {
      headers.set(key, value);
    }
    // Check the assembled outbound headers, including configured provider headers.
    validateForwardAdmissionCredential(headers, config);
    // Recheck actual wire identity after async selection/materialization. A replaced
    // account slot or login must not receive another physical account's history.
    const currentOwner = getContextSessionOwner(principalId, sessionId, candidate.provider.baseUrl);
    if (!currentOwner || currentOwner.kind !== owner.kind
      || !contextSessionOwnerMatches(owner, headers) || !contextSessionOwnerMatches(currentOwner, headers)) {
      return formatErrorResponse(409, "context_account_unavailable", "Context account identity changed; start a new session");
    }
  } catch (err) {
    const cancelled = cancellationResponse(req, deadline);
    if (cancelled) return cancelled;
    if (err instanceof CodexAccountCooldownError) return cooldownErrorResponse(err);
    if (err instanceof CodexMainProfileDrainingError) return codexMainProfileDrainingResponse();
    if (err instanceof CodexThreadAffinityExpiredError) return formatErrorResponse(409, "invalid_request_error", "Codex thread account affinity expired; start a new session");
    if (err instanceof CodexAuthContextError || err instanceof CodexPoolAuthenticationError || err instanceof CodexDirectAuthenticationError
      || err instanceof CodexMainSubstitutionUnavailableError || err instanceof ForwardAdmissionCredentialError) {
      return formatErrorResponse(401, "authentication_error", "Selected Codex account is unavailable or needs reauthentication");
    }
    throw err;
  }
  headers.set("content-type", "application/json");
  for (const key of PROTOCOL_HEADERS) {
    const value = req.headers.get(key); if (value !== null) headers.set(key, value);
  }
  // Nothing is dispatched after cancellation; a notes write is not replayable.
  const cancelledBeforeDispatch = cancellationResponse(req, deadline);
  if (cancelledBeforeDispatch) return cancelledBeforeDispatch;
  // Body reading and credential selection are both waits, and a key can be revoked, rotated or
  // replaced during them. Re-resolve admission against the receiving listener policy and require
  // the same principal, so a withdrawn key cannot dispatch on a snapshot taken minutes earlier.
  if (revalidateAdmission && resolveContextPrincipal(req, config, revalidateAdmission() ?? undefined) !== principalId) {
    return formatErrorResponse(401, "authentication_error",
      "opencodex API key changed during this request; retry with current credentials");
  }
  // The operator may disable the feature while body or credential IO is pending.
  if (!contextRelayActivated()) return formatErrorResponse(404, "not_found", "Unknown context endpoint");
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
    return cancellationResponse(req, deadline)
      ?? formatErrorResponse(502, "upstream_error", "Context upstream connection failed");
  } finally {
    if (response?.body && !response.body.locked) void response.body.cancel().catch(() => undefined);
  }
}

/** Client cancellation and deadline expiry are different outcomes and must not share a status. */
function cancellationResponse(req: Request, deadline: ClearableDeadline): Response | undefined {
  if (req.signal.aborted) {
    return formatErrorResponse(499, "client_closed_request", "Context request canceled by client");
  }
  if (deadline.didExpire()) {
    return formatErrorResponse(504, "upstream_error", "Context operation exceeded its deadline");
  }
  return undefined;
}
