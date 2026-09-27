/**
 * AdapterEvent -> OpenAI Chat Completions, without the internal Responses SSE (PF-09).
 *
 * The writer reproduces `responsesSseToChatCompletionsSse` (src/chat/outbound.ts) for the frames
 * the bridge produced: one role frame first, content and `reasoning_content` deltas, each
 * function call as ONE complete tool_call chunk at its completion (Chat tool-call fields are
 * append-only, so the converter never streamed partial arguments), a finish chunk carrying the
 * usage, then `[DONE]`; failures end with one `{error}` frame and no `[DONE]`. Wire-silence
 * heartbeats become `: opencodex heartbeat` SSE comments, as the converter relays them. Ids, the finish
 * and error mapping and the usage shape are the converter's own exported helpers.
 */
import type { AdapterEvent } from "../../types";
import type { TranslatorBudget } from "../../lib/translator-budget";
import { responsesUsage } from "../../bridge/internal";
import {
  chatCompletionsErrorResponse,
  chatCompletionsFailedResponse,
  chatCompletionsIncompleteOutcome,
  chatCompletionsStreamErrorPayload,
  chatCompletionsUsage,
  chunkBase,
  collectChatCompletion,
  completionId,
  dataFrame,
  isChatCompletionsStreamError,
  type ChatCompletionsStreamFailure,
} from "../../chat/outbound";
import {
  encodeAdapterEventStream,
  type AdapterEventEncodeOptions,
  type ClientFrameSink,
  type ClientWireWriter,
} from "./adapter-events";
import type { RelayedEventObservation } from "../../usage/attempt-delivery";

type Rec = Record<string, unknown>;

export interface ChatCompletionEncodeOptions extends AdapterEventEncodeOptions {
  /** The model string the client asked for; every chunk carries it. */
  model: string;
}

