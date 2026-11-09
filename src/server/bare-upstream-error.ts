import {
  CYBER_POLICY_ERROR_CODE,
  isCyberPolicyMessage,
  isTerminalRefusalCode,
  recognizedUpstreamError,
  safetyRefusalCodeFromMessage,
  terminalRefusalFallbackMessage,
  upstreamErrorMessageFromPayload,
} from "../lib/errors";
import { redactSecretString } from "../lib/redact";
import { codexWsWrapperStatus } from "./responses/codex-ws-wire";

type JsonRecord = Record<string, unknown>;
export const MAX_BARE_ERROR_MESSAGE_CHARS = 512;
const record = (value: unknown): JsonRecord | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : undefined;
const field = (value: JsonRecord | undefined, key: string): string | undefined => {
  const item = value?.[key];
  return typeof item === "string" && item.trim() ? item.trim() : undefined;
};

/** Codes this proxy's own transport layer assigns to a delivery failure, not a provider verdict. */
function isTransportFailureCode(code: string): boolean {
  return /^(?:upstream_|transport_|network_|connection_|socket_|adapter_|stream_)/.test(code);
}

/** Only absent root type plus an error object qualifies as an untyped envelope. */
export function isUntypedBareUpstreamError(payload: unknown): boolean {
  const root = record(payload);
  return !!root && root.type === undefined && record(root.error) !== undefined;
}

export interface BareUpstreamError {
  message: string;
  refusalCode: string | undefined;
  /** The wire identity and status the client tail carries, derived once for every reader. */
  errorType: string | undefined;
  terminalType: string;
  terminalCode: string;
  /** The one server status every reader records; never absent. */
  terminalStatus: number;
  errorCode: string | undefined;
  /** Same value as {@link terminalStatus}, kept for the row's existing field name. */
  httpStatus: number;
}

/** Preserve first-code precedence when deriving a bounded provisional stream verdict. */
export function bareUpstreamError(payload: unknown): BareUpstreamError | undefined {
  const root = record(payload);
  const untyped = isUntypedBareUpstreamError(payload);
  // A bare error is a typed `error` event or an untyped envelope. `response.failed` is a genuine
  // terminal and belongs to the terminal classifier, not to this provisional evidence.
  if (!root || (root.type !== "error" && !untyped)) return undefined;
  const response = record(root.response);
  // A typed `error` frame carries its class on the envelope; an untyped one carries it inside
  // the error object. Reading the envelope first for both would let a stray top-level `code`
  // outrank the structured class the provider actually stated.
  const candidates = untyped
    ? [record(root.error), record(root.last_error), record(response?.error), record(response?.incomplete_details), root]
    : [root, record(root.error), record(root.last_error), record(response?.error), record(response?.incomplete_details)];
  const code = candidates.map(candidate => field(candidate, "code")).find(value => value !== undefined)?.slice(0, 128);
  // The envelope's own `type` is `error` or the terminal event name, never the error class.
  const errorType = (untyped ? candidates.slice(0, -1) : candidates.slice(1))
    .map(candidate => field(candidate, "type")).find(value => value !== undefined)?.slice(0, 128);
  // The message follows the same precedence as the class: a typed frame's own envelope copy is
  // the provider's verdict, while an untyped envelope's copy lives inside its error object.
  const rawMessage = untyped
    ? upstreamErrorMessageFromPayload(payload)
    : field(root, "message") ?? upstreamErrorMessageFromPayload(payload);
  const message = rawMessage ? redactSecretString(rawMessage).slice(0, MAX_BARE_ERROR_MESSAGE_CHARS) : undefined;
  // An explicit refusal code is the provider's own verdict. Otherwise verified refusal copy is
  // recognized beside an unrelated code: a gateway that wraps the refusal in its own class still
  // ended the turn with a refusal, and retrying it would loop. A recognized quota/overload class
  // is stronger evidence than copy and keeps its identity instead. A transport code names the
  // delivery failure rather than the provider's verdict, so copy quoted inside its diagnostic
  // text is not evidence of a refusal.
  const refusalCode = isTerminalRefusalCode(code) ? code
    : message === undefined || recognizedUpstreamError({ type: errorType, code }) !== undefined
      || (code !== undefined && isTransportFailureCode(code)) ? undefined
      : isCyberPolicyMessage(message) ? CYBER_POLICY_ERROR_CODE : safetyRefusalCodeFromMessage(message);
  if (message === undefined && refusalCode === undefined && code === undefined && errorType === undefined && !untyped) return undefined;
  const recognized = recognizedUpstreamError({ type: errorType, code });
  const fallback = code ?? errorType;
  // A recognized class outranks an unknown code in the same verdict: the row records the class's
  // status, so the client must carry the class identity rather than a generic retryable code.
  // A refusal keeps its own identity and is never retried. An unrecognized class is still a
  // provider verdict, so it keeps the wrapper status the upstream stated (a WebSocket `error`
  // carries one) and otherwise the synthetic 502 every reader already used.
  const terminalType = refusalCode !== undefined
    ? "invalid_request_error" : recognized?.type ?? "upstream_error";
  const terminalCode = refusalCode ?? recognized?.code ?? "upstream_server_error";
  const wrapped = wrappedServerErrorStatus(payload);
  const terminalStatus = refusalCode !== undefined ? 400 : recognized?.httpStatus ?? wrapped ?? 502;
  return {
    message: message ?? (refusalCode ? terminalRefusalFallbackMessage(refusalCode)
      : fallback ? `Upstream error without a message (${redactSecretString(fallback)})` : "The upstream reported an error."),
    refusalCode,
    errorType,
    errorCode: code,
    terminalType,
    terminalCode,
    terminalStatus,
    httpStatus: terminalStatus,
  };
}

