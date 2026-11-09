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

type JsonRecord = Record<string, unknown>;
export const MAX_BARE_ERROR_MESSAGE_CHARS = 512;
const record = (value: unknown): JsonRecord | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : undefined;
const field = (value: JsonRecord | undefined, key: string): string | undefined => {
  const item = value?.[key];
  return typeof item === "string" && item.trim() ? item.trim() : undefined;
};

/** Only absent root type plus an error object qualifies as an untyped envelope. */
export function isUntypedBareUpstreamError(payload: unknown): boolean {
  const root = record(payload);
  return !!root && root.type === undefined && record(root.error) !== undefined;
}

/** Preserve first-code precedence when deriving a bounded provisional stream verdict. */
export function bareUpstreamError(payload: unknown): {
  message: string;
  refusalCode: string | undefined;
  errorType: string | undefined;
  errorCode: string | undefined;
  httpStatus: number | undefined;
} | undefined {
  const root = record(payload);
  const untyped = isUntypedBareUpstreamError(payload);
  if (!root || (root.type !== "error" && !untyped)) return undefined;
  const response = record(root.response);
  const candidates = [record(root.error), record(root.last_error), record(response?.error), record(response?.incomplete_details), root];
  const code = candidates.map(candidate => field(candidate, "code")).find(value => value !== undefined)?.slice(0, 128);
  const errorType = candidates.slice(0, -1).map(candidate => field(candidate, "type")).find(value => value !== undefined)?.slice(0, 128);
  const rawMessage = upstreamErrorMessageFromPayload(payload);
  const message = rawMessage ? redactSecretString(rawMessage).slice(0, MAX_BARE_ERROR_MESSAGE_CHARS) : undefined;
  const refusalCode = code !== undefined
    ? (isTerminalRefusalCode(code) ? code : undefined)
    : message === undefined ? undefined
      : isCyberPolicyMessage(message) ? CYBER_POLICY_ERROR_CODE : safetyRefusalCodeFromMessage(message);
  if (message === undefined && refusalCode === undefined && code === undefined && errorType === undefined && !untyped) return undefined;
  const recognized = recognizedUpstreamError({ type: errorType, code });
  const fallback = code ?? errorType;
  return {
    message: message ?? (refusalCode ? terminalRefusalFallbackMessage(refusalCode)
      : fallback ? `Upstream error without a message (${redactSecretString(fallback)})` : "The upstream reported an error."),
    refusalCode,
    errorType,
    errorCode: code,
    httpStatus: refusalCode ? 400 : recognized?.httpStatus,
  };
}
