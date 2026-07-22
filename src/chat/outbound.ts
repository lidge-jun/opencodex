/**
 * Chat Completions outbound: internal /v1/responses output -> OpenAI Chat Completions shapes.
 *
 * Wire contract for GitHub Copilot App / OpenAI-compatible clients:
 *  - Streaming: `data: {choices:[{delta:...}]}` frames ending with `data: [DONE]`
 *  - Non-streaming: `{ id, object:"chat.completion", choices:[{message}], usage }`
 */
type Rec = Record<string, unknown>;

function isRec(v: unknown): v is Rec {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function uuid(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

function completionId(): string {
  return `chatcmpl-${uuid().slice(0, 24)}`;
}

/** Responses usage (inclusive input_tokens) -> Chat Completions usage. */
export function chatCompletionsUsage(usage: unknown): Rec {
  const u = isRec(usage) ? usage : {};
  const details = isRec(u.input_tokens_details) ? u.input_tokens_details : {};
  const prompt = typeof u.input_tokens === "number" ? u.input_tokens : 0;
  const completion = typeof u.output_tokens === "number" ? u.output_tokens : 0;
  const cached = typeof details.cached_tokens === "number" ? details.cached_tokens : undefined;
  const out: Rec = {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
  };
  if (cached !== undefined) {
    out.prompt_tokens_details = { cached_tokens: cached };
  }
  const outDetails = isRec(u.output_tokens_details) ? u.output_tokens_details : {};
  if (typeof outDetails.reasoning_tokens === "number") {
    out.completion_tokens_details = { reasoning_tokens: outDetails.reasoning_tokens };
  }
  return out;
}

export function chatCompletionsErrorBody(status: number, message: string, type = "invalid_request_error"): Rec {
  return {
    error: {
      message,
      type,
      param: null,
      code: status === 401 ? "invalid_api_key"
        : status === 404 ? "model_not_found"
        : status === 429 ? "rate_limit_exceeded"
        : null,
    },
  };
}

export function chatCompletionsErrorResponse(status: number, message: string, type?: string): Response {
  return new Response(JSON.stringify(chatCompletionsErrorBody(status, message, type)), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function dataFrame(payload: Rec | "[DONE]"): string {
  if (payload === "[DONE]") return "data: [DONE]\n\n";
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function chunkBase(id: string, model: string, created: number): Rec {
  return {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [],
  };
}

/**
 * Streaming: Responses SSE bytes -> Chat Completions SSE bytes.
 */
export function responsesSseToChatCompletionsSse(
  upstream: ReadableStream<Uint8Array>,
  model: string,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  let terminated = false;
  let cancelled = false;
  let started = false;
  let sawToolUse = false;
  const id = completionId();
  const created = Math.floor(Date.now() / 1000);
  // tool call_id -> streaming index (OpenAI requires stable indices per tool call)
  const toolIndexByCallId = new Map<string, number>();
  let nextToolIndex = 0;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const emit = (payload: Rec | "[DONE]") => controller.enqueue(encoder.encode(dataFrame(payload)));
      const ensureRole = () => {
        if (started) return;
        started = true;
        const frame = chunkBase(id, model, created);
        frame.choices = [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }];
        emit(frame);
      };
      const emitContent = (text: string) => {
        if (!text) return;
        ensureRole();
        const frame = chunkBase(id, model, created);
        frame.choices = [{ index: 0, delta: { content: text }, finish_reason: null }];
        emit(frame);
      };
      const emitReasoning = (text: string) => {
        if (!text) return;
        ensureRole();
        // Many OpenAI-compatible clients accept reasoning_content; harmless if ignored.
        const frame = chunkBase(id, model, created);
        frame.choices = [{ index: 0, delta: { reasoning_content: text }, finish_reason: null }];
        emit(frame);
      };
      const finish = (finishReason: string, usage: unknown) => {
        if (terminated) return;
        terminated = true;
        ensureRole();
        const frame = chunkBase(id, model, created);
        frame.choices = [{ index: 0, delta: {}, finish_reason: finishReason }];
        if (usage) frame.usage = chatCompletionsUsage(usage);
        emit(frame);
        emit("[DONE]");
      };
      const fail = (message: string) => {
        if (terminated) return;
        terminated = true;
        ensureRole();
        // Mid-stream error as a final frame with finish_reason stop, then DONE.
        // Clients that only parse deltas still terminate cleanly.
        const frame = chunkBase(id, model, created);
        frame.choices = [{ index: 0, delta: { content: `\n\n[error] ${message}` }, finish_reason: "stop" }];
        emit(frame);
        emit("[DONE]");
      };

      const handleFrame = (eventName: string, data: Rec) => {
        switch (eventName) {
          case "response.created":
          case "response.heartbeat":
            ensureRole();
            break;
          case "response.output_text.delta": {
            if (typeof data.delta === "string") emitContent(data.delta);
            break;
          }
          case "response.reasoning_summary_text.delta":
          case "response.reasoning_text.delta": {
            if (typeof data.delta === "string") emitReasoning(data.delta);
            break;
          }
          case "response.output_item.added": {
            const item = isRec(data.item) ? data.item : null;
            if (!item || item.type !== "function_call") break;
            ensureRole();
            sawToolUse = true;
            const callId = typeof item.call_id === "string" ? item.call_id : `call_${uuid().slice(0, 16)}`;
            const name = typeof item.name === "string" ? item.name : "";
            let toolIndex = toolIndexByCallId.get(callId);
            if (toolIndex === undefined) {
              toolIndex = nextToolIndex++;
              toolIndexByCallId.set(callId, toolIndex);
            }
            const frame = chunkBase(id, model, created);
            frame.choices = [{
              index: 0,
              delta: {
                tool_calls: [{
                  index: toolIndex,
                  id: callId,
                  type: "function",
                  function: { name, arguments: "" },
                }],
              },
              finish_reason: null,
            }];
            emit(frame);
            break;
          }
          case "response.function_call_arguments.delta": {
            if (typeof data.delta !== "string" || data.delta.length === 0) break;
            // Prefer item_id matching when present; otherwise use the last open tool index.
            let toolIndex = nextToolIndex > 0 ? nextToolIndex - 1 : 0;
            const itemId = typeof data.item_id === "string" ? data.item_id : undefined;
            if (itemId) {
              // Some bridges put call_id on the item, not item_id; keep last index.
            }
            ensureRole();
            const frame = chunkBase(id, model, created);
            frame.choices = [{
              index: 0,
              delta: {
                tool_calls: [{
                  index: toolIndex,
                  function: { arguments: data.delta },
                }],
              },
              finish_reason: null,
            }];
            emit(frame);
            break;
          }
          case "response.output_item.done": {
            const item = isRec(data.item) ? data.item : null;
            if (!item) break;
            if (item.type === "function_call") {
              sawToolUse = true;
              const callId = typeof item.call_id === "string" ? item.call_id : "";
              const name = typeof item.name === "string" ? item.name : "";
              const args = typeof item.arguments === "string" ? item.arguments : "";
              if (!callId) break;
              let toolIndex = toolIndexByCallId.get(callId);
              if (toolIndex === undefined) {
                // No prior added event — emit a complete tool call chunk.
                toolIndex = nextToolIndex++;
                toolIndexByCallId.set(callId, toolIndex);
                ensureRole();
                const frame = chunkBase(id, model, created);
                frame.choices = [{
                  index: 0,
                  delta: {
                    tool_calls: [{
                      index: toolIndex,
                      id: callId,
                      type: "function",
                      function: { name, arguments: args },
                    }],
                  },
                  finish_reason: null,
                }];
                emit(frame);
              }
            }
            break;
          }
          case "response.completed": {
            const response = isRec(data.response) ? data.response : {};
            finish(sawToolUse ? "tool_calls" : "stop", response.usage);
            break;
          }
          case "response.incomplete": {
            const response = isRec(data.response) ? data.response : {};
            const details = isRec(response.incomplete_details) ? response.incomplete_details : {};
            const reason = details.reason === "max_output_tokens" ? "length"
              : details.reason === "content_filter" ? "content_filter"
              : sawToolUse ? "tool_calls" : "stop";
            finish(reason, response.usage);
            break;
          }
          case "response.failed": {
            const response = isRec(data.response) ? data.response : {};
            const error = isRec(response.error) ? response.error : {};
            const message = typeof error.message === "string" ? error.message : "upstream request failed";
            fail(message);
            break;
          }
          default:
            break;
        }
      };

      reader = upstream.getReader();
      void (async () => {
        try {
          for (;;) {
            const { done, value } = await reader!.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let sep: number;
            while ((sep = buffer.indexOf("\n\n")) !== -1) {
              const rawFrame = buffer.slice(0, sep);
              buffer = buffer.slice(sep + 2);
              let eventName = "";
              let dataLine = "";
              for (const line of rawFrame.split("\n")) {
                if (line.startsWith("event: ")) eventName = line.slice(7).trim();
                else if (line.startsWith("data: ")) dataLine += line.slice(6);
              }
              if (!eventName || !dataLine) continue;
              let data: unknown;
              try { data = JSON.parse(dataLine); } catch { continue; }
              if (!isRec(data)) continue;
              if (terminated) continue;
              handleFrame(eventName, data);
            }
          }
          if (!cancelled && !terminated) {
            fail("upstream stream ended before a terminal frame (truncated response)");
          }
        } catch (err) {
          fail(err instanceof Error ? err.message : String(err));
        } finally {
          reader?.releaseLock();
          if (!cancelled) {
            try { controller.close(); } catch { /* already closed */ }
          }
        }
      })();
    },
    cancel(reason) {
      cancelled = true;
      return reader?.cancel(reason);
    },
  });
}

/** Non-streaming: /v1/responses JSON -> Chat Completions message JSON. */
export function responsesJsonToChatCompletion(json: unknown, model: string): Rec {
  const body = isRec(json) ? json : {};
  const output = Array.isArray(body.output) ? body.output : [];
  let content = "";
  let reasoning = "";
  const toolCalls: Rec[] = [];

  for (const raw of output) {
    if (!isRec(raw)) continue;
    if (raw.type === "message" && Array.isArray(raw.content)) {
      for (const part of raw.content) {
        if (isRec(part) && part.type === "output_text" && typeof part.text === "string") {
          content += part.text;
        }
      }
    } else if (raw.type === "reasoning") {
      if (Array.isArray(raw.summary)) {
        for (const part of raw.summary) {
          if (isRec(part) && part.type === "summary_text" && typeof part.text === "string") {
            reasoning += part.text;
          }
        }
      }
      if (Array.isArray(raw.content)) {
        for (const part of raw.content) {
          if (isRec(part) && part.type === "reasoning_text" && typeof part.text === "string") {
            reasoning += part.text;
          }
        }
      }
    } else if (raw.type === "function_call") {
      toolCalls.push({
        id: typeof raw.call_id === "string" ? raw.call_id : `call_${uuid().slice(0, 16)}`,
        type: "function",
        function: {
          name: typeof raw.name === "string" ? raw.name : "",
          arguments: typeof raw.arguments === "string" ? raw.arguments : "{}",
        },
      });
    }
  }

  const finishReason = toolCalls.length > 0 ? "tool_calls"
    : body.status === "incomplete" ? "length"
    : "stop";

  const message: Rec = {
    role: "assistant",
    content: content || null,
  };
  if (reasoning) message.reasoning_content = reasoning;
  if (toolCalls.length > 0) message.tool_calls = toolCalls;

  return {
    id: completionId(),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message,
      finish_reason: finishReason,
      logprobs: null,
    }],
    usage: chatCompletionsUsage(body.usage),
  };
}

