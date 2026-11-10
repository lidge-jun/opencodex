import { CYBER_POLICY_FALLBACK_MESSAGE, classifyError } from "./errors";
import { classifyUpstreamCondition, upstreamConditionMessage, type UpstreamConditionEvidence } from "./upstream-condition";

const openaiTypes = ["invalid_request_error", "authentication_error", "permission_error", "not_found_error", "rate_limit_error", "server_error", "upstream_error", "insufficient_quota", "client_cancelled", "cyber_policy", "model_not_allowed_for_key", "api_error", "overloaded_error"] as const;
const openaiCodes = [
  "spend_ledger_storage_unavailable", "previous_response_not_found", "client_cancelled", "client_closed_request",
  "cyber_policy", "input_admission_refused", "inbound_body_too_large", "context_length_exceeded", "tool_catalog_too_large",
  "rate_limit_exceeded", "insufficient_quota", "request_send_budget_exhausted", "origin_rejected", "upstream_server_error",
  "invalid_api_key", "permission_denied", "location_not_supported", "subscription_required", "server_is_overloaded", "invalid_request_error",
  "usage_limit_reached", "slow_down", "misalignment_policy_violation", "invalid_prompt", "bio_policy", "model_not_in_plan",
  "upstream_reset_replay_refused", "upstream_no_response", "upstream_closed_before_response", "claude_subscription_cooldown",
  "model_not_found", "model_not_allowed_for_key", "undeclared_tool_call", "required_tool_contract_unsatisfied",
  "translation_buffer_limit", "invalid_refusal", "unsupported_feature", "agent_assertion_unsupported", "upstream_error",
  "upstream_sse_truncated", "upstream_sse_error", "upstream_sse_unterminated", "upstream_sse_invalid", "upstream_stream_incomplete", "upstream_stream_error", "upstream_stall_timeout",
  "upstream_incomplete", "server_busy", "outbound_body_too_large", "codex_no_account", "memory_model_target_unavailable", "intercept_target_unavailable",
  "observation_barrier_timeout", "claude_thread_unsupported", "claude_compatibility_configuration", "claude_compatibility_unsupported",
  "unsupported_credential_domain", "unsupported_synthetic_selector", "unsupported_shadow_rewrite",
  "workflow_sends_exhausted", "workflow_children_exhausted", "workflow_concurrency_exhausted", "workflow_spend_exhausted",
  "workflow_tracking_exhausted", "workflow_send_replayed", "workflow_pool_history_unresolved", "workflow_spend_undurable",
] as const;
function literalMap<const T extends readonly string[]>(values: T): ReadonlyMap<string, T[number]> {
  return new Map(values.map(value => [value, value]));
}
export const OPENAI_ERROR_TYPES = literalMap(openaiTypes);
export const OPENAI_ERROR_CODES = literalMap(openaiCodes);
export const ANTHROPIC_ERROR_TYPES = literalMap(["invalid_request_error", "authentication_error", "permission_error", "not_found_error", "request_too_large", "rate_limit_error", "api_error", "overloaded_error", "billing_error", "timeout_error", "conflict_error", "send_budget_exhausted"] as const);
export const ANTHROPIC_ERROR_CODES = literalMap([...ANTHROPIC_ERROR_TYPES.values(), ...openaiCodes, "desktop_model_mapping_unavailable", "thread_unsupported_request"] as const);
export const CLAUDE_CONTEXT_OVERFLOW_MESSAGE = "prompt is too long: The request exceeds the model's context window.";
export const CLIENT_ERROR_CONTRACTS = {
  context_overflow: "The request exceeds the model's context window.",
  cyber_policy: CYBER_POLICY_FALLBACK_MESSAGE,
  invalid_prompt: "The provider refused this request.",
  misalignment_policy_violation: "The provider refused this request under its policy.",
  bio_policy: "The provider refused this request under its policy.",
  model_not_in_plan: "The selected model is not included in your provider plan (MODEL_NOT_IN_PLAN). Choose a model the plan includes or change the plan; retrying this request will not succeed.",
  replay_refused: "The provider connection closed after the request was sent. This proxy refused to replay the request automatically.",
  translation_buffer_limit: "upstream translation buffer exceeded the safe limit",
  invalid_refusal: "upstream refusal representations are inconsistent",
  undeclared_tool_call: "Upstream emitted a client tool call outside this request's declared tool catalog.",
  required_tool_contract_unsatisfied: "The provider did not return the tool call required by this request.",
  transport_failed: "The proxy could not reach or read the provider.",
  stream_incomplete: "The provider stream ended before the request completed.",
} as const;
export type ClientErrorContract = keyof typeof CLIENT_ERROR_CONTRACTS;
export const UNDECLARED_TOOL_CALL_MESSAGE = "routed provider emitted undeclared client tool; only request-declared tools may be called";
/** Only producers of synthetic incomplete events register these process-local origins. */
type ProxyIncompleteReason = "adapter_eof" | "upstream_stall_timeout" | "missing_terminal_event";
const proxyIncompletes = new WeakMap<object, Set<string>>();
export function rememberProxyIncomplete(context: object, reason: ProxyIncompleteReason): void {
  let reasons = proxyIncompletes.get(context);
  if (!reasons) { reasons = new Set(); proxyIncompletes.set(context, reasons); }
  reasons.add(reason);
}
export function hasProxyIncomplete(context: object | undefined, reason: unknown, message?: unknown): boolean {
  return message === undefined && context !== undefined && typeof reason === "string" && proxyIncompletes.get(context)?.has(reason) === true;
}
export function carryProxyIncompleteContext<T extends object>(source: object, target: T): T {
  let reasons = proxyIncompletes.get(source);
  if (!reasons) { reasons = new Set(); proxyIncompletes.set(source, reasons); }
  proxyIncompletes.set(target, reasons);
  return target;
}
/**
 * A translated `done` whose adapter stop reason was Anthropic's `pause_turn`.
 *
 * The bridge still reports that turn to the client as `incomplete/max_output_tokens`, the reason the
 * wire has always carried there, so the wire cannot distinguish a paused long-running turn the client
 * is expected to continue from an exhausted output budget. This request-scoped fact carries the
 * difference without adding or changing a client-visible field: combo stream preflight reads it so a
 * paused turn is neither replayed on another target nor read as a zero-output token limit.
 */
