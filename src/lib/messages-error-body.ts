import { carryReplayRefusal, isNonReplayableResponse, markResponseNonReplayable } from "./upstream-retry";
import { appendClientRetryIn } from "./client-retry-after";
import {
  ANTHROPIC_ERROR_CODES, ANTHROPIC_ERROR_TYPES, CLAUDE_CONTEXT_OVERFLOW_MESSAGE,
  CLIENT_ERROR_CONTRACTS, clientErrorCodeMessage, actionableRefusalMessage, isProxyError, attachComboFailureEvidence, carryProxyError, proxyErrorPresentation, comboFailureEvidence, markProxyError, type ProxyErrorPresentation, type ClientErrorContract,
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

/** Preserve the former JSON role display decision without rendering caller values. */
export function messagesRolePresentation(role: unknown): { overflow: boolean; coercionFailed: boolean } {
  let overflow = false;
  const active = new WeakSet<unknown[]>();
  const stack: { array: unknown[]; index: number }[] = [];
  let value = role;
  for (;;) {
    if (typeof value === "string") overflow ||= messagesOverflowPresentation(value);
    else if (Array.isArray(value)) {
      if (!active.has(value)) { active.add(value); stack.push({ array: value, index: 0 }); }
    } else if (value !== null && typeof value === "object" && Object.hasOwn(value, "toString")) {
      return { overflow: false, coercionFailed: true };
    }
    let next = false;
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      if (frame.index < frame.array.length) { value = frame.array[frame.index++]; next = true; break; }
      active.delete(frame.array); stack.pop();
    }
    if (!next) return { overflow, coercionFailed: false };
  }
}

