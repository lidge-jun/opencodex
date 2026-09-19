/**
 * Operator-opted replay of a native Responses send that died before any response byte.
 *
 * `fetchWithResetRetry` refuses to send a model POST again after a pre-header connection
 * reset, because no response is not proof the origin never processed the request. This
 * module is the one place that decision can be overridden, and it is deliberately narrow on
 * both axes: the provider has to opt in (`retryOnReset`), and the request has to be one whose
 * second send cannot do more than run the same inference again. Anything the proxy cannot
 * judge keeps the refusal.
 *
 * The judgment is made on the inbound body the client sent, which is already parsed. It is
 * conservative for the outbound request: the proxy expands `previous_response_id` and lowers
 * hosted tools into client execution, so every hazard that reaches the wire was visible here,
 * and a hazard visible here may already have been removed. A cheap fail-closed answer beats
 * re-parsing a multi-megabyte outbound body on every send.
 */
import type { OcxProviderConfig } from "../../types";
import { resetReplayPolicyFor } from "../../providers/key-failover";

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
 * The `replayResets` option for one native Responses leg, or nothing. Computed once per
 * request from the provider policy and the inbound body, then spread into every send of that
 * request: the rebuilt legs (rotation, refresh, same-target 429 wait) carry the same turn.
 */
export function resetReplayOptions(
  provider: Pick<OcxProviderConfig, "retryOnReset">,
  inboundBody: unknown,
): { replayResets: number } | Record<string, never> {
  const policy = resetReplayPolicyFor(provider);
  if (policy === null || !selfContainedResponsesBody(inboundBody)) return {};
  return { replayResets: policy.attempts };
}
