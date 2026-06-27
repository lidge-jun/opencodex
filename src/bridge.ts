import type { AdapterEvent, OcxUsage } from "./types";
import { classifyError, type OcxErrorPayload } from "./errors";

function uuid(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

function sseEvent(name: string, data: Record<string, unknown>): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

function responsesUsage(usage: OcxUsage | undefined): Record<string, unknown> {
  if (!usage) return { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
  const out: Record<string, unknown> = {
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    total_tokens: usage.totalTokens ?? usage.inputTokens + usage.outputTokens,
  };
  if (usage.cachedInputTokens !== undefined) {
    out.input_tokens_details = { cached_tokens: usage.cachedInputTokens };
  }
  if (usage.reasoningOutputTokens !== undefined) {
    out.output_tokens_details = { reasoning_tokens: usage.reasoningOutputTokens };
  }
  return out;
}

function responseError(status: number, type: string, message: string): OcxErrorPayload {
  return classifyError(status, type, message);
}

interface OutputItem {
  type: string;
  id: string;
  [key: string]: unknown;
}

export type ResponsesTerminalStatus = "completed" | "failed" | "incomplete";

export function bridgeToResponsesSSE(
  events: AsyncIterable<AdapterEvent>,
  modelId: string,
  toolNsMap?: Map<string, { namespace: string; name: string }>,
  freeformToolNames?: Set<string>,
  toolSearchToolNames?: Set<string>,
  onCancel?: () => void,
  heartbeatMs = 2_000,
  options?: {
    responseId?: string;
    stallTimeoutSec?: number;
    hideThinkingSummary?: boolean;
    onTerminal?: (status: ResponsesTerminalStatus) => void;
    onCompletedResponse?: (response: Record<string, unknown>) => void;
  },
): ReadableStream<Uint8Array> {
  // Freeform/custom tools (apply_patch) carry their body in `input`; the model is given a
  // function with `{input:string}`, so unwrap it here when relaying back as a custom_tool_call.
  const freeformInput = (args: string): string => {
    try { const o = JSON.parse(args); if (o && typeof o.input === "string") return o.input; } catch { /* raw */ }
    return args;
  };
  // tool_search_call carries arguments as a JSON object ({query, limit}); parse the model's arg string.
  const parseArgsObj = (args: string): Record<string, unknown> => {
    try { const o = JSON.parse(args); return o && typeof o === "object" ? o : {}; } catch { return {}; }
  };
  const encoder = new TextEncoder();
  const responseId = options?.responseId ?? `resp_${uuid()}`;
  let seq = 0;
  // Set once the client is gone (cancel) or an enqueue throws on a torn-down controller, so we
  // never enqueue again and never throw a second time inside start() — the RC2 double-throw that
  // otherwise surfaced as proxy-side stream noise on every client disconnect.
  let closed = false;
  let clientCancelled = false;
  let terminalReported = false;
  const reportTerminal = (status: ResponsesTerminalStatus) => {
    if (terminalReported || clientCancelled || closed) return;
    terminalReported = true;
    options?.onTerminal?.(status);
  };
  // RC3 keep-alive: Codex's idle timer is timeout(idle_timeout, stream.next()) over an
  // eventsource_stream; ANY received event re-arms it, while an unknown type is ignored
  // (responses.rs `_ => Ok(None)`). We emit a real, parser-ignored `response.heartbeat` only during
  // upstream silence so a stalled routed provider never trips "idle timeout waiting for SSE".
  let activity = false;
  let beat: ReturnType<typeof setInterval> | undefined;

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (name: string, data: Record<string, unknown>) => {
        if (closed) return;
        activity = true;
        try {
          controller.enqueue(encoder.encode(sseEvent(name, { type: name, sequence_number: seq++, ...data })));
        } catch {
          closed = true;
        }
      };
      const emitDone = () => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        } catch {
          closed = true;
        }
      };

      const createdAt = Math.floor(Date.now() / 1000);
      let outputIndex = 0;
      const finishedItems: OutputItem[] = [];

      const responseSnapshot = (status: string, output: OutputItem[]) => ({
        id: responseId, object: "response", created_at: createdAt,
        status, model: modelId, output, usage: null,
      });

      emit("response.created", { response: responseSnapshot("in_progress", []) });

      // Re-arm Codex's idle timer during silence with a parser-ignored heartbeat (RC3). Skips a tick
      // whenever a real event was emitted since the last tick, so it only fires on a genuine stall.
      const heartbeatFrame = encoder.encode('event: response.heartbeat\ndata: {"type":"response.heartbeat"}\n\n');
      let stallTicks = 0;
      const stallSec = Math.max(1, options?.stallTimeoutSec ?? 90);
      const maxStallTicks = Math.ceil((stallSec * 1000) / heartbeatMs);
      beat = setInterval(() => {
        if (closed) return;
        if (activity) { activity = false; stallTicks = 0; return; }
        if (++stallTicks >= maxStallTicks) {
          if (currentMsg) closeCurrentMessage();
          if (currentReasoning) closeCurrentReasoning();
          if (currentRawReasoning) closeCurrentRawReasoning();
          if (currentToolCall) closeCurrentToolCall();
          emit("response.incomplete", {
            response: {
              ...responseSnapshot("incomplete", finishedItems),
              incomplete_details: { reason: "upstream_stall_timeout" },
            },
          });
          reportTerminal("incomplete");
          terminated = true;
          closed = true;
          clearInterval(beat!);
          beat = undefined;
          onCancel?.();
          return;
        }
        try { controller.enqueue(heartbeatFrame); } catch { closed = true; }
      }, heartbeatMs);

      let currentMsg: { itemId: string; outputIndex: number; text: string } | null = null;
      let currentReasoning: { itemId: string; outputIndex: number; text: string } | null = null;
      let currentRawReasoning: { itemId: string; outputIndex: number; text: string } | null = null;
      let currentToolCall: { itemId: string; outputIndex: number; callId: string; name: string; args: string; namespace?: string; freeform?: boolean; toolSearch?: boolean } | null = null;

      const closeCurrentMessage = () => {
        if (!currentMsg) return;
        // Finalize the text part (Responses protocol). Without these .done events Codex never
        // commits the content part and renders the message as truncated / cut off.
        emit("response.output_text.done", {
          item_id: currentMsg.itemId, output_index: currentMsg.outputIndex, content_index: 0, text: currentMsg.text,
        });
        emit("response.content_part.done", {
          item_id: currentMsg.itemId, output_index: currentMsg.outputIndex, content_index: 0,
          part: { type: "output_text", text: currentMsg.text, annotations: [] },
        });
        const item = {
          type: "message", id: currentMsg.itemId, status: "completed", role: "assistant",
          content: [{ type: "output_text", text: currentMsg.text, annotations: [] }],
        };
        emit("response.output_item.done", { output_index: currentMsg.outputIndex, item });
        finishedItems.push(item as OutputItem);
        outputIndex++;
        currentMsg = null;
      };

      const closeCurrentReasoning = () => {
        if (!currentReasoning) return;
        emit("response.reasoning_summary_text.done", {
          item_id: currentReasoning.itemId, output_index: currentReasoning.outputIndex, summary_index: 0, text: currentReasoning.text,
        });
        emit("response.reasoning_summary_part.done", {
          item_id: currentReasoning.itemId, output_index: currentReasoning.outputIndex, summary_index: 0,
          part: { type: "summary_text", text: currentReasoning.text },
        });
        const item = {
          type: "reasoning", id: currentReasoning.itemId,
          summary: [{ type: "summary_text", text: currentReasoning.text }],
        };
        emit("response.output_item.done", { output_index: currentReasoning.outputIndex, item });
        finishedItems.push(item as OutputItem);
        outputIndex++;
        currentReasoning = null;
      };

      const closeCurrentRawReasoning = () => {
        if (!currentRawReasoning) return;
        const item = {
          type: "reasoning", id: currentRawReasoning.itemId, summary: [],
          content: [{ type: "reasoning_text", text: currentRawReasoning.text }],
        };
        emit("response.output_item.done", { output_index: currentRawReasoning.outputIndex, item });
        finishedItems.push(item as OutputItem);
        outputIndex++;
        currentRawReasoning = null;
      };

      const closeCurrentToolCall = () => {
        if (!currentToolCall) return;
        // Empty input (no-arg tools like computer_use get_app_state / list_apps) must serialize as
        // "{}", never "" — Codex echoes the call back as a function_call next turn, and JSON.parse("")
        // would 400 the whole session ("invalid JSON arguments"), poisoning all later turns.
        const argsStr = currentToolCall.args || "{}";
        // Finalize streamed function-call arguments so Codex commits the call (incl. MCP / computer_use).
        if (!currentToolCall.freeform && !currentToolCall.toolSearch) {
          emit("response.function_call_arguments.done", {
            item_id: currentToolCall.itemId, output_index: currentToolCall.outputIndex, arguments: argsStr,
          });
        }
        const item = currentToolCall.toolSearch
          ? {
              type: "tool_search_call", id: currentToolCall.itemId,
              call_id: currentToolCall.callId, execution: "client",
              arguments: parseArgsObj(currentToolCall.args), status: "completed",
            }
          : currentToolCall.freeform
          ? {
              type: "custom_tool_call", id: currentToolCall.itemId,
              call_id: currentToolCall.callId, name: currentToolCall.name,
              input: freeformInput(currentToolCall.args), status: "completed",
            }
          : {
              type: "function_call", id: currentToolCall.itemId,
              call_id: currentToolCall.callId, name: currentToolCall.name,
              arguments: argsStr, status: "completed",
              ...(currentToolCall.namespace ? { namespace: currentToolCall.namespace } : {}),
            };
        emit("response.output_item.done", { output_index: currentToolCall.outputIndex, item });
        finishedItems.push(item as OutputItem);
        outputIndex++;
        currentToolCall = null;
      };

      // RC1: guarantee the Responses stream always ends with exactly one terminal event. Set true
      // when a done/error/catch terminal is emitted; if the adapter generator returns without one
      // we synthesize response.completed below, so Codex never hits the parser's
      // "stream closed before response.completed" (responses.rs) -> ApiError::Stream.
      let terminated = false;

      try {
        for await (const event of events) {
          activity = true;
          stallTicks = 0;
          switch (event.type) {
            case "text_delta": {
              if (currentReasoning) closeCurrentReasoning();
              if (currentRawReasoning) closeCurrentRawReasoning();
              if (currentToolCall) closeCurrentToolCall();
              if (!currentMsg) {
                const itemId = `msg_${uuid()}`;
                const item = {
                  type: "message", id: itemId, status: "in_progress", role: "assistant",
                  content: [] as { type: string; text: string; annotations: never[] }[],
                };
                emit("response.output_item.added", { output_index: outputIndex, item });
                emit("response.content_part.added", {
                  item_id: itemId, output_index: outputIndex, content_index: 0,
                  part: { type: "output_text", text: "", annotations: [] },
                });
                currentMsg = { itemId, outputIndex, text: "" };
              }
              currentMsg.text += event.text;
              emit("response.output_text.delta", {
                item_id: currentMsg.itemId, output_index: currentMsg.outputIndex,
                content_index: 0, delta: event.text,
              });
              break;
            }
            case "thinking_delta": {
              if (options?.hideThinkingSummary) break;
              if (currentMsg) closeCurrentMessage();
              if (currentRawReasoning) closeCurrentRawReasoning();
              if (currentToolCall) closeCurrentToolCall();
              if (!currentReasoning) {
                const itemId = `rs_${uuid()}`;
                const item = { type: "reasoning", id: itemId, summary: [] as { type: string; text: string }[] };
                emit("response.output_item.added", { output_index: outputIndex, item });
                emit("response.reasoning_summary_part.added", {
                  item_id: itemId, output_index: outputIndex, summary_index: 0,
                  part: { type: "summary_text", text: "" },
                });
                currentReasoning = { itemId, outputIndex, text: "" };
              }
              currentReasoning.text += event.thinking;
              emit("response.reasoning_summary_text.delta", {
                item_id: currentReasoning.itemId, output_index: currentReasoning.outputIndex,
                summary_index: 0, delta: event.thinking,
              });
              break;
            }
            case "reasoning_raw_delta": {
              if (currentMsg) closeCurrentMessage();
              if (currentReasoning) closeCurrentReasoning();
              if (currentToolCall) closeCurrentToolCall();
              if (!currentRawReasoning) {
                const itemId = `rs_${uuid()}`;
                const item = { type: "reasoning", id: itemId, summary: [] as never[], content: [] as { type: string; text: string }[] };
                emit("response.output_item.added", { output_index: outputIndex, item });
                currentRawReasoning = { itemId, outputIndex, text: "" };
              }
              currentRawReasoning.text += event.text;
              emit("response.reasoning_text.delta", {
                item_id: currentRawReasoning.itemId, output_index: currentRawReasoning.outputIndex,
                content_index: 0, delta: event.text,
              });
              break;
            }
            case "tool_call_start": {
              if (currentMsg) closeCurrentMessage();
              if (currentReasoning) closeCurrentReasoning();
              if (currentRawReasoning) closeCurrentRawReasoning();
              if (currentToolCall) closeCurrentToolCall();
              const itemId = `fc_${uuid()}`;
              const mapped = toolNsMap?.get(event.name);
              const realName = mapped?.name ?? event.name;
              const ns = mapped?.namespace;
              const toolSearch = toolSearchToolNames?.has(realName) ?? false;
              const freeform = !toolSearch && (freeformToolNames?.has(realName) ?? false);
              const item = toolSearch
                ? { type: "tool_search_call", id: itemId, call_id: event.id, execution: "client", arguments: {}, status: "in_progress" }
                : freeform
                ? { type: "custom_tool_call", id: itemId, call_id: event.id, name: realName, input: "", status: "in_progress" }
                : { type: "function_call", id: itemId, call_id: event.id, name: realName, arguments: "", status: "in_progress", ...(ns ? { namespace: ns } : {}) };
              emit("response.output_item.added", { output_index: outputIndex, item });
              currentToolCall = { itemId, outputIndex, callId: event.id, name: realName, args: "", namespace: ns, freeform, toolSearch };
              break;
            }
            case "tool_call_delta": {
              if (currentToolCall) {
                currentToolCall.args += event.arguments;
                if (!currentToolCall.freeform && !currentToolCall.toolSearch) {
                  emit("response.function_call_arguments.delta", {
                    item_id: currentToolCall.itemId, output_index: currentToolCall.outputIndex,
                    delta: event.arguments,
                  });
                }
              }
              break;
            }
            case "tool_call_end": {
              closeCurrentToolCall();
              break;
            }
            case "done": {
              if (currentMsg) closeCurrentMessage();
              if (currentReasoning) closeCurrentReasoning();
              if (currentRawReasoning) closeCurrentRawReasoning();
              if (currentToolCall) closeCurrentToolCall();
              const response = { ...responseSnapshot("completed", finishedItems), usage: responsesUsage(event.usage) };
              options?.onCompletedResponse?.(response);
              emit("response.completed", {
                response,
              });
              reportTerminal("completed");
              terminated = true;
              break;
            }
            case "error": {
              if (currentMsg) closeCurrentMessage();
              if (currentReasoning) closeCurrentReasoning();
              if (currentRawReasoning) closeCurrentRawReasoning();
              if (currentToolCall) closeCurrentToolCall();
              emit("response.failed", {
                response: {
                  ...responseSnapshot("failed", finishedItems),
                  error: responseError(502, "upstream_error", event.message),
                  last_error: responseError(502, "upstream_error", event.message),
                },
              });
              reportTerminal("failed");
              terminated = true;
              break;
            }
          }
        }
      } catch (err) {
        emit("response.failed", {
          response: {
            ...responseSnapshot("failed", finishedItems),
            error: responseError(500, "proxy_error", err instanceof Error ? err.message : String(err)),
            last_error: responseError(500, "proxy_error", err instanceof Error ? err.message : String(err)),
          },
        });
        reportTerminal("failed");
        terminated = true;
      }

      if (beat) clearInterval(beat);

      if (!terminated) {
        // The adapter generator ended without an explicit done/error event. Mark as incomplete
        // rather than completed so Codex can distinguish a clean finish from a truncated stream.
        if (currentMsg) closeCurrentMessage();
        if (currentReasoning) closeCurrentReasoning();
        if (currentRawReasoning) closeCurrentRawReasoning();
        if (currentToolCall) closeCurrentToolCall();
        emit("response.incomplete", {
          response: {
            ...responseSnapshot("incomplete", finishedItems),
            usage: responsesUsage(undefined),
            incomplete_details: { reason: "adapter_eof" },
          },
        });
        reportTerminal("incomplete");
      }

      emitDone();
      try {
        controller.close();
      } catch {
        /* already closed (e.g. client cancelled) */
      }
    },
    cancel() {
      // Client (Codex) disconnected. Stop emitting and let the caller abort the upstream fetch so a
      // cancelled turn does not leak the upstream stream or keep draining tokens (RC2).
      clientCancelled = true;
      closed = true;
      if (beat) clearInterval(beat);
      onCancel?.();
    },
  });
}

