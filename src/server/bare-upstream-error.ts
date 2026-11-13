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
import { outboundCredentials } from "../lib/outbound-credential-registry";
import { codexWsWrapperStatus } from "./responses/codex-ws-wire";
import { configuredCredentials, containsConfiguredCredentialExcerpt } from "./configured-credentials";

type JsonRecord = Record<string, unknown>;
export const MAX_BARE_ERROR_MESSAGE_CHARS = 512;
const record = (value: unknown): JsonRecord | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : undefined;
const field = (value: JsonRecord | undefined, key: string): string | undefined => {
  const item = value?.[key];
  return typeof item === "string" && item.trim() ? item.trim() : undefined;
};
const MAX_BARE_CLASS_CHARS = 128;
/** A class identifier longer than the bound is not a class; truncating it could keep a credential prefix. */
const classField = (value: JsonRecord | undefined, key: string): string | undefined => {
  const item = field(value, key);
  return item !== undefined && item.length <= MAX_BARE_CLASS_CHARS ? item : undefined;
};

/**
 * Masks upstream copy before anything bounds it. A bound applied first can keep a prefix of a long
 * credential that a later full-value mask no longer recognizes. The relay passes its per-request
 * outbound mask; every reader also refuses copy that contains a credential this process sent, and
 * refuses all copy while the registry cannot vouch for every sent credential (one too large to keep).
 */
export type BareCopyMask = (text: string) => string;
export function guardBareCopy(raw: string, mask?: BareCopyMask): string {
  const masked = mask ? mask(raw) : raw;
  const registry = outboundCredentials();
  return !registry.complete() || registry.matches(masked) ? "[REDACTED]" : masked;
}

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
  /**
   * The status the provider itself stated: an explicit refusal (400), a recognized class, or a
   * Codex WebSocket wrapper 5xx. Undefined for an unrecognized class, so a reader that has a wider
   * set of explicit fields (combo preflight) or a transport failure that followed (a read reset)
   * still decides; {@link terminalStatus} is the synthetic wire status for the same verdict.
   */
  httpStatus: number | undefined;
  /**
   * Whether the copy may be kept on a request row. Decided on the full upstream text, before any
   * bound, against every configured credential (not only the ones sent on this request), and false
   * while that set cannot vouch for complete coverage. The client tail is unaffected.
   */
  rowCopyAllowed: boolean;
}

