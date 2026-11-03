import {
  ANTHROPIC_ERROR_CODES, ANTHROPIC_ERROR_TYPES, CLAUDE_CONTEXT_OVERFLOW_MESSAGE,
  CLIENT_ERROR_CONTRACTS, clientErrorCodeMessage, actionableRefusalMessage, isProxyError, type ClientErrorContract,
} from "./client-error-body";
import { classifyUpstreamCondition, upstreamConditionMessage, type UpstreamCondition, type UpstreamConditionEvidence } from "./upstream-condition";

type Rec = Record<string, unknown>;
const STATUS_TYPES: ReadonlyMap<number, string> = new Map([
  [401, "authentication_error"], [402, "billing_error"], [403, "permission_error"],
  [404, "not_found_error"], [409, "conflict_error"], [413, "request_too_large"],
  [429, "rate_limit_error"], [504, "timeout_error"], [529, "overloaded_error"],
]);
/** Select the owned sentence from the message this path previously delivered. */
export function messagesOverflowPresentation(baselineMessage: unknown): boolean {
  if (typeof baselineMessage !== "string") return false;
  const message = baselineMessage.toLowerCase();
  return message.includes("prompt is too long") || message.includes("input is too long for requested model");
}

export function isMessagesErrorEnvelope(value: unknown): value is Rec {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const body = value as Rec;
  const error = body.error;
  return body.type === "error" || (error !== null && typeof error === "object" && !Array.isArray(error)
    && (typeof (error as Rec).type === "string" || typeof (error as Rec).message === "string"));
}
/** Match the SDK's diagnostic selection on the parsed body or non-JSON response text. */
export function messagesRelayedOverflowPresentation(text: string, parsed: unknown): boolean {
  const message = parsed !== null && typeof parsed === "object" && Object.hasOwn(parsed, "message")
    ? (parsed as Rec).message : undefined;
  const diagnostic = message ? typeof message === "string" ? message : JSON.stringify(message)
    : parsed ? JSON.stringify(parsed) : text;
  return messagesOverflowPresentation(diagnostic);
}

export interface OwnedAnthropicErrorOptions {
  status: number;
  type?: string;
  code?: string;
  evidence: UpstreamConditionEvidence;
  overflow?: boolean;
  contract?: ClientErrorContract;
  condition?: UpstreamCondition;
  /** An object marked by the local producer; serialized fields cannot grant ownership. */
  localError?: { message: string };
}
export function ownedAnthropicErrorPayload(options: OwnedAnthropicErrorOptions): Rec {
  const type = ANTHROPIC_ERROR_TYPES.get(options.type ?? "")
    ?? STATUS_TYPES.get(options.status) ?? (options.status >= 500 ? "api_error" : "invalid_request_error");
  const code = options.code === "thread_unsupported_request" ? undefined : ANTHROPIC_ERROR_CODES.get(options.code ?? "");
  const message = options.overflow ? CLAUDE_CONTEXT_OVERFLOW_MESSAGE
    : options.localError && isProxyError(options.localError) ? options.localError.message
    : actionableRefusalMessage(options.evidence, code ?? null, options.contract)
      ?? (options.contract ? CLIENT_ERROR_CONTRACTS[options.contract] : undefined)
      ?? (options.condition ? upstreamConditionMessage(options.condition) : undefined)
      ?? clientErrorCodeMessage(code)
      ?? upstreamConditionMessage(classifyUpstreamCondition(options.evidence) ?? "upstream_failed");
  return { type: "error", error: { type, message, ...(code ? { code } : {}) } };
}
export function ownedAnthropicErrorResponse(options: OwnedAnthropicErrorOptions): Response {
  return Response.json(ownedAnthropicErrorPayload(options), { status: options.status });
}
/** Admission and presentation use separate numbers; this bounds display only. */
export function boundedMessagesDisplayCount(value: number): string | undefined {
  return Number.isSafeInteger(value) && value >= 0 && value <= 1e12 ? String(value) : undefined;
}

const METHOD: ReadonlyMap<string, string> = new Map(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "CONNECT", "TRACE"].map(method => [method, method]));
const MESSAGES_PATH: ReadonlyMap<string, string> = new Map([["/v1/messages", "/v1/messages"], ["/v1/messages/count_tokens", "/v1/messages/count_tokens"]]);
/** Other listeners retain their own endpoint diagnostics. */
export function messagesUnknownEndpointMessage(req: Request): string {
  const path = new URL(req.url).pathname;
  const localPath = MESSAGES_PATH.get(path);
  return localPath ? `Unknown endpoint: ${METHOD.get(req.method) ?? "unsupported"} ${localPath}`
    : `Unknown endpoint: ${req.method} ${path}`;
}
