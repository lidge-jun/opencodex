import { REQUIRED_TOOL_CONTRACT_CODE } from "../../lib/errors";
import { createSseInspector, type SseInspectorHandlers } from "../relay";
import { inspectResponseLogSsePayloadParsed } from "../request-log";
import { replaceSseDataPayload, sseDataPayload, type SseBlockRewrite } from "../sse-payload-rewrite";
import { isAuthorizedProviderExecutedCall, type ProviderExecutedCallType } from "../responses-undeclared-tool-guard";
import { requiredToolContractOf } from "./combo-required-tool-contract";
import { requiredToolFulfillments } from "./combo-required-tool-fulfillments";
import type { AdapterRequest } from "../../adapters/base";

type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : undefined;
}
const reasoningEvents = new Set([
  "response.reasoning_summary_part.added", "response.reasoning_summary_part.done",
  "response.reasoning_summary_text.delta", "response.reasoning_summary_text.done",
  "response.reasoning_text.delta", "response.reasoning_text.done",
]);
const controlEvents = new Set(["response.created", "response.in_progress", "response.queued", "response.heartbeat"]);

/** Only known reasoning frames may extend a mandatory-tool prelude; other traffic commits. */
export function requiredToolReasoningPrelude(payload: unknown): boolean {
  const event = record(payload);
  return !!event && (reasoningEvents.has(String(event.type))
    || ((event.type === "response.output_item.added" || event.type === "response.output_item.done")
      && record(event.item)?.type === "reasoning"));
}

/** In-place projection is shared by the existing inspection and client rewrite owners. */
function terminalGuard(fulfills: (item: RecordValue, clientCall: boolean) => boolean, ownership: ReadonlySet<ProviderExecutedCallType>, evidence: { replayUnsafe: boolean }, normalizeItem: (item: unknown) => unknown) {
  let fulfilled = false;
  const observe = (value: unknown, complete: boolean) => {
    const item = record(normalizeItem(value));
    if (!item) { evidence.replayUnsafe = true; return; }
    const providerExecuted = isAuthorizedProviderExecutedCall(item, ownership);
    const clientCall = !providerExecuted && (item.type === "function_call" || item.type === "custom_tool_call");
    const hostedCall = typeof item.type === "string" && item.type.endsWith("_call") && !clientCall;
    if (providerExecuted || hostedCall) evidence.replayUnsafe = true;
    if (complete && item.status !== "in_progress" && item.status !== "incomplete" && item.status !== "failed") {
      fulfilled ||= fulfills(item, clientCall);
    }
    if (!clientCall && !hostedCall && item.type !== "message" && item.type !== "reasoning") evidence.replayUnsafe = true;
  };
  return {
    opaque: () => { evidence.replayUnsafe = true; },
    project(payload: unknown): boolean {
      const event = record(payload);
      if (!event) { evidence.replayUnsafe = true; return false; }
      if (event.type !== "response.completed" && event.type !== "response.failed" && event.type !== "response.incomplete"
        && !controlEvents.has(String(event.type)) && !requiredToolReasoningPrelude(event)) evidence.replayUnsafe = true;
      if (event.type === "response.output_item.added" || event.type === "response.output_item.done") {
        observe(event.item, event.type === "response.output_item.done");
      }
      const response = record(event.response);
      if (Array.isArray(response?.output)) {
        for (const item of response.output) observe(item, event.type === "response.completed");
      }
      if (response?.output !== undefined && !Array.isArray(response.output)) evidence.replayUnsafe = true;
      if (event.type !== "response.completed" || !response || !Array.isArray(response.output) || fulfilled) return false;
      event.type = "response.failed";
      response.status = "failed";
      response.error = {
        type: "upstream_error", code: REQUIRED_TOOL_CONTRACT_CODE,
        message: "Target completed the response without the tool call required by tool_choice",
        // This is evidence for preflight, never permission to replay after its commit boundary.
        ...(evidence.replayUnsafe ? { retryable: false } : {}),
      };
      return true;
    },
  };
}

export function createComboRequiredToolStreamGuard(
  rawBody: unknown, ownership: ReadonlySet<ProviderExecutedCallType>, evidence = { replayUnsafe: false },
  normalizeItem: (item: unknown) => unknown = item => item,
  request?: AdapterRequest,
) {
  const contract = requiredToolContractOf(rawBody);
  if (!contract) return undefined;
  const fulfills = requiredToolFulfillments(rawBody, contract, normalizeItem, request);
  const clientGuard = terminalGuard(fulfills, ownership, evidence, normalizeItem);
  return {
    rememberCompleted(response: RecordValue, remember: (response: RecordValue) => void) {
      if (!clientGuard.project({ type: "response.completed", response })) remember(response);
    },
    inspectorFactory(handlers: SseInspectorHandlers) {
      const guard = terminalGuard(fulfills, ownership, evidence, normalizeItem);
      return createSseInspector({
        ...handlers,
        onOpaquePayload(payload) { if (payload !== "[DONE]") guard.opaque(); handlers.onOpaquePayload?.(payload); },
        onParsedPayload(payload) {
          // Every raw observer, including continuation admission, sees the identity
          // authorized by client restoration rather than an alternate wire spelling.
          const event = record(payload);
          if (event?.item !== undefined) event.item = normalizeItem(event.item);
          const response = record(event?.response);
          if (Array.isArray(response?.output)) response.output = response.output.map(normalizeItem);
          // Inspection has parsed metadata but has not reported a terminal or persisted output yet.
          if (guard.project(payload) && handlers.logCtx) {
            inspectResponseLogSsePayloadParsed(handlers.logCtx, JSON.stringify(payload), payload);
          }
          handlers.onParsedPayload?.(payload);
        },
      });
    },
    blockRewrite: (() => {
      const guard = clientGuard;
      return ((block: string) => {
        const data = sseDataPayload(block);
        if (data === null || data === "[DONE]") return [block];
        let payload: unknown;
        try { payload = JSON.parse(data); } catch { guard.opaque(); return [block]; }
        if (!guard.project(payload)) return [block];
        const rewritten = replaceSseDataPayload(block, JSON.stringify(payload));
        return [rewritten.replace(/^event:[^\r\n]*$/m, "event: response.failed")];
      }) as SseBlockRewrite;
    })(),
  };
}