/** Fold a Chat Completions SSE stream into a final completion JSON. */
export async function collectChatCompletion(
  stream: ReadableStream<Uint8Array>,
  model: string,
): Promise<Rec> {
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let reasoning = "";
  const toolCalls = new Map<number, { id: string; name: string; arguments: string }>();
  let finishReason = "stop";
  let usage: unknown;
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const rawFrame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        for (const line of rawFrame.split("\n")) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6).trim();
          if (!data || data === "[DONE]") continue;
          let parsed: unknown;
          try { parsed = JSON.parse(data); } catch { continue; }
          if (!isRec(parsed)) continue;
          if (parsed.usage) usage = parsed.usage;
          const choices = Array.isArray(parsed.choices) ? parsed.choices : [];
          const choice = isRec(choices[0]) ? choices[0] : null;
          if (!choice) continue;
          if (typeof choice.finish_reason === "string") finishReason = choice.finish_reason;
          const delta = isRec(choice.delta) ? choice.delta : null;
          if (!delta) continue;
          if (typeof delta.content === "string") content += delta.content;
          if (typeof delta.reasoning_content === "string") reasoning += delta.reasoning_content;
          if (Array.isArray(delta.tool_calls)) {
            for (const tc of delta.tool_calls) {
              if (!isRec(tc)) continue;
              const index = typeof tc.index === "number" ? tc.index : 0;
              const current = toolCalls.get(index) ?? { id: "", name: "", arguments: "" };
              if (typeof tc.id === "string") current.id = tc.id;
              const fn = isRec(tc.function) ? tc.function : {};
              if (typeof fn.name === "string") current.name += fn.name;
              if (typeof fn.arguments === "string") current.arguments += fn.arguments;
              toolCalls.set(index, current);
            }
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  const message: Rec = {
    role: "assistant",
    content: content || null,
  };
  if (reasoning) message.reasoning_content = reasoning;
  if (toolCalls.size > 0) {
    message.tool_calls = [...toolCalls.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, tc]) => ({
        id: tc.id || `call_${uuid().slice(0, 16)}`,
        type: "function",
        function: { name: tc.name, arguments: tc.arguments },
      }));
    if (finishReason === "stop") finishReason = "tool_calls";
  }

  return {
    id: completionId(),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message,
      finish_reason: finishReason,
      logprobs: null,
    }],
    usage: usage && isRec(usage) ? usage : chatCompletionsUsage(undefined),
  };
}
