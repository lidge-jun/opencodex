import type { AdapterEvent } from "../../types";
import type { StepSessionEvent } from "./session";
import type { StepConversationSession } from "./session-pool";
import { asRecord, continuationFor, toUsage } from "./projection";
import {
  assistantUsage,
  currentQuery,
  currentTurn,
  endTurn,
  forgetQuery,
  recordAssistantUsage,
} from "./registry";
import { resolveStepToolName } from "./tool-bridge";
import type { StepFrame } from "./stdio-frames";

/**
 * What the CLI says, and what this peer owes it in return.
 *
 * Every reverse request is ANSWERED, including when no turn is registered or the hold already
 * expired: a dropped reverse request leaves the runtime waiting out its own 60s/120s window with no
 * diagnostic and nothing for the client to act on.
 */

/**
 * A reverse request the CLI is waiting on this peer to answer.
 *
 * `permission.request` is allowed only for the owning query's declared catalog. A
 * `sdk_tool.invoke` is deliberately NOT answered here: its result only exists once the
 * client has executed the tool and sent its next request, and answering it is how that result reaches
 * the model inside the query the model is already running.
 */
/**
 * Exported for its regression tests: every reverse request must be ANSWERED, and the tests drive this
 * exact function rather than a mirror of it.
 */
export function handleReverseRequest(session: StepConversationSession, frame: StepFrame): void {
  const payload = asRecord(frame.payload);
  const expired = payload.__expired === true;
  const turn = currentTurn(session);
  const ownsQuery = turn?.queryId !== undefined && payload.queryId === turn.queryId
    && currentQuery(session) === turn.queryId;

  if (expired) {
    // The hold elapsed, so the client can never answer this call. Refuse it so StepCode stops waiting
    // instead of burning its own window, and do NOT re-dispatch: the client already received this tool
    // call, and a second `tool_call_start` for the same id would be a duplicate.
    session.refuseToolCall(
      frame,
      "The client did not return a tool result inside the window this transport holds a call for.",
    );
    return;
  }

  // Even with no turn registered, a reverse request must be ANSWERED. Dropping it leaves the runtime
  // waiting out its own 60s/120s window with nothing to show for it, and the client has no way to
  // learn that the call was silently dropped.
  if (frame.method === "permission.request") {
    const toolName = typeof payload.toolName === "string" ? payload.toolName : "";
    if (ownsQuery && turn && resolveStepToolName(toolName, turn.emittedNames)) session.allowPermission(frame);
    else session.denyPermission(frame, "No active query owns this declared tool permission.");
    return;
  }

  if (frame.method === "sdk_tool.invoke" && (!turn || !ownsQuery)) {
    session.refuseToolCall(
      frame,
      "OpenCodex is not expecting a tool call for this conversation right now, so it was not executed.",
    );
    return;
  }

  if (!turn) {
    session.denyPermission(frame, `OpenCodex cannot handle ${frame.method ?? "this request"} outside a turn.`);
    return;
  }

  if (frame.method === "sdk_tool.invoke") {
    const payload = (frame.payload ?? {}) as {
      input?: unknown;
      toolUseId?: string;
      serverName?: string;
      toolName?: string;
    };
    // The descriptor's `toolName` is BARE; the name StepCode registered is
    // `${serverName}__${toolName}`. Recomposing the wire name from both fields is what makes the
    // lookup work, and a lookup that misses has to refuse rather than guess.
    const serverName = typeof payload.serverName === "string" ? payload.serverName : "";
    const bareName = typeof payload.toolName === "string" ? payload.toolName : "";
    const wireName = serverName && bareName ? `${serverName}__${bareName}` : bareName;
    const resolved = resolveStepToolName(wireName, turn.emittedNames);
    if (!resolved) {
      session.refuseToolCall(
        frame,
        `OpenCodex did not declare ${wireName || "this tool"} for this turn, so the call was not executed.`,
      );
      return;
    }
    const callId =
      typeof payload.toolUseId === "string" && payload.toolUseId.length > 0
        ? payload.toolUseId
        : `call_${frame.id}`;
    turn.pool.rememberHeldTool(turn.ref, { frameId: frame.id, callId, queryId: turn.queryId!, catalogKey: turn.catalogKey });
    turn.emit({ type: "tool_call_start", id: callId, name: resolved });
    turn.emit({ type: "tool_call_delta", arguments: JSON.stringify(asRecord(payload.input)) });
    turn.emit({ type: "tool_call_end" });
    turn.emit({
      type: "done",
      stopReason: "tool_use",
      providerState: continuationFor(turn.ref, session.sessionId),
    });
    endTurn(session);
    turn.settle();
    return;
  }

  // An unrecognised reverse method still needs an answer rather than being left to expire inside the
  // model's context.
  session.denyPermission(frame, `OpenCodex does not handle ${frame.method ?? "this request"}.`);
}