/**
 * The server status a Codex WebSocket `error` frame states on its wrapper ({@link codexWsWrapperStatus}),
 * or undefined. Only 5xx is returned. Every 5xx is the same transient class for account health, so
 * this changes what a row says, not where the next turn goes; a wrapper 4xx would move quota and
 * credential routing and is left to its own review (#6740).
 */
export function wrappedServerErrorStatus(payload: unknown): number | undefined {
  const status = codexWsWrapperStatus(payload as Record<string, unknown>);
  return status !== undefined && status >= 500 ? status : undefined;
}

export interface BareUpstreamEvidence {
  typed: boolean;
  verdict: BareUpstreamError;
}

/**
 * One precedence rule for every reader of bare upstream errors.
 *
 * A typed bare `error` is the provider's structured verdict, so the newest typed
 * frame wins. An untyped envelope is weaker evidence: it may replace an earlier
 * untyped frame, but it never replaces a typed verdict. A genuine terminal is not
 * bare evidence and supersedes both, which is why the reducer only ever sees
 * bare frames.
 */
export function reduceBareUpstreamEvidence(
  previous: BareUpstreamEvidence | undefined,
  payload: unknown,
): BareUpstreamEvidence | undefined {
  const verdict = bareUpstreamError(payload);
  if (verdict === undefined) return previous;
  const typed = !isUntypedBareUpstreamError(payload);
  // The stored verdict decides: an untyped frame may replace untyped evidence, never typed.
  if (!typed && previous?.typed === true) return previous;
  return { typed, verdict };
}

/**
 * Whether a payload is bare evidence at all, independent of whether it wins.
 *
 * The reducer returns the previous evidence for a frame that is not bare, so a caller
 * that must distinguish "no new evidence" from "a weaker frame lost" asks this first.
 * A genuine Responses terminal is not bare evidence and is handled by the terminal
 * classifier, never by the provisional reducer.
 */
export function isBareUpstreamErrorPayload(payload: unknown): boolean {
  const root = record(payload);
  return !!root && (root.type === "error" || isUntypedBareUpstreamError(payload));
}