const pausedTurns = new WeakSet<object>();
export function rememberPausedTurn(context: object): void { pausedTurns.add(context); }
export function isPausedTurn(context: object | undefined): boolean {
  return context !== undefined && pausedTurns.has(context);
}
const CODE_MESSAGES: ReadonlyMap<string, string> = new Map([
  ["context_length_exceeded", CLIENT_ERROR_CONTRACTS.context_overflow],
  ["upstream_incomplete", CLIENT_ERROR_CONTRACTS.stream_incomplete],
  ["upstream_stream_incomplete", CLIENT_ERROR_CONTRACTS.stream_incomplete],
  ["upstream_reset_replay_refused", CLIENT_ERROR_CONTRACTS.replay_refused],
  ...["cyber_policy", "invalid_prompt", "misalignment_policy_violation", "bio_policy", "model_not_in_plan", "translation_buffer_limit", "invalid_refusal", "undeclared_tool_call", "required_tool_contract_unsatisfied"].map(code => [code, CLIENT_ERROR_CONTRACTS[code as ClientErrorContract]] as const),
]);
export function clientErrorCodeMessage(code: string | undefined): string | undefined {
  return CODE_MESSAGES.get(code ?? "");
}
/** Local guidance is selected only by a closed reason supplied by the owning proxy call site. */
export const LOCAL_CHAT_ERROR_MESSAGES: ReadonlyMap<string, string> = new Map([
  ["credentials_paused", "The configured credentials are paused. Resume an account or key in account settings before retrying."],
  ["request_send_budget_exhausted", "This request reached the proxy's send budget. Start a new request or adjust the configured budget."],
  ["spend_ledger_storage_unavailable", "The proxy cannot record spending. Restore spend-ledger storage before retrying."],
  ["model_not_allowed_for_key", "This model is not allowed for the configured key. Choose an allowed model."],
  ["usage_limit_reached", "The configured usage limit was reached. Review the proxy's usage limits before retrying."],
  ["workflow_sends_exhausted", "The task reached its send ceiling. Wait for the workflow window or adjust its budget."],
  ["workflow_children_exhausted", "The task reached its child limit. Wait for the workflow window or adjust its budget."],
  ["workflow_concurrency_exhausted", "The task has no free concurrency slot. Wait for an active child to finish."],
  ["workflow_spend_exhausted", "The configured token ceiling was reached. Review the task, account and pool budgets."],
  ["workflow_tracking_exhausted", "The proxy reached its tracked-task limit. Wait for an active task to finish."],
  ["workflow_send_replayed", "The proxy refused a send that was already reserved."],
  ["workflow_pool_history_unresolved", "Provider pool spending history must be resolved before sending."],
  ["workflow_spend_undurable", "The proxy cannot record the token reservation. Restore spend-ledger storage before retrying."],
]);
export interface OwnedChatErrorOptions {
  status: number; type?: string; code?: string | null; evidence: UpstreamConditionEvidence;
  contract?: ClientErrorContract; providerId?: string; localReason?: string;
}
export function ownedChatErrorPayload(options: OwnedChatErrorOptions) {
  const { status, evidence } = options;
  const type = OPENAI_ERROR_TYPES.get(options.type ?? "") ?? (status === 401 ? "authentication_error" : status === 403 ? "permission_error" : status === 429 ? "rate_limit_error" : status >= 500 ? "server_error" : "invalid_request_error");
  const code = OPENAI_ERROR_CODES.get(options.code ?? "") ?? (status === 401 ? "invalid_api_key" : status === 404 ? "model_not_found" : status === 429 ? "rate_limit_exceeded" : null);
  const fixedMessage = options.contract === undefined
    && code !== "cyber_policy" && code !== "context_length_exceeded" ? fixedProxyErrorMessage(evidence.message) : undefined;
  const message = actionableRefusalMessage(evidence, code, options.contract)
    ?? (options.contract ? CLIENT_ERROR_CONTRACTS[options.contract] : undefined) ?? fixedMessage
    ?? LOCAL_CHAT_ERROR_MESSAGES.get(options.localReason ?? "") ?? CODE_MESSAGES.get(code ?? "")
    ?? upstreamConditionMessage(classifyUpstreamCondition(evidence) ?? "upstream_failed", options.providerId);
  return { error: { message, type, param: null, code } };
}
/**
 * Provider refusals the user acts on by changing the request (model or plan). The key is the exact
 * token; the value is the proxy's own message, which carries the proxy's copy of that token.
 */
