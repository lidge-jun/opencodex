/**
 * The operator opt-in that overrides the stage table's refusal, and the one request-wide
 * allowance both ambiguous stages claim from.
 *
 * `resendPermission` answers `refused-ambiguous` for a native Responses send that died with
 * the caller having observed nothing -- before the response head, or after it while the SSE
 * body carried only control events. This module is the one place that answer is overridden,
 * and it is narrow on three axes at once: the provider has to opt in, the request has to be
 * one whose second send cannot do more than run the same inference again, and the whole
 * logical request gets a fixed number of replacements no matter how many legs ask.
 *
 * The judgment is made on the inbound body the client sent, which is already parsed. It is
 * conservative for the outbound request: the proxy expands `previous_response_id` and lowers
 * hosted tools into client execution, so every hazard that reaches the wire was visible here,
 * and a hazard visible here may already have been removed. A cheap fail-closed answer beats
 * re-parsing a multi-megabyte outbound body on every send.
 */
import type { OcxProviderConfig } from "../../types";
import { resetReplayPolicyFor } from "../../providers/key-failover";
import type { AmbiguousResendAllowance } from "../../lib/request-resend-gate";

/** Input items a client owns end to end: replaying them re-runs nothing but the model. */
const CLIENT_INPUT_ITEM_TYPES: ReadonlySet<string> = new Set([
  "message", "reasoning", "compaction",
  "function_call", "function_call_output",
  "custom_tool_call", "custom_tool_call_output",
  "tool_search_call",
]);
const MESSAGE_ROLES: ReadonlySet<string> = new Set(["user", "assistant", "system", "developer"]);
/** Bounded traversal: a catalog is operator data, not a reason to walk forever. */
const MAX_TOOL_ENTRIES = 4096;
const MAX_TOOL_DEPTH = 4;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * True when every tool in the catalog is executed by the client. Hosted tools (`web_search`,
 * `mcp`, `code_interpreter`, ...) run on the origin during the turn, so an unknown or hosted
 * type fails the whole catalog rather than being skipped: a tool this proxy does not
 * recognise is a tool it cannot vouch for.
 */
function clientExecutedTools(tools: unknown, budget: { remaining: number }, depth = 0): boolean {
  if (!Array.isArray(tools) || depth > MAX_TOOL_DEPTH) return false;
  return tools.every(tool => {
    budget.remaining -= 1;
    if (budget.remaining < 0 || !record(tool)) return false;
    if (tool.type === "function" || tool.type === "custom") return true;
    if (tool.type === "tool_search") return tool.execution === "client";
    return tool.type === "namespace" && typeof tool.name === "string"
      && clientExecutedTools(tool.tools, budget, depth + 1);
  });
}

/**
 * A Responses body whose second send can only repeat the inference: nothing stored, no
 * server-side continuation state, complete input, and only client-executed tools. Deferred
 * tool declarations inside `input` are checked by the same rule as the root catalog, so a
 * hosted tool cannot ride in through `additional_tools` or a `tool_search_output`.
 */
export function selfContainedResponsesBody(body: unknown): boolean {
  if (!record(body)) return false;
  if (body.store !== false || body.background === true) return false;
  if (body.previous_response_id != null || body.conversation != null || Object.hasOwn(body, "stream_id")) return false;
  const input = body.input;
  if (typeof input !== "string" && !Array.isArray(input)) return false;
  const budget = { remaining: MAX_TOOL_ENTRIES };
  if (body.tools !== undefined && !clientExecutedTools(body.tools, budget)) return false;
  if (typeof input === "string") return true;
  return input.every(item => {
    if (!record(item)) return false;
    if (item.type === "additional_tools" || item.type === "tool_search_output") {
      return clientExecutedTools(item.tools, budget);
    }
    if (item.type === undefined) return typeof item.role === "string" && MESSAGE_ROLES.has(item.role);
    return typeof item.type === "string" && CLIENT_INPUT_ITEM_TYPES.has(item.type);
  });
}

/**
 * Chat Completions tools are executed by the client by spec -- the origin only emits the call.
 * Anything else (`web_search`, `code_interpreter`, a vendor hosted tool) runs on the origin during
 * the turn, so an unknown or hosted entry fails the whole catalog rather than being skipped.
 */
function clientExecutedChatTools(tools: unknown, budget: { remaining: number }): boolean {
  if (!Array.isArray(tools) || tools.length > budget.remaining) return false;
  budget.remaining -= tools.length;
  return tools.every(tool => record(tool) && tool.type === "function");
}

/**
 * A Chat Completions body whose second send can only repeat the inference.
 *
 * The lane is stateless by construction -- the proxy rebuilds the whole `messages` array on every
 * turn, and `previous_response_id` is not part of the Chat wire -- so the only hazards left are
 * server-side storage, which would record a second completion, and a hosted tool the origin would
 * run a second time.
 */
export function selfContainedChatBody(body: unknown): boolean {
  if (!record(body)) return false;
  if (body.store === true) return false;
  if (body.previous_response_id != null) return false;
  // Hosted execution requested outside the `tools` catalog. Judged on the inbound body like every
  // other hazard here, which is conservative for the outbound request by design: a body that asks
  // for a hosted search is refused rather than assumed harmless because a later stage might drop
  // the field.
  if (body.web_search_options !== undefined) return false;
  if (!Array.isArray(body.messages)) return false;
  return body.tools === undefined || clientExecutedChatTools(body.tools, { remaining: MAX_TOOL_ENTRIES });
}

/**
 * The allowance for ONE logical request, or nothing when the provider did not opt in.
 *
 * Built once per request and handed to every leg. `claim` spends the request's counter, which
 * lives on the execution budget and is therefore shared with a combo child's derived scope --
 * that sharing is the reason the pre-header helper takes a callback instead of a number.
 *
 * The body judgment is carried rather than applied here, because the gate has to be able to
 * say WHY it refused: "the operator granted nothing" and "this request cannot be replayed" are
 * different operator problems, and folding them together is what made the old refusal a single
 * undifferentiated no.
 *
 * `selfContained` is a predicate rather than a body, and the getter below is why: a provider
 * that never opted in must not pay to walk the input array, and the caller memoizes one answer
 * across every leg of the request.
 */
export function ambiguousResendAllowanceFor(
  provider: Pick<OcxProviderConfig, "retryOnReset">,
  requestIsSelfContained: () => boolean,
  claim: (limit: number) => boolean,
): AmbiguousResendAllowance | undefined {
  const policy = resetReplayPolicyFor(provider);
  if (policy === null) return undefined;
  return {
    get selfContained(): boolean { return requestIsSelfContained(); },
    claim: () => claim(policy.replacements),
  };
}
