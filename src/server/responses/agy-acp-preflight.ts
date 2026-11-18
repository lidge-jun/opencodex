/**
 * Pipeline preflight for the Antigravity ACP provider (plan 080): refuse a turn its use policy forbids
 * with a structured HTTP 403 before sidecars run or a streaming response is committed. The adapter
 * repeats the same check before it starts the CLI, so internal and direct callers cannot bypass it.
 */
import { agyAcpPolicyRefusal } from "../../adapters/agy-acp/policy";
import { markProxyError, rememberProxyErrorMessage } from "../../lib/client-error-body";
import { markResponseNonReplayable } from "../../lib/upstream-retry";
import type { RequestLogContext } from "../request-log";

export function agyAcpPreflightResponse(input: {
  adapterName: string;
  requestHeaders: Headers;
  forwardHeaders: Headers;
  /** The parsed request body: the frame's own copy of Codex's turn metadata (memory turns). */
  body: unknown;
  inboundTransport?: "websocket";
  comboAttempt: boolean;
  internalDecisionCall: boolean;
  subagentFallback: boolean;
  logCtx: RequestLogContext;
}): Response | undefined {
  if (input.adapterName !== "agy-acp") return undefined;
  // A marker counts wherever it arrived: on the caller's request or on the forwarded set. The merge
  // is for this decision only; nothing here is forwarded.
  const headers = new Headers(input.requestHeaders);
  input.forwardHeaders.forEach((value, name) => headers.set(name, value));
  const refusal = agyAcpPolicyRefusal({
    headers, body: input.body, comboAttempt: input.comboAttempt, internalDecisionCall: input.internalDecisionCall,
    subagentFallback: input.subagentFallback, inboundTransport: input.inboundTransport,
  });
  if (!refusal) return undefined;
  const response = new Response(JSON.stringify({ error: {
    type: refusal.errorType, code: refusal.code, param: null, message: refusal.message,
  } }), { status: refusal.status, headers: { "Content-Type": "application/json" } });
  rememberProxyErrorMessage(input.logCtx, refusal.message, { status: refusal.status, type: refusal.errorType, code: refusal.code });
  markProxyError(response);
  markResponseNonReplayable(response);
  return response;
}
