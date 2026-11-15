/**
 * Gemini Interactions API inbound: POST /v1beta/interactions and /v1/interactions.
 *
 * Same shape as the generateContent inbound (./gemini-inbound): the create body is translated into
 * an internal Chat Completions request handled by the ordinary Chat path, this handler owns the
 * final request-log row, and errors use the Google {error:{code,message,status}} body with a fixed
 * message chosen by status. Streams use the Interactions SSE vocabulary.
 */
import {
  InteractionsCodecError,
  chatCompletionAnswer,
  consumeInteractionsChatChunk,
  createInteractionsStreamState,
  encodeInteractionsEvents,
  interactionResource,
  interactionTimestamp,
  interactionsStreamAnswer,
  interactionsStreamFailure,
  interactionsStreamTerminal,
  interactionsToChat,
  newInteractionId,
  type InteractionMeta,
  type InteractionsRequestPlan,
} from "../protocols/codecs/gemini-interactions";
import { createTranslatorBudget, isTranslatorBudgetExceededError } from "../lib/translator-budget";
import type { OcxConfig } from "../types";
import { handleChatCompletions } from "./chat-completions";
import { geminiError } from "./gemini-inbound";
import { commitCancelled, drainedInnerErrorMessage, internalChatRequest, streamNativeFromChat, type NativeLogIds } from "./native-chat-bridge";
import { createNativeFinalLog, type NativeFinalLog } from "./native-final-log";
import { preflightOllamaRoute } from "./ollama-route-policy";
import { DecompressedBodyTooLargeError, readJsonRequestBody, resolveInboundBodyLimitBytes } from "./request-decompress";
import { addFinalRequestLog, type RequestLogContext } from "./request-log";

function failBeforeInner(ids: NativeLogIds, logCtx: RequestLogContext, status: number, message: string): Response {
  addFinalRequestLog(ids.requestId, ids.start, logCtx, status, { closeReason: "non_stream" });
  return geminiError(status, message);
}

function cancelledNonStream(finalLog: NativeFinalLog): Response {
  commitCancelled(finalLog);
  return geminiError(499, "request cancelled");
}

/** The Chat messages for a plan: system first, then the conversation. */
export function planMessages(plan: InteractionsRequestPlan, history: Record<string, unknown>[] = []): Record<string, unknown>[] {
  return [...plan.systemMessages, ...history, ...plan.inputMessages];
}

/** POST /v1beta/interactions. `req` is the admitted, session-promoted request. */
export async function handleGeminiInteraction(
  req: Request,
  config: OcxConfig,
  logCtx: RequestLogContext,
  ids: NativeLogIds,
): Promise<Response> {
  const limit = resolveInboundBodyLimitBytes(config.maxInboundBodyBytes);
  const budget = createTranslatorBudget();
  let plan: InteractionsRequestPlan;
  try {
    plan = interactionsToChat(await readJsonRequestBody(req, budget, limit));
  } catch (error) {
    if (req.signal.aborted) return failBeforeInner(ids, logCtx, 499, "request cancelled");
    if (error instanceof DecompressedBodyTooLargeError) return failBeforeInner(ids, logCtx, 413, "request body too large");
    if (isTranslatorBudgetExceededError(error)) return failBeforeInner(ids, logCtx, 502, "request translation buffer exceeded the safe limit");
    return failBeforeInner(ids, logCtx, 400, error instanceof InteractionsCodecError ? error.message : "invalid JSON body");
  } finally {
    budget.dispose();
  }
  if (plan.previousInteractionId !== undefined) return failBeforeInner(ids, logCtx, 400, "previous_interaction_id is not supported");
  if (plan.unmatchedResultIds.length) return failBeforeInner(ids, logCtx, 400, "unmatched function_result");
  logCtx.requestedModel = plan.model;
  const preflight = preflightOllamaRoute(config, plan.model, req);
  if (!preflight.ok) {
    logCtx.errorCode = preflight.error.code;
    return failBeforeInner(ids, logCtx, preflight.error.status, preflight.error.message);
  }
  const chatJson = JSON.stringify({ ...plan.chat, messages: planMessages(plan) });
  if (Buffer.byteLength(chatJson) > limit) return failBeforeInner(ids, logCtx, 413, "request body too large");
  const internal = internalChatRequest(req, chatJson);
  const finalLog = createNativeFinalLog(ids.requestId, ids.start, logCtx);
  let inner: Response;
  try {
    inner = await handleChatCompletions(internal, config, logCtx, { ...ids, suppressProtocolTrace: true });
  } catch {
    await finalLog.waitForInner();
    if (req.signal.aborted) return cancelledNonStream(finalLog);
    finalLog.commit({ status: 502, terminalStatus: "failed", closeReason: "non_stream" });
    return geminiError(502, "request failed");
  }
  if (!inner.ok || !inner.body) {
    const message = await drainedInnerErrorMessage(inner);
    await finalLog.waitForInner();
    if (req.signal.aborted) return cancelledNonStream(finalLog);
    finalLog.commit({ status: inner.ok ? 502 : inner.status, terminalStatus: "failed", closeReason: "non_stream" });
    return geminiError(inner.ok ? 502 : inner.status, message, inner.headers.get("retry-after"));
  }
  const meta: InteractionMeta = { id: newInteractionId(), model: plan.model, created: interactionTimestamp() };
  return plan.stream
    ? streamInteraction(meta, inner.body, finalLog, req.signal)
    : bufferedInteraction(meta, inner, finalLog, req.signal);
}

async function bufferedInteraction(meta: InteractionMeta, inner: Response, finalLog: NativeFinalLog, signal: AbortSignal): Promise<Response> {
  let resource: Record<string, unknown>;
  try {
    resource = interactionResource(meta, chatCompletionAnswer(JSON.parse(await inner.text())), interactionTimestamp());
  } catch {
    await finalLog.waitForInner();
    if (signal.aborted) return cancelledNonStream(finalLog);
    finalLog.commit({ status: 502, terminalStatus: "failed", closeReason: "non_stream" });
    return geminiError(502, "invalid upstream response");
  }
  const settled = await finalLog.waitForInner();
  if (signal.aborted) return cancelledNonStream(finalLog);
  if (!settled) {
    finalLog.commit({ status: 502, terminalStatus: "failed", closeReason: "non_stream" });
    return geminiError(502, "request did not complete");
  }
  finalLog.commit({ status: 200, terminalStatus: "completed", closeReason: "non_stream" });
  return Response.json(resource);
}

function streamInteraction(meta: InteractionMeta, body: ReadableStream<Uint8Array>, finalLog: NativeFinalLog, signal: AbortSignal): Response {
  const state = createInteractionsStreamState(meta);
  return streamNativeFromChat({
    contentType: "text/event-stream",
    chunk: parsed => encodeInteractionsEvents(consumeInteractionsChatChunk(state, parsed)),
    terminal() {
      const answer = interactionsStreamAnswer(state);
      if (!answer) return { ok: false, error: "request did not complete" };
      // frames() runs only after the inner path settled successfully.
      return { ok: true, frames: () => encodeInteractionsEvents(interactionsStreamTerminal(state, answer, interactionTimestamp())) };
    },
    failure: message => encodeInteractionsEvents(interactionsStreamFailure(state, 502, message)),
  }, body, finalLog, signal);
}