const ACTIONABLE_REFUSALS: ReadonlyMap<string, string> = new Map([
  ["MODEL_NOT_IN_PLAN", CLIENT_ERROR_CONTRACTS.model_not_in_plan],
]);
/** Codes a plan refusal travels under: the buffered code, and the stream code that ends the turn. */
const REFUSAL_CARRIER_CODES: ReadonlySet<string> = new Set(["model_not_in_plan", "invalid_prompt"]);
const REFUSAL_TOKEN_SCAN = 4096;
/**
 * The fixed message for a known actionable refusal, or undefined. A structured code matches when it
 * equals a listed token after case and hyphen folding. The message is read only for a refusal-carrying
 * code, and only for a listed token standing as a whole word; nothing from it is returned.
 */
export function actionableRefusalMessage(
  evidence: UpstreamConditionEvidence, code: string | null, contract?: ClientErrorContract,
): string | undefined {
  if (contract !== undefined && !REFUSAL_CARRIER_CODES.has(contract)) return undefined;
  const structured = typeof evidence.code === "string" && evidence.code.length <= 64
    ? evidence.code.trim().toUpperCase().replaceAll("-", "_") : undefined;
  if (structured !== undefined && ACTIONABLE_REFUSALS.has(structured)) return ACTIONABLE_REFUSALS.get(structured);
  if (code === null || !REFUSAL_CARRIER_CODES.has(code) || typeof evidence.message !== "string") return undefined;
  const scanned = evidence.message.slice(0, REFUSAL_TOKEN_SCAN);
  for (const [token, message] of ACTIONABLE_REFUSALS) {
    if (new RegExp(`(^|[^A-Za-z0-9_])${token}(?![A-Za-z0-9_])`).test(scanned)) return message;
  }
  return undefined;
}
export function canonicalSseErrorBlock(payload: unknown): string { return `data: ${JSON.stringify(payload)}\n\n`; }
const comboEvidence = new WeakMap<Response, string>();
export function attachComboFailureEvidence(response: Response, legacyBodyText: string): Response {
  comboEvidence.set(response, legacyBodyText); return response;
}
export function comboFailureEvidence(response: Response): string | undefined { return comboEvidence.get(response); }