/**
 * Map one runtime frame onto the client's event stream.
 *
 * The framed protocol nests the projected message: a frame is `{queryId, message: {...}}` and the
 * event type lives at `message.type`, NOT at `payload.type` the way `step --mode json` prints it.
 * Reading the wrong level makes every turn look idle until it times out, so the nesting is resolved
 * once here and every branch below works off the inner message.
 */
/**
 * Exported with `handleReverseRequest` for the same reason: the CLI's event vocabulary is the other
 * half of this transport, and the terminal-event mapping had no test at all until the suite pointed
 * out that it was the one thing a fake process must be able to deliver.
 */

/**
 * Map one runtime frame onto the client's event stream.
 *
 * The framed protocol nests the projected message: a frame is `{queryId, message: {...}}` and the
 * event type lives at `message.type`, NOT at `payload.type` the way `step --mode json` prints it.
 * Reading the wrong level makes every turn look idle until it times out, so the nesting is resolved
 * once here and every branch below works off the inner message.
 */
/**
 * Exported with `handleReverseRequest` for the same reason: the CLI's event vocabulary is the other
 * half of this transport, and the terminal-event mapping had no test at all until the suite pointed
 * out that it was the one thing a fake process must be able to deliver.
 */
export function handleRuntimeEvent(session: StepConversationSession, frame: StepFrame): void {
  const turn = currentTurn(session);
  if (!turn) return;
  const payload = asRecord(frame.payload);
  if (!turn.queryId || payload.queryId !== turn.queryId || currentQuery(session) !== turn.queryId) return;
  const message = asRecord(payload.message ?? payload);
  const type = typeof message.type === "string" ? message.type : undefined;

  if (type === "stream_event") {
    const event = asRecord(message.event);
    const delta = asRecord(event.delta);
    if (delta.type === "text_delta" && typeof delta.text === "string") {
      turn.emit({ type: "text_delta", text: delta.text });
      return;
    }
    if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
      turn.emit({ type: "thinking_delta", thinking: delta.thinking });
    }
    return;
  }

  if (type === "assistant") {
    const usage = toUsage(asRecord(asRecord(message.message).usage));
    if (usage) recordAssistantUsage(session, usage);
    return;
  }

  if (type === "status" && (message.status === "turn_complete" || message.status === "done")) {
    const usage = assistantUsage(session);
    turn.emit({
      type: "done",
      ...(usage ? { usage } : {}),
      stopReason: "stop",
      providerState: continuationFor(turn.ref, session.sessionId),
    });
    endTurn(session);
    turn.settle();
    // Release the runtime's single query slot for this conversation's next turn. Skipped when a tool
    // call was captured, which ends the turn earlier and keeps the query alive on purpose.
    const queryId = currentQuery(session);
    if (queryId) {
      forgetQuery(session);
      void session.endInput(queryId).catch(() => session.close());
    }
    return;
  }

  if (type === "permission_denied") {
    turn.emit({
      type: "error",
      message: `StepCode refused a tool call: ${typeof message.message === "string" ? message.message : "denied"}`,
      status: 400,
      errorType: "invalid_request_error",
      code: "step_cli_permission_denied",
      retryable: false,
    });
    endTurn(session);
    turn.settle();
  }
}

export const sessionHandlers = {
  onEvent(event: StepSessionEvent): void {
    if (event.type === "reverse_request") {
      handleReverseRequest(event.session, event.frame);
      return;
    }
    handleRuntimeEvent(event.session, event.frame);
  },
};
