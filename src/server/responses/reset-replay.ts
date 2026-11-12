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
 *
 * One removal is certain enough to judge on directly: a `previous_response_id` this proxy
 * expanded from its own replay state. The native adapter strips that id from every send, so the
 * wire carries the complete input and no continuation handle (#8453).
 *
 * Native passthrough judges BOTH: this inbound body, plus the physical outbound body and adapter
 * substitution metadata through `createPhysicalReplayGuard`, because a rebuild after the grant
 * was claimed can reintroduce a hazard the inbound body never had.
 */
import type { OcxParsedRequest, OcxProviderConfig } from "../../types";
import { resetReplayPolicyFor } from "../../providers/key-failover";
import { authorizeResendForRecovery, type AmbiguousResendAllowance, type ResendDecision } from "../../lib/request-resend-gate";
import type { RequestFailureStage } from "../../lib/request-failure-model";
import type { AdapterRequest } from "../../adapters/base";
import { parseOutboundRequestBody } from "./outbound-request-body";

type PhysicalReplaySnapshot = { body: BodyInit | null | undefined; hosted: boolean; providerExecuted: boolean };
export class UnsafePhysicalReplacement extends Error {}

/** Captures the attempt that actually left, and fences any replacement after queued rebuilding. */
export function createPhysicalReplayGuard(providerExecuted: () => boolean) {
  let last: PhysicalReplaySnapshot | undefined;
  // A judgment is a pure function of its snapshot, and the outbound body may be megabytes.
  let lastSafe: boolean | undefined;
  let pending = false;
  const snapshot = (request: AdapterRequest, body: BodyInit | null | undefined): PhysicalReplaySnapshot => ({
    body, hosted: (request.hostedToolSubstitutions?.length ?? 0) > 0, providerExecuted: providerExecuted(),
  });
  const safe = (value: PhysicalReplaySnapshot | undefined): boolean => value !== undefined
    && !value.hosted && !value.providerExecuted && typeof value.body === "string"
    && selfContainedResponsesBody(parseOutboundRequestBody(value.body));
  return {
    isSelfContained: (request: AdapterRequest) => {
      if (!(lastSafe ??= safe(last))) return false;
      const current = snapshot(request, request.body);
      // The body that physically left was judged above; only fresh substitution flags remain.
      return current.body === last!.body ? !current.hosted && !current.providerExecuted : safe(current);
    },
    authorize: () => { pending = true; },
    record: (request: AdapterRequest, body: BodyInit | null | undefined, next?: () => void) => {
      const physical = snapshot(request, body);
      // The authorization covers this one send, whether it leaves or fails to: a refused rebuild or
      // an exhausted send budget must not leave the next ordinary send judged as a replacement.
      try {
        if (pending && !safe(physical)) throw new UnsafePhysicalReplacement("The rebuilt request cannot be safely replayed");
        next?.();
      } finally {
        pending = false;
      }
      last = physical;
      lastSafe = undefined;
    },
  };
}

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
 * The native passthrough body to judge: the inbound body, minus a `previous_response_id` the
 * proxy already expanded into `input`.
 *
 * `expandPreviousResponseInput` keeps the id on the expanded body because Kiro and Cursor read
 * their conversation ids from it, so the inbound body always names it. The native Responses
 * adapter (and the Azure adapter that wraps it) removes it whenever `_previousResponseInputExpanded`
 * is set, which is the flag read here. Judging the id that never reaches the wire refused every
 * chained Codex turn, so an operator's `retryOnReset` opt-in applied only to first turns.
 *
 * An id that was NOT expanded is forwarded to the destination and still refuses: that send
 * continues state stored on the origin.
 */
export function nativePassthroughReplayJudgmentBody(
  parsed: Pick<OcxParsedRequest, "_rawBody" | "_previousResponseInputExpanded">,
): unknown {
  const body = parsed._rawBody;
  if (parsed._previousResponseInputExpanded !== true || !record(body) || !Object.hasOwn(body, "previous_response_id")) {
    return body;
  }
  const { previous_response_id: _expandedLocally, ...wire } = body;
  return wire;
}

/**
 * Log why an ambiguous reset was not replaced. Operators who opted in otherwise saw only the
 * terminal 429 and could not tell a missing policy from a request judged not replayable or an
 * allowance already spent (#8453). Host label, stage and reason only: no body, no credential.
 */
export function warnAmbiguousResendRefusal(decision: ResendDecision, hostLabel: string): void {
  if (decision.allowed || !decision.refusal.startsWith("ambiguous-")) return;
  console.warn(`[upstream-retry] ambiguous reset not replaced (${hostLabel}, ${decision.stage}): ${decision.refusal}`);
}

/**
 * One gate answer for every ambiguous row of a lane -- pre-header, post-header SSE, and a Codex
 * WebSocket that died under its create frame -- asked through `authorizeResendForRecovery` and
 * with its refusal reason logged. The allowance and host label are read per ask, because the
 * recovery loop reassigns the provider row and the request URL.
 */
export function ambiguousResendAuthorizer(
  allowance: () => AmbiguousResendAllowance | undefined,
  hostLabel: () => string,
): (stage: RequestFailureStage) => boolean {
  return stage => {
    const decision = authorizeResendForRecovery(stage, "connection-reset", allowance());
    warnAmbiguousResendRefusal(decision, hostLabel());
    return decision.allowed;
  };
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
 * that never opted in must not pay to walk the input array.
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