export function isMessagesErrorEnvelope(value: unknown): value is Rec {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const body = value as Rec;
  const error = body.error;
  return body.type === "error" || (error !== null && typeof error === "object" && !Array.isArray(error)
    && (typeof (error as Rec).type === "string" || typeof (error as Rec).message === "string"));
}
/** Match the SDK's diagnostic selection on the parsed body or non-JSON response text. */
function messagesErrorDiagnostic(value: unknown, fallback: string | undefined): string | undefined {
  const message = value !== null && typeof value === "object" && Object.hasOwn(value, "message")
    ? (value as Rec).message : undefined;
  return message ? typeof message === "string" ? message : JSON.stringify(message)
    : value ? JSON.stringify(value) : fallback;
}
export function messagesRelayedOverflowPresentation(text: string, parsed: unknown): boolean {
  return messagesOverflowPresentation(messagesErrorDiagnostic(parsed, text));
}
/** The pinned SSE APIError uses the parsed-or-raw whole body and no HTTP fallback. */
export function messagesSseErrorOverflowPresentation(data: string, parsed: unknown): boolean {
  return messagesOverflowPresentation(messagesErrorDiagnostic(parsed ?? data, undefined) || "(no status code or body)");
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
    : options.localError && isProxyError(options.localError) ? fixedLocalMessage(options.localError, options.evidence.code ?? code, options.evidence.type) ?? options.localError.message
    : actionableRefusalMessage(options.evidence, code ?? null, options.contract)
      ?? (options.contract ? CLIENT_ERROR_CONTRACTS[options.contract] : undefined)
      ?? (options.condition ? upstreamConditionMessage(options.condition) : undefined)
      ?? clientErrorCodeMessage(code)
      ?? upstreamConditionMessage(classifyUpstreamCondition(options.evidence) ?? "upstream_failed");
  return { type: "error", error: { type, message, ...(code ? { code } : {}) } };
}
export function ownedAnthropicErrorResponse(options: OwnedAnthropicErrorOptions, legacy?: Rec): Response {
  const response = Response.json(ownedAnthropicErrorPayload(options), { status: options.status, headers: { "Content-Type": "application/json" } });
  return legacy === undefined ? response : attachComboFailureEvidence(response, JSON.stringify(legacy));
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

/** Surface projection uses construction metadata; shared producer bodies retain their own wire. */
const FIXED_MESSAGES: ReadonlyMap<ProxyErrorPresentation, string> = new Map([
  ["roster", "The selected Google Antigravity account does not list the requested model. Choose a model your accounts list, select an account with access, or review account failover settings before retrying."],
  ["pacing", "The provider request queue is full or has expired. Wait for queued requests to finish, then retry."],
  ["input", "The input exceeds the configured admission limit. Start a new session or choose a model with a larger input limit."],
  ["outbound", "The provider request body exceeds the configured limit. Reduce the request size before retrying."],
  ["inbound", "The request body exceeds the configured limit. Reduce the request size before retrying."],
  ["send", "request send budget exhausted before dispatch"],
  ["cooldown", "The selected Codex account is cooling down. Run 'ocx account list openai' to find the id, then 'ocx account clear-cooldown openai <id>' to lift it, or switch accounts with 'ocx account use openai <id>'."],
  ["cooldown_pinned", "The selected Codex account is cooling down. This request is pinned to that selector and will not switch accounts; choose another account-qualified model or retry later."],
  ["hard_lock", "Codex main account is blocked by the main-account quota policy. Choose another account, wait for quota to reset, or disable codexMainAccountHardLock in Settings."],
  ["recovery", "The selected Codex account is held after repeated upstream failures and the pool's recovery budget for this window is spent, so nothing was sent upstream. Retry later. This clears on its own as the account recovers; no cooldown to lift and no account to switch."],
  ["usage", "The configured account usage limit was reached. Wait for its reset or adjust the usage limits before retrying."],
  ["model_availability", "The requested model is unavailable for the selected account. Choose a supported model or retry when it becomes available."],
  ["oauth_login", "The configured provider needs sign-in. Run ocx login for that provider, then retry."],
  ["discovery", "Antigravity login could not discover a Cloud Code Assist project for this account. Ensure the account has Antigravity/Cloud Code Assist access and try again."],
  ["muse_http", "The Muse Code credential was rejected by the Meta Model API. Renew it with `muse login` or copy it again from https://dev.meta.ai, then retry."],
  ["config", "The configured OAuth provider is unsupported. Remove or reconfigure the provider in the OpenCodex configuration."],
  ["workflow", "The configured token ceiling is spent, so this send was refused before contacting a provider. Review the task, account and pool spending limits to grant more."],
  ["workflow_unbound", "The configured token ceiling is spent, including unassigned provider-pool history. Resolve verified pool mappings or adjust the spending limits before retrying."],
  ["scope", "The requested model is not allowed for this API key."],
  ["body_stall", "anthropic passthrough body stalled: no upstream bytes arrived before the configured timeout"],
  ["body_overflow", "anthropic passthrough body exceeded the safe limit"],
  ["combo", "No available targets for combo; review target availability, quota and cooldowns before retrying."],
  ["pool_refresh", "Codex credential refresh did not complete for the selected Codex pool account; retry this request. If it keeps failing, sign in to that account again."],
  ["copilot", "GitHub Copilot Auto negotiation failed; retry or check your Copilot account permissions."],
]);
const LOCAL_CODES: ReadonlyMap<string, ProxyErrorPresentation> = new Map([
  ["request_send_budget_exhausted", "send"], ["send_budget_exhausted", "send"], ["model_not_allowed_for_key", "scope"],
]);
function fixedLocalMessage(local: object, code?: string, type?: string): string | undefined {
  const kind = proxyErrorPresentation(local) ?? LOCAL_CODES.get(code ?? "") ?? LOCAL_CODES.get(type ?? "");
  return kind === undefined ? undefined : FIXED_MESSAGES.get(kind);
}
function isMessagesRequest(req: Request): boolean {
  const path = new URL(req.url).pathname;
  return path === "/v1/messages" || path === "/v1/messages/count_tokens";
}
export async function normalizeMessagesProxyRefusal(req: Request, response: Response): Promise<Response> {
  if (!isMessagesRequest(req) || response.ok || !isProxyError(response)) return response;
  const kind = proxyErrorPresentation(response);
  if (kind === undefined) return response;
  const message = FIXED_MESSAGES.get(kind);
  if (message === undefined) throw new Error("Unknown local Messages presentation");
  const original = await response.clone().json() as Rec;
  const error = original.error as Rec;
  // A combo refusal keeps the earliest recovery the Responses body names; the header is already clamped seconds.
  const presented = kind === "combo" ? appendClientRetryIn(message, response.headers.get("retry-after")) : message;
  const next = { ...error, message: messagesOverflowPresentation(error.message) ? CLAUDE_CONTEXT_OVERFLOW_MESSAGE : presented };
  if (kind === "scope") delete (next as Rec).model;
  const headers = new Headers(response.headers); headers.delete("content-length");
  const out = carryProxyError(response, carryReplayRefusal(response, new Response(JSON.stringify({ ...original, error: next }), { status: response.status, headers })));
  if (isNonReplayableResponse(response)) markResponseNonReplayable(out);
  const evidence = comboFailureEvidence(response);
  return evidence === undefined ? out : attachComboFailureEvidence(out, evidence);
}
