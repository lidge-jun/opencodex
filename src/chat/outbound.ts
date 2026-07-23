/**
 * Chat Completions outbound: internal /v1/responses output -> OpenAI Chat Completions shapes.
 *
 * Wire contract for GitHub Copilot App / OpenAI-compatible clients:
 *  - Streaming: `data: {choices:[{delta:...}]}` frames ending with `data: [DONE]`
 *  - Non-streaming: `{ id, object:"chat.completion", choices:[{message}], usage }`
 */
type Rec = Record<string, unknown>;

import { decodeServerSentEvents } from "../lib/sse-decoder";

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
  const cached = typeof details.cached_tokens === "number" ? details.cached_tokens : 0;
  const out: Rec = {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
  };
  // Detail objects are always emitted (zero defaults) so strict OpenAI-compatible
  // clients that require them (see responsesUsage in src/bridge.ts) never fail on
  // routed providers that report no cache/reasoning numbers.
  out.prompt_tokens_details = { cached_tokens: cached };
  const outDetails = isRec(u.output_tokens_details) ? u.output_tokens_details : {};
  const reasoning = typeof outDetails.reasoning_tokens === "number" ? outDetails.reasoning_tokens : 0;
  out.completion_tokens_details = { reasoning_tokens: reasoning };
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

/** Thrown when a Chat Completions SSE stream ends in a typed failure/truncation. */
export class ChatCompletionsStreamError extends Error {
  readonly status: number;
  readonly type: string;
  readonly code: string | null;

  constructor(message: string, options: { status?: number; type?: string; code?: string | null } = {}) {
    super(message);
    this.name = "ChatCompletionsStreamError";
    this.status = options.status ?? 502;
    this.type = options.type ?? "server_error";
    this.code = options.code ?? null;
  }
}

export function isChatCompletionsStreamError(err: unknown): err is ChatCompletionsStreamError {
  return err instanceof ChatCompletionsStreamError;
}

function streamErrorStatus(message: string): number {
  const lower = message.toLowerCase();
  if (lower.includes("truncated")) return 502;
  if (lower.includes("rate") || lower.includes("429")) return 429;
  if (lower.includes("unauthor") || lower.includes("401") || lower.includes("api key")) return 401;
  if (lower.includes("not found") || lower.includes("404")) return 404;
  if (lower.includes("invalid") || lower.includes("400")) return 400;
  return 502;
}