/** Preserve first-code precedence when deriving a bounded provisional stream verdict. */
export function bareUpstreamError(payload: unknown, mask?: BareCopyMask): BareUpstreamError | undefined {
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
  const code = candidates.map(candidate => classField(candidate, "code")).find(value => value !== undefined);
  // The envelope's own `type` is `error` or the terminal event name, never the error class.
  const errorType = (untyped ? candidates.slice(0, -1) : candidates.slice(1))
    .map(candidate => classField(candidate, "type")).find(value => value !== undefined);
  // The message follows the same precedence as the class: a typed frame's own envelope copy is
  // the provider's verdict, while an untyped envelope's copy lives inside its error object.
  const rawMessage = untyped
    ? upstreamErrorMessageFromPayload(payload)
    : field(root, "message") ?? upstreamErrorMessageFromPayload(payload);
  const message = rawMessage
    ? redactSecretString(guardBareCopy(rawMessage, mask)).slice(0, MAX_BARE_ERROR_MESSAGE_CHARS) : undefined;
  // The verdict is read from the provider's own words, not from the copy the guard may have
  // replaced: a refusal that also echoes a credential is still a refusal. Never stored or shown.
  const evidenceCopy = rawMessage ? redactSecretString(rawMessage).slice(0, MAX_BARE_ERROR_MESSAGE_CHARS) : undefined;
  // An explicit refusal code is the provider's own verdict. Otherwise verified refusal copy is
  // recognized beside an unrelated code: a gateway that wraps the refusal in its own class still
  // ended the turn with a refusal, and retrying it would loop. A recognized quota/overload class
  // is stronger evidence than copy and keeps its identity instead. A transport code names the
  // delivery failure rather than the provider's verdict, so copy quoted inside its diagnostic
  // text is not evidence of a refusal.
  const refusalCode = isTerminalRefusalCode(code) ? code
    : evidenceCopy === undefined || recognizedUpstreamError({ type: errorType, code }) !== undefined
      || (code !== undefined && isTransportFailureCode(code)) ? undefined
      : isCyberPolicyMessage(evidenceCopy) ? CYBER_POLICY_ERROR_CODE : safetyRefusalCodeFromMessage(evidenceCopy);
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
  const httpStatus = refusalCode !== undefined ? 400 : recognized?.httpStatus ?? wrapped;
  const terminalStatus = httpStatus ?? 502;
  const configured = configuredCredentials();
  const rowCopyAllowed = configured.complete
    && ![rawMessage, code, errorType].some(text => text !== undefined && (configured.matches(text) || containsConfiguredCredentialExcerpt(text)));
  return {
    message: message ?? (refusalCode ? terminalRefusalFallbackMessage(refusalCode)
      : fallback ? `Upstream error without a message (${redactSecretString(guardBareCopy(fallback, mask))})` : "The upstream reported an error."),
    refusalCode,
    errorType,
    errorCode: code,
    terminalType,
    terminalCode,
    terminalStatus,
    httpStatus,
    rowCopyAllowed,
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
  /** The winning frame was itself a policy terminal; the client stream ended on it. */
  terminal?: boolean;
}

/**
 * A bare frame the relay treats as an immediate policy terminal, by the same rule as its
 * client rewrite: a typed `error` with a `cyber_policy` code or policy copy in any error
 * record, or an untyped envelope whose structured code is `cyber_policy`.
 */
function isBarePolicyTerminal(payload: unknown, verdict: BareUpstreamError): boolean {
  if (isUntypedBareUpstreamError(payload)) return verdict.errorCode === CYBER_POLICY_ERROR_CODE;
  const root = record(payload);
  const response = record(root?.response);
  const candidates = [record(root?.error), record(root?.last_error), record(response?.error),
    record(response?.incomplete_details), root, response];
  return candidates.some(candidate => field(candidate, "code") === CYBER_POLICY_ERROR_CODE)
    || candidates.some(candidate => { const message = field(candidate, "message"); return !!message && isCyberPolicyMessage(message); });
}

/**
 * One precedence rule for every reader of bare upstream errors.
 *
 * A typed bare `error` is the provider's structured verdict, so the newest typed
 * frame wins. An untyped envelope is weaker evidence: it may replace an earlier
 * untyped frame, but it never replaces a typed verdict. A genuine terminal is not
 * bare evidence and supersedes both, which is why the reducer only ever sees
 * bare frames. A winning policy terminal ends the client stream on that frame, so
 * nothing after it can replace it.
 */
export function reduceBareUpstreamEvidence(
  previous: BareUpstreamEvidence | undefined,
  payload: unknown,
  mask?: BareCopyMask,
): BareUpstreamEvidence | undefined {
  const verdict = bareUpstreamError(payload, mask);
  if (verdict === undefined) return previous;
  if (previous?.terminal === true) return previous;
  const typed = !isUntypedBareUpstreamError(payload);
  // The stored verdict decides: an untyped frame may replace untyped evidence, never typed.
  if (!typed && previous?.typed === true) return previous;
  if (!isBarePolicyTerminal(payload, verdict)) return { typed, verdict };
  // The client receives this frame rewritten as the policy terminal, so every reader records
  // that refusal, even when the frame also names an unrelated class beside the policy copy.
  return { typed, terminal: true, verdict: { ...verdict, refusalCode: CYBER_POLICY_ERROR_CODE,
    terminalType: "invalid_request_error", terminalCode: CYBER_POLICY_ERROR_CODE, terminalStatus: 400, httpStatus: 400 } };
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