function createChatCompletionWriter(sink: ClientFrameSink, model: string): ClientWireWriter {
  const id = completionId();
  const created = Math.floor(Date.now() / 1000);
  let started = false;
  let sawToolUse = false;
  let terminated = false;
  let failed = false;
  // call_id -> streaming index: OpenAI requires a stable index per tool call.
  const toolIndexByCallId = new Map<string, number>();
  const toolIndexByItemId = new Map<string, number>();
  const toolNameByIndex = new Map<number, string>();
  const emittedToolIndexes = new Set<number>();
  let nextToolIndex = 0;
  let staged: { text: string; observation?: RelayedEventObservation }[] | undefined;

  const emit = (payload: Rec | "[DONE]", observation?: RelayedEventObservation) => {
    if (failed) return;
    const text = dataFrame(payload);
    if (staged) staged.push({ text, ...(observation ? { observation } : {}) });
    else sink.emit(text, observation);
  };
  const ensureRole = () => {
    if (started) return;
    started = true;
    const frame = chunkBase(id, model, created);
    frame.choices = [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }];
    emit(frame);
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
    emit(frame, { sideEffect: true, semanticBytes: Buffer.byteLength(args) });
  };
  // Every started call reaches toolDone before a finishing terminal (the driver closes or fails
  // it first), so the converter's pending-call flush has nothing left to flush here.
  const finish = (finishReason: string, usage: Rec | null) => {
    if (terminated) return;
    // Admit every terminal frame before exposing any of them.
    const batch: NonNullable<typeof staged> = [];
    staged = batch;
    try {
      ensureRole();
      const frame = chunkBase(id, model, created);
      frame.choices = [{ index: 0, delta: {}, finish_reason: finishReason }];
      if (usage) frame.usage = chatCompletionsUsage(usage);
      emit(frame, { terminal: true });
      emit("[DONE]");
    } finally {
      staged = undefined;
    }
    sink.emitBatch(batch);
    terminated = true;
  };
  const fail = (message: string, details?: ChatCompletionsStreamFailure) => {
    if (terminated) return;
    terminated = true;
    failed = true;
    // A real error event, then an abnormal close without [DONE].
    const { payload, bounded } = chatCompletionsStreamErrorPayload(message, details);
    try {
      if (bounded) sink.emitBounded(dataFrame(payload));
      else sink.emit(dataFrame(payload), { terminal: true });
    } catch {
      /* the converter drops an unadmittable error frame the same way */
    }
  };

  return {
    start: ensureRole,
    heartbeat() {
      // The converter answers each typed heartbeat with the role frame (once) and then an SSE
      // comment (#5805): transport liveness without a chunk a parser could count as output.
      if (terminated) return;
      ensureRole();
      sink.emitKeepalive(": opencodex heartbeat\n\n");
    },
    text(delta) {
      if (!delta) return;
      ensureRole();
      const frame = chunkBase(id, model, created);
      frame.choices = [{ index: 0, delta: { content: delta }, finish_reason: null }];
      emit(frame, { semanticBytes: Buffer.byteLength(delta) });
    },
    messageDone() { /* the converter reads nothing from a finished message */ },
    reasoning(delta) {
      if (!delta) return;
      ensureRole();
      // Many OpenAI-compatible clients accept reasoning_content; harmless if ignored.
      const frame = chunkBase(id, model, created);
      frame.choices = [{ index: 0, delta: { reasoning_content: delta }, finish_reason: null }];
      emit(frame, { semanticBytes: Buffer.byteLength(delta) });
    },
    reasoningDone() { /* reasoning items carry nothing a Chat client reads */ },
    toolStart(call) {
      // Custom and tool-search calls have no Chat representation; the converter skips them.
      if (call.kind !== "function") return;
      ensureRole();
      sawToolUse = true;
      let toolIndex = toolIndexByCallId.get(call.callId);
      if (toolIndex === undefined) {
        toolIndex = nextToolIndex++;
        toolIndexByCallId.set(call.callId, toolIndex);
      }
      toolIndexByItemId.set(call.itemId, toolIndex);
      if (call.name) toolNameByIndex.set(toolIndex, call.name);
    },
    toolArgsDelta() { /* arguments are delivered once, complete, at toolDone */ },
    toolArgsDone() { /* likewise */ },
    toolDone(call) {
      if (call.kind !== "function") return;
      sawToolUse = true;
      if (!call.callId) return;
      const toolIndex = toolIndexByCallId.get(call.callId) ?? toolIndexByItemId.get(call.itemId) ?? nextToolIndex++;
      toolIndexByCallId.set(call.callId, toolIndex);
      toolIndexByItemId.set(call.itemId, toolIndex);
      if (call.name) toolNameByIndex.set(toolIndex, call.name);
      // The completed arguments are never empty ("{}" at least), so they win over the stream.
      emitToolCall(toolIndex, call.callId, call.name || toolNameByIndex.get(toolIndex) || "", call.arguments);
    },
    webSearchDone() { /* server-side search has no Chat representation */ },
    terminal(terminal) {
      if (terminal.status === "completed") {
        finish(sawToolUse ? "tool_calls" : "stop", responsesUsage(terminal.usage));
        return;
      }
      if (terminal.status === "incomplete") {
        const outcome = chatCompletionsIncompleteOutcome(terminal.incomplete?.reason, terminal.incomplete?.message);
        if ("finishReason" in outcome) {
          finish(outcome.finishReason, terminal.usageOnWire ? responsesUsage(terminal.usage) : null);
        } else {
          fail(outcome.failMessage);
        }
        return;
      }
      const failure = chatCompletionsFailedResponse((terminal.error ?? {}) as unknown as Rec);
      fail(failure.message, failure.details);
    },
    overflow() {
      fail("upstream translation buffer exceeded the safe limit", {
        code: "translation_buffer_limit",
        status: 502,
        type: "upstream_error",
      });
    },
    dispose() { /* nothing retained beyond the driver's frames */ },
  };
}

/** Stream adapter events as Chat Completions SSE bytes. */
export function encodeChatCompletionSse(
  events: AsyncIterable<AdapterEvent>,
  options: ChatCompletionEncodeOptions,
): ReadableStream<Uint8Array> {
  return encodeAdapterEventStream(events, sink => createChatCompletionWriter(sink, options.model), options);
}

/**
 * Fold an encoded Chat stream into the non-streaming client response, with the status mapping
 * the Chat ingress applied to its collected completion: a stream failure becomes the matching
 * Chat error response, anything else unexpected a 502.
 */
export async function collectChatCompletionResponse(
  stream: ReadableStream<Uint8Array>,
  model: string,
  translatorBudget: TranslatorBudget,
): Promise<Response> {
  try {
    const completion = await collectChatCompletion(stream, model, translatorBudget);
    return new Response(JSON.stringify(completion), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    if (isChatCompletionsStreamError(err)) {
      return chatCompletionsErrorResponse(err.status, err.message, err.type, err.code);
    }
    return chatCompletionsErrorResponse(502, err instanceof Error ? err.message : String(err), "server_error");
  }
}

/** Non-streaming client: the encoded stream folded exactly as the Chat collector folds it. */
export function foldChatCompletion(
  events: AsyncIterable<AdapterEvent>,
  options: ChatCompletionEncodeOptions,
): Promise<Response> {
  return collectChatCompletionResponse(encodeChatCompletionSse(events, options), options.model, options.translatorBudget);
}
