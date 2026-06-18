import type { AdapterEvent, OcxUsage } from "./types";

function uuid(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

function sseEvent(name: string, data: Record<string, unknown>): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

interface OutputItem {
  type: string;
  id: string;
  [key: string]: unknown;
}

export function bridgeToResponsesSSE(
  events: AsyncIterable<AdapterEvent>,
  modelId: string,
  toolNsMap?: Map<string, { namespace: string; name: string }>,
  freeformToolNames?: Set<string>,
  toolSearchToolNames?: Set<string>,
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
  const responseId = `resp_${uuid()}`;
  let seq = 0;

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (name: string, data: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(sseEvent(name, { type: name, sequence_number: seq++, ...data })));
      };
      const emitDone = () => controller.enqueue(encoder.encode("data: [DONE]\n\n"));

      const createdAt = Math.floor(Date.now() / 1000);
      let outputIndex = 0;
      const finishedItems: OutputItem[] = [];

      const responseSnapshot = (status: string, output: OutputItem[]) => ({
        id: responseId, object: "response", created_at: createdAt,
        status, model: modelId, output, usage: null,
      });

      emit("response.created", { response: responseSnapshot("in_progress", []) });

      let currentMsg: { itemId: string; outputIndex: number; text: string } | null = null;
      let currentReasoning: { itemId: string; outputIndex: number; text: string } | null = null;
      let currentToolCall: { itemId: string; outputIndex: number; callId: string; name: string; args: string; namespace?: string; freeform?: boolean; toolSearch?: boolean } | null = null;

      const closeCurrentMessage = () => {
        if (!currentMsg) return;
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
        const item = {
          type: "reasoning", id: currentReasoning.itemId,
          summary: [{ type: "summary_text", text: currentReasoning.text }],
        };
        emit("response.output_item.done", { output_index: currentReasoning.outputIndex, item });
        finishedItems.push(item as OutputItem);
        outputIndex++;
        currentReasoning = null;
      };

      const closeCurrentToolCall = () => {
        if (!currentToolCall) return;
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
              arguments: currentToolCall.args, status: "completed",
              ...(currentToolCall.namespace ? { namespace: currentToolCall.namespace } : {}),
            };
        emit("response.output_item.done", { output_index: currentToolCall.outputIndex, item });
        finishedItems.push(item as OutputItem);
        outputIndex++;
        currentToolCall = null;
      };

      try {
        for await (const event of events) {
          switch (event.type) {
            case "text_delta": {
              if (currentReasoning) closeCurrentReasoning();
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
              if (currentMsg) closeCurrentMessage();
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
            case "tool_call_start": {
              if (currentMsg) closeCurrentMessage();
              if (currentReasoning) closeCurrentReasoning();
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
              if (currentToolCall) closeCurrentToolCall();
              const usage = event.usage ? {
                input_tokens: event.usage.inputTokens,
                output_tokens: event.usage.outputTokens,
                total_tokens: event.usage.inputTokens + event.usage.outputTokens,
              } : { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
              emit("response.completed", {
                response: { ...responseSnapshot("completed", finishedItems), usage },
              });
              break;
            }
            case "error": {
              if (currentMsg) closeCurrentMessage();
              if (currentReasoning) closeCurrentReasoning();
              if (currentToolCall) closeCurrentToolCall();
              emit("response.failed", {
                response: {
                  ...responseSnapshot("failed", finishedItems),
                  last_error: { type: "upstream_error", message: event.message },
                },
              });
              break;
            }
          }
        }
      } catch (err) {
        emit("response.failed", {
          response: {
            ...responseSnapshot("failed", finishedItems),
            last_error: { type: "proxy_error", message: err instanceof Error ? err.message : String(err) },
          },
        });
      }

      emitDone();
      controller.close();
    },
  });
}

export function buildResponseJSON(
  events: AdapterEvent[],
  modelId: string,
): Record<string, unknown> {
  const responseId = `resp_${uuid()}`;
  const output: OutputItem[] = [];
  let text = "";
  let usage: OcxUsage | undefined;

  for (const e of events) {
    if (e.type === "text_delta") text += e.text;
    if (e.type === "done") usage = e.usage;
  }

  if (text) {
    output.push({
      type: "message", id: `msg_${uuid()}`, role: "assistant", status: "completed",
      content: [{ type: "output_text", text, annotations: [] }],
    });
  }

  return {
    id: responseId, object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed", model: modelId, output,
    usage: usage ? {
      input_tokens: usage.inputTokens, output_tokens: usage.outputTokens,
      total_tokens: usage.inputTokens + usage.outputTokens,
    } : { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
  };
}

export function formatErrorResponse(status: number, type: string, message: string): Response {
  return new Response(JSON.stringify({ error: { message, type, code: null } }), {
    status, headers: { "Content-Type": "application/json" },
  });
}