export function buildResponseJSON(
  events: AdapterEvent[],
  modelId: string,
  options?: {
    hideThinkingSummary?: boolean;
    toolNsMap?: Map<string, { namespace: string; name: string }>;
    freeformToolNames?: Set<string>;
    toolSearchToolNames?: Set<string>;
  },
): Record<string, unknown> {
  const responseId = `resp_${uuid()}`;
  const output: OutputItem[] = [];
  let usage: OcxUsage | undefined;
  let errorMessage: string | undefined;

  let currentText = "";
  let currentSummaryReasoning = "";
  let currentRawReasoning = "";
  let currentToolCallId = "";
  let currentToolCallName = "";
  let currentToolCallArgs = "";

  const freeformInput = (args: string): string => {
    try { const o = JSON.parse(args); if (o && typeof o.input === "string") return o.input; } catch { /* raw */ }
    return args;
  };
  const parseArgsObj = (args: string): Record<string, unknown> => {
    try { const o = JSON.parse(args); return o && typeof o === "object" ? o : {}; } catch { return {}; }
  };

  const flushText = () => {
    if (!currentText) return;
    output.push({
      type: "message", id: `msg_${uuid()}`, role: "assistant", status: "completed",
      content: [{ type: "output_text", text: currentText, annotations: [] }],
    });
    currentText = "";
  };
  const flushSummaryReasoning = () => {
    if (!currentSummaryReasoning || options?.hideThinkingSummary) { currentSummaryReasoning = ""; return; }
    output.push({
      type: "reasoning", id: `rs_${uuid()}`,
      summary: [{ type: "summary_text", text: currentSummaryReasoning }],
    });
    currentSummaryReasoning = "";
  };
  const flushRawReasoning = () => {
    if (!currentRawReasoning) return;
    output.push({
      type: "reasoning", id: `rs_${uuid()}`, summary: [],
      content: [{ type: "reasoning_text", text: currentRawReasoning }],
    });
    currentRawReasoning = "";
  };
  const flushToolCall = () => {
    if (!currentToolCallId) return;
    const mapped = options?.toolNsMap?.get(currentToolCallName);
    const realName = mapped?.name ?? currentToolCallName;
    const ns = mapped?.namespace;
    const toolSearch = options?.toolSearchToolNames?.has(realName) ?? false;
    const freeform = !toolSearch && (options?.freeformToolNames?.has(realName) ?? false);
    if (toolSearch) {
      output.push({
        type: "tool_search_call", id: `fc_${uuid()}`,
        call_id: currentToolCallId, execution: "client",
        arguments: parseArgsObj(currentToolCallArgs), status: "completed",
      });
    } else if (freeform) {
      output.push({
        type: "custom_tool_call", id: `fc_${uuid()}`,
        call_id: currentToolCallId, name: realName,
        input: freeformInput(currentToolCallArgs), status: "completed",
      });
    } else {
      output.push({
        type: "function_call", id: `fc_${uuid()}`,
        call_id: currentToolCallId, name: realName,
        arguments: currentToolCallArgs || "{}", status: "completed",
        ...(ns ? { namespace: ns } : {}),
      });
    }
    currentToolCallId = "";
    currentToolCallName = "";
    currentToolCallArgs = "";
  };

  for (const e of events) {
    switch (e.type) {
      case "text_delta":
        if (currentSummaryReasoning) flushSummaryReasoning();
        if (currentRawReasoning) flushRawReasoning();
        if (currentToolCallId) flushToolCall();
        currentText += e.text;
        break;
      case "thinking_delta":
        if (currentText) flushText();
        if (currentRawReasoning) flushRawReasoning();
        if (currentToolCallId) flushToolCall();
        currentSummaryReasoning += e.thinking;
        break;
      case "reasoning_raw_delta":
        if (currentText) flushText();
        if (currentSummaryReasoning) flushSummaryReasoning();
        if (currentToolCallId) flushToolCall();
        currentRawReasoning += e.text;
        break;
      case "tool_call_start":
        if (currentText) flushText();
        if (currentSummaryReasoning) flushSummaryReasoning();
        if (currentRawReasoning) flushRawReasoning();
        flushToolCall();
        currentToolCallId = e.id;
        currentToolCallName = e.name;
        currentToolCallArgs = "";
        break;
      case "tool_call_delta":
        currentToolCallArgs += e.arguments;
        break;
      case "tool_call_end":
        flushToolCall();
        break;
      case "error":
        errorMessage = e.message;
        break;
      case "done":
        usage = e.usage;
        break;
    }
  }
  flushText();
  flushSummaryReasoning();
  flushRawReasoning();
  flushToolCall();

  return {
    id: responseId, object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: errorMessage ? "failed" : "completed",
    model: modelId, output,
    ...(errorMessage ? { error: { message: errorMessage } } : {}),
    usage: responsesUsage(usage),
  };
}

export function formatErrorResponse(status: number, type: string, message: string): Response {
  return new Response(JSON.stringify({ error: classifyError(status, type, message) }), {
    status, headers: { "Content-Type": "application/json" },
  });
}
