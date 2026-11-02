import { CYBER_POLICY_FALLBACK_MESSAGE } from "./errors";
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
export const ANTHROPIC_ERROR_TYPES = literalMap(["invalid_request_error", "authentication_error", "permission_error", "not_found_error", "request_too_large", "rate_limit_error", "api_error", "overloaded_error", "billing_error", "timeout_error", "conflict_error"] as const);
export const ANTHROPIC_ERROR_CODES = literalMap([...ANTHROPIC_ERROR_TYPES.values(), ...openaiCodes] as const);
export const CLAUDE_CONTEXT_OVERFLOW_MESSAGE = "prompt is too long: The request exceeds the model's context window.";
export const CLIENT_ERROR_CONTRACTS = {
  context_overflow: "The request exceeds the model's context window.",
  cyber_policy: CYBER_POLICY_FALLBACK_MESSAGE,
  invalid_prompt: "The provider refused this request.",
  misalignment_policy_violation: "The provider refused this request under its policy.",
  bio_policy: "The provider refused this request under its policy.",
  model_not_in_plan: "The requested model is not included in the provider account's plan.",
  replay_refused: "The provider connection closed after the request was sent. This proxy refused to replay the request automatically.",
  translation_buffer_limit: "upstream translation buffer exceeded the safe limit",
  invalid_refusal: "upstream refusal representations are inconsistent",
  undeclared_tool_call: "Upstream emitted a client tool call outside this request's declared tool catalog.",
  required_tool_contract_unsatisfied: "The provider did not return the tool call required by this request.",
  transport_failed: "The proxy could not reach or read the provider.",
  stream_incomplete: "The provider stream ended before the request completed.",
} as const;
export type ClientErrorContract = keyof typeof CLIENT_ERROR_CONTRACTS;
const CODE_MESSAGES: ReadonlyMap<string, string> = new Map([
  ["context_length_exceeded", CLIENT_ERROR_CONTRACTS.context_overflow],
  ["upstream_incomplete", CLIENT_ERROR_CONTRACTS.stream_incomplete],
  ["upstream_stream_incomplete", CLIENT_ERROR_CONTRACTS.stream_incomplete],
  ["upstream_reset_replay_refused", CLIENT_ERROR_CONTRACTS.replay_refused],
  ...["cyber_policy", "invalid_prompt", "misalignment_policy_violation", "bio_policy", "model_not_in_plan", "translation_buffer_limit", "invalid_refusal", "undeclared_tool_call", "required_tool_contract_unsatisfied"].map(code => [code, CLIENT_ERROR_CONTRACTS[code as ClientErrorContract]] as const),
]);
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
  const message = (options.contract ? CLIENT_ERROR_CONTRACTS[options.contract] : undefined)
    ?? LOCAL_CHAT_ERROR_MESSAGES.get(options.localReason ?? "") ?? CODE_MESSAGES.get(code ?? "")
    ?? upstreamConditionMessage(classifyUpstreamCondition(evidence) ?? "upstream_failed", options.providerId);
  return { error: { message, type, param: null, code } };
}
export function canonicalSseErrorBlock(payload: unknown): string { return `data: ${JSON.stringify(payload)}\n\n`; }
const comboEvidence = new WeakMap<Response, string>();
export function attachComboFailureEvidence(response: Response, legacyBodyText: string): Response {
  comboEvidence.set(response, legacyBodyText); return response;
}
export function comboFailureEvidence(response: Response): string | undefined { return comboEvidence.get(response); }