/** Identity belongs to the locally constructed object, never to serialized fields. */
const proxyErrors = new WeakSet<object>();
export type ProxyErrorPresentation = "roster" | "pacing" | "input" | "outbound" | "inbound" | "send" | "cooldown" | "cooldown_pinned" | "hard_lock" | "recovery" | "usage" | "model_availability" | "oauth_login" | "discovery" | "muse_http" | "config" | "workflow" | "workflow_unbound" | "scope" | "body_stall" | "body_overflow" | "combo" | "copilot" | "pool_refresh";
const proxyPresentations = new WeakMap<object, ProxyErrorPresentation>();
export function proxyErrorPresentation(value: object): ProxyErrorPresentation | undefined { return proxyPresentations.get(value); }
export function markProxyError<T extends object>(value: T, presentation?: ProxyErrorPresentation): T {
  proxyErrors.add(value);
  if (presentation !== undefined) proxyPresentations.set(value, presentation);
  return value;
}
export function carryProxyErrorPresentation<T extends object>(source: object, target: T): T {
  const kind = proxyErrorPresentation(source);
  if (source instanceof Response && target instanceof Response && source.status !== target.status) return target;
  if (kind !== undefined && proxyErrorPresentation(target) === undefined) proxyPresentations.set(target, kind);
  return target;
}
export function isProxyError(value: object): boolean { return proxyErrors.has(value); }
export function carryProxyError<T extends object>(source: object, target: T): T {
  return isProxyError(source) ? carryProxyErrorPresentation(source, markProxyError(target)) : target;
}
/** The tool guard records only messages it constructs for this response's request context. */
export interface ProxyErrorMessageFields { type?: string; code?: string | null; presentation?: ProxyErrorPresentation }
const proxyMessages = new WeakMap<object, Map<string, Set<string>>>();
const proxyMessagePresentations = new WeakMap<object, Map<string, Map<string, ProxyErrorPresentation>>>();
const errorFields = (fields: ProxyErrorMessageFields) => JSON.stringify([fields.type ?? null, fields.code ?? null]);
export function rememberProxyErrorMessage(context: object, message: string, fields: ProxyErrorMessageFields & { status: number }): void {
  let messages = proxyMessages.get(context);
  if (!messages) { messages = new Map(); proxyMessages.set(context, messages); }
  let allowed = messages.get(message);
  if (!allowed) { allowed = new Set(); messages.set(message, allowed); }
  const classified = classifyError(fields.status, fields.type ?? "upstream_error", message);
  // The bridge may classify a field while preserving the other field's explicit local verdict.
  for (const type of [fields.type, classified.type]) for (const code of [fields.code, classified.code]) {
    const key = errorFields({ type, code }); allowed.add(key);
    if (fields.presentation !== undefined) {
      let rows = proxyMessagePresentations.get(context);
      if (!rows) { rows = new Map(); proxyMessagePresentations.set(context, rows); }
      let kinds = rows.get(message); if (!kinds) { kinds = new Map(); rows.set(message, kinds); }
      kinds.set(key, fields.presentation);
    }
  }
}
export function carryProxyErrorContext(source: object, target: object): void {
  carryProxyIncompleteContext(source, target);
  if (pausedTurns.has(source)) pausedTurns.add(target);
  let messages = proxyMessages.get(source);
  if (!messages) { messages = new Map(); proxyMessages.set(source, messages); }
  proxyMessages.set(target, messages);
  let presentations = proxyMessagePresentations.get(source);
  if (!presentations) { presentations = new Map(); proxyMessagePresentations.set(source, presentations); }
  proxyMessagePresentations.set(target, presentations);
}
export function hasProxyErrorMessage(context: object | undefined, message: string, fields: ProxyErrorMessageFields): boolean {
  return context !== undefined && proxyMessages.get(context)?.get(message)?.has(errorFields(fields)) === true;
}
export function proxyMessagePresentation(context: object | undefined, message: string, fields: ProxyErrorMessageFields): ProxyErrorPresentation | undefined {
  return context === undefined ? undefined : proxyMessagePresentations.get(context)?.get(message)?.get(errorFields(fields));
}
// These complete sentences contain only proxy literals, including each recognized reason.
const PROXY_FIXED_MESSAGES: ReadonlyMap<string, string> = literalMap([
  "internal replay returned a non-JSON response",
  "upstream returned malformed Chat Completions JSON",
  "upstream response contained no choices",
  "upstream response ended without a supported completion boundary",
  "upstream returned malformed SSE JSON",
  "upstream returned an invalid SSE event",
  "upstream SSE ended with an unterminated event",
  "upstream SSE ended mid tool call without a terminal signal — possible truncation",
  "upstream SSE ended before a terminal event",
  "upstream stream stalled without meaningful progress",
  "routed provider emitted a client tool call outside the current request's explicit tool catalog",
  "upstream stream ended before a terminal frame (truncated response)",
] as const);
export function fixedProxyErrorMessage(message: unknown): string | undefined {
  return typeof message === "string" ? PROXY_FIXED_MESSAGES.get(message) : undefined;
}