function streamErrorType(status: number): string {
  if (status === 401) return "authentication_error";
  if (status === 429) return "rate_limit_error";
  if (status >= 500) return "server_error";
  return "invalid_request_error";
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
  const encoder = new TextEncoder();
  let terminated = false;
  let cancelled = false;
  let started = false;
  let sawToolUse = false;
  const id = completionId();
  const created = Math.floor(Date.now() / 1000);
  // tool call_id -> streaming index (OpenAI requires stable indices per tool call)
  const toolIndexByCallId = new Map<string, number>();
  const toolIndexByItemId = new Map<string, number>();
  const toolCallIdByIndex = new Map<number, string>();
  const toolNameByIndex = new Map<number, string>();
  const toolArgumentsByIndex = new Map<number, string>();
  const emittedToolIndexes = new Set<number>();
  let nextToolIndex = 0;
  let sseIterator: AsyncGenerator<{ event?: string; data: string }> | undefined;
  const upstreamAbort = new AbortController();
  let controller: ReadableStreamDefaultController<Uint8Array>;
  let failed = false;
  let emittedFrames = 0;
  let stepping = false;
  let decoderStarted = false;
      const emit = (payload: Rec | "[DONE]") => {
        if (failed) return;
        controller.enqueue(encoder.encode(dataFrame(payload)));
        emittedFrames++;
      };
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
      const resolveFinalArguments = (candidate: unknown, streamed: string) => {
        if (typeof candidate !== "string") return streamed;
        // Some compatible providers send an empty final snapshot. Do not let that erase
        // non-empty streamed arguments; genuinely empty calls have no buffered content.
        return candidate.length > 0 || streamed.length === 0 ? candidate : streamed;
      };
      const emitToolCall = (toolIndex: number, callId: string, name: string, args: string) => {
        if (!callId || emittedToolIndexes.has(toolIndex)) return;
        emittedToolIndexes.add(toolIndex);
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
      };
      const flushPendingToolCalls = () => {
        const pending = [...toolCallIdByIndex.entries()].sort(([a], [b]) => a - b);
        for (const [toolIndex, callId] of pending) {
          emitToolCall(
            toolIndex,
            callId,
            toolNameByIndex.get(toolIndex) ?? "",
            toolArgumentsByIndex.get(toolIndex) ?? "",
          );
        }
      };
      const finish = (finishReason: string, usage: unknown) => {
        if (terminated) return;
        // A valid completed/incomplete terminal frame may arrive without output_item.done.
        // Preserve any known tool call before emitting its finish reason.
        flushPendingToolCalls();
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
        failed = true;
        // OpenAI-compatible clients need a real error event, not a success completion
        // that embeds `[error] ...` text followed by a clean [DONE].
        // Deliver the error frame then close the stream abnormally (no [DONE]).
        // Do not controller.error() — that can drop already-enqueued bytes from consumers
        // like response.text().
        const status = streamErrorStatus(message);
        const type = streamErrorType(status);
        try {
          controller.enqueue(encoder.encode(dataFrame({
            error: {
              message,
              type,
              param: null,
              code: status === 401 ? "invalid_api_key"
                : status === 404 ? "model_not_found"
                : status === 429 ? "rate_limit_exceeded"
                : null,
            },
          })));
          emittedFrames++;
        } catch {
          /* controller may already be closed */
        }
        try { controller.close(); } catch { /* already closed */ }
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
            toolCallIdByIndex.set(toolIndex, callId);
            if (typeof item.id === "string") toolIndexByItemId.set(item.id, toolIndex);
            if (name) toolNameByIndex.set(toolIndex, name);
            if (!toolArgumentsByIndex.has(toolIndex)) {
              toolArgumentsByIndex.set(
                toolIndex,
                typeof item.arguments === "string" ? item.arguments : "",
              );
            }
            break;
          }
          case "response.function_call_arguments.delta": {
            if (typeof data.delta !== "string" || data.delta.length === 0) break;
            const itemId = typeof data.item_id === "string" ? data.item_id : undefined;
            const toolIndex = (itemId ? toolIndexByItemId.get(itemId) : undefined)
              ?? (nextToolIndex > 0 ? nextToolIndex - 1 : 0);
            ensureRole();
            toolArgumentsByIndex.set(
              toolIndex,
              (toolArgumentsByIndex.get(toolIndex) ?? "") + data.delta,
            );
            break;
          }
          case "response.function_call_arguments.done": {
            const itemId = typeof data.item_id === "string" ? data.item_id : undefined;
            const toolIndex = itemId ? toolIndexByItemId.get(itemId) : undefined;
            if (toolIndex === undefined) break;
            sawToolUse = true;
            const name = typeof data.name === "string" ? data.name : "";
            if (name) toolNameByIndex.set(toolIndex, name);
            const streamedArgs = toolArgumentsByIndex.get(toolIndex) ?? "";
            toolArgumentsByIndex.set(
              toolIndex,
              resolveFinalArguments(data.arguments, streamedArgs),
            );
            break;
          }
          case "response.output_item.done": {
            const item = isRec(data.item) ? data.item : null;
            if (!item) break;
            if (item.type === "function_call") {
              sawToolUse = true;
              const callId = typeof item.call_id === "string" ? item.call_id : "";
              const name = typeof item.name === "string" ? item.name : "";
              if (!callId) break;
              const itemId = typeof item.id === "string" ? item.id : undefined;
              const existingIndex = toolIndexByCallId.get(callId)
                ?? (itemId ? toolIndexByItemId.get(itemId) : undefined);
              const toolIndex = existingIndex ?? nextToolIndex++;
              toolIndexByCallId.set(callId, toolIndex);
              toolCallIdByIndex.set(toolIndex, callId);
              if (itemId) toolIndexByItemId.set(itemId, toolIndex);
              if (name) toolNameByIndex.set(toolIndex, name);
              const finalName = name || toolNameByIndex.get(toolIndex) || "";
              const streamedArgs = toolArgumentsByIndex.get(toolIndex) ?? "";
              // A Responses stream can carry incremental/finalized argument events plus an
              // authoritative output_item.done snapshot. Chat Completions tool-call fields are
              // append-only deltas, so forwarding multiple representations corrupts clients that
              // accumulate them. Emit one complete call here; finish() flushes any item whose
              // done event was omitted, and replace-style clients still get a complete object.
              const args = resolveFinalArguments(item.arguments, streamedArgs);
              toolArgumentsByIndex.set(toolIndex, args);
              emitToolCall(toolIndex, callId, finalName, args);
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
              : undefined;
            if (reason !== undefined) {
              // Truthful OpenAI-compatible finish reasons: the turn ended, just early.
              finish(reason, response.usage);
            } else {
              // upstream_stall_timeout / adapter_eof / proxy-synthesized incompletes are
              // failures, not early finishes: emit an error frame and close WITHOUT
              // [DONE] instead of a success-looking stop/tool_calls + [DONE].
              const why = typeof details.reason === "string" ? details.reason : "unknown";
              const message = typeof details.message === "string" && details.message.length > 0
                ? details.message
                : `upstream stream ended early (${why})`;
              fail(message);
            }
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

      // Shared spec-shaped SSE decoder: handles CRLF framing, arbitrary chunk boundaries,
      // multi-line data, and a terminal event without a trailing blank line (Sol audit
      // blocker 3 — the hand-rolled "\n\n" splitter misreported those as truncation).
      sseIterator = decodeServerSentEvents(upstream, { signal: upstreamAbort.signal });
      const step = async () => {
        if (stepping || cancelled) return;
        stepping = true;
        const emittedAtStart = emittedFrames;
        try {
          while (!cancelled && emittedFrames === emittedAtStart) {
            decoderStarted = true;
            const next = await sseIterator!.next();
            if (next.done) {
              if (!cancelled && !terminated) {
                fail("upstream stream ended before a terminal frame (truncated response)");
              }
              // Success path: close after [DONE]. Failure path closes inside fail().
              if (!cancelled && terminated && !failed) {
                try { controller.close(); } catch { /* already closed */ }
              }
              break;
            }
            const record = next.value;
            const eventName = record.event ?? "";
            const dataLine = record.data.trim();
            if (!eventName || !dataLine) continue;
            let data: unknown;
            try { data = JSON.parse(dataLine); } catch { continue; }
            if (!isRec(data)) continue;
            if (terminated) continue;
            handleFrame(eventName, data);
          }
        } catch (err) {
          fail(err instanceof Error ? err.message : String(err));
        } finally {
          stepping = false;
        }
      };

  return new ReadableStream<Uint8Array>({
    start(streamController) {
      controller = streamController;
      // Default HWM=1: one Responses event is translated atomically, then upstream
      // decoding pauses until the chat consumer creates demand again.
    },
    pull() {
      return step();
    },
    cancel(reason) {
      cancelled = true;
      // Abort first: it cancels the decoder's underlying reader, settling any in-flight
      // read() so the generator's return() below resolves promptly instead of hanging
      // behind an idle upstream (Sol re-verification blocker).
      upstreamAbort.abort(reason);
      if (!decoderStarted) {
        return upstream.cancel(reason).then(() => undefined, () => undefined);
      }
      return sseIterator?.return(undefined).then(() => undefined, () => undefined) ?? Promise.resolve(undefined);
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
  let streamError: ChatCompletionsStreamError | null = null;
  const reader = stream.getReader();
  try {
    for (;;) {
      let done = false;
      let value: Uint8Array | undefined;
      try {
        ({ done, value } = await reader.read());
      } catch (err) {
        if (isChatCompletionsStreamError(err)) throw err;
        throw new ChatCompletionsStreamError(err instanceof Error ? err.message : String(err));
      }
      if (done) break;
      if (!value) continue;
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
          if (isRec(parsed.error)) {
            const message = typeof parsed.error.message === "string"
              ? parsed.error.message
              : "upstream request failed";
            const type = typeof parsed.error.type === "string" ? parsed.error.type : "server_error";
            const status = streamErrorStatus(message);
            streamError = new ChatCompletionsStreamError(message, { status, type });
            continue;
          }
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
              // Done-frame final arguments are authoritative last-write-wins snapshots.
              if (typeof fn.name === "string" && fn.name.length > 0) current.name = fn.name;
              if (typeof fn.arguments === "string") {
                if (fn.arguments.startsWith("{") || fn.arguments.startsWith("[") || current.arguments.length === 0) {
                  current.arguments = fn.arguments;
                } else {
                  current.arguments += fn.arguments;
                }
              }
              toolCalls.set(index, current);
            }
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
  if (streamError) throw streamError;

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
