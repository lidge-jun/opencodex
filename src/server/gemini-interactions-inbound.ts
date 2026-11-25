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
  disposeInteractionsStream,
  encodeInteractionsEvents,
  chainInput,
  interactionAssistantMessage,
  interactionResource,
  interactionTimestamp,
  interactionsStreamAnswer,
  interactionsStreamFailure,
  interactionsStreamTerminal,
  interactionsToChat,
  newInteractionId,
  type InteractionAnswer,
  type InteractionMeta,
  type InteractionsRequestPlan,
} from "../protocols/codecs/gemini-interactions";
import { createTranslatorBudget, isTranslatorBudgetExceededError } from "../lib/translator-budget";
import type { OcxConfig } from "../types";
import { geminiError } from "./gemini-inbound";
import { commitCancelled, drainedInnerErrorMessage, handleNativeChat, streamNativeFromChat, type NativeLogIds } from "./native-chat-bridge";
import { createNativeFinalLog, type NativeFinalLog } from "./native-final-log";
import { forgetInteraction, interactionEntryBytes, MAX_INTERACTION_BYTES, recallInteraction, rememberInteraction } from "./gemini-interactions-store";
import { resolveContextPrincipal, type DataPlaneAdmission } from "./auth-cors";
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

/** Header telling a client whether a requested store was kept; a later chain on an unkept turn is 404. */
export const INTERACTION_STORED_HEADER = "x-opencodex-interaction-stored";

/**
 * Who owns a stored interaction: the salted principal of the data-plane key the caller presented
 * (also on a loopback bind, where admission itself reads no key), or one shared "loopback" owner for
 * a keyless loopback caller. Rotating a key mints a new principal, so its chains then answer 404.
 */
export function interactionOwner(req: Request, config: OcxConfig, admission: DataPlaneAdmission | undefined): string | undefined {
  return resolveContextPrincipal(req, config, admission) ?? (admission?.kind === "loopback" ? "loopback" : undefined);
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
  let originalBody: unknown;
  let plan: InteractionsRequestPlan;
  try {
    originalBody = await readJsonRequestBody(req, budget, limit);
    plan = interactionsToChat(originalBody);
  } catch (error) {
    if (req.signal.aborted) return failBeforeInner(ids, logCtx, 499, "request cancelled");
    if (error instanceof DecompressedBodyTooLargeError) return failBeforeInner(ids, logCtx, 413, "request body too large");
    if (isTranslatorBudgetExceededError(error)) return failBeforeInner(ids, logCtx, 502, "request translation buffer exceeded the safe limit");
    return failBeforeInner(ids, logCtx, 400, error instanceof InteractionsCodecError ? error.message : "invalid JSON body");
  } finally {
    budget.dispose();
  }
  const owner = interactionOwner(req, config, ids.admission);
  let history: Record<string, unknown>[] = [];
  if (plan.previousInteractionId !== undefined) {
    const stored = recallInteraction(plan.previousInteractionId, owner);
    if (!stored) return failBeforeInner(ids, logCtx, 404, "interaction not found");
    history = [...stored.history];
  }
  // Google's chained tool flow sends only the results; their calls are the stored turn's pending calls.
  const input = chainInput(history, plan);
  if (!input) return failBeforeInner(ids, logCtx, 400, "unmatched function_result");
  logCtx.requestedModel = plan.model;
  const preflight = preflightOllamaRoute(config, plan.model, req);
  if (!preflight.ok) {
    logCtx.errorCode = preflight.error.code;
    return failBeforeInner(ids, logCtx, preflight.error.status, preflight.error.message);
  }
  const chatJson = JSON.stringify({ ...plan.chat, messages: [...plan.systemMessages, ...history, ...input] });
  if (Buffer.byteLength(chatJson) > limit) return failBeforeInner(ids, logCtx, 413, "request body too large");
  const finalLog = createNativeFinalLog(ids.requestId, ids.start, logCtx);
  let inner: Response;
  try {
    inner = await handleNativeChat(req, originalBody, chatJson, config, logCtx, ids);
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
  // Interaction-scoped fields (system_instruction, tools, generation_config) are never stored.
  // A stored history larger than the inbound limit could never be chained, so it is not kept.
  const keep: Keep | undefined = plan.store
    ? { owner, history: [...history, ...input], inputSteps: plan.inputSteps, maxBytes: limit, ...(plan.previousInteractionId ? { previous: plan.previousInteractionId } : {}) }
    : undefined;
  if (plan.previousInteractionId) meta.previousInteractionId = plan.previousInteractionId;
  return plan.stream
    ? streamInteraction(meta, inner.body, finalLog, req.signal, keep)
    : bufferedInteraction(meta, inner, finalLog, req.signal, keep);
}

/** What a stored turn keeps: its owner, the history to continue from, and its input steps. */
interface Keep { owner: string | undefined; history: Record<string, unknown>[]; inputSteps: Record<string, unknown>[]; maxBytes: number; previous?: string }

/** Store a settled turn. False when it has no owner, is too large to keep, or storing failed. */
function remember(keep: Keep, meta: InteractionMeta, answer: InteractionAnswer, resource: Record<string, unknown>): boolean {
  if (keep.owner === undefined) return false;
  const assistant = interactionAssistantMessage(answer);
  try {
    return rememberInteraction({
      id: meta.id,
      owner: keep.owner,
      history: assistant ? [...keep.history, assistant] : keep.history,
      resource: { ...resource, steps: [...keep.inputSteps, ...(resource.steps as Record<string, unknown>[])] },
    }, Date.now(), keep.maxBytes);
  } catch {
    // Storing is best effort; the settled answer still goes out.
    return false;
  }
}

async function bufferedInteraction(meta: InteractionMeta, inner: Response, finalLog: NativeFinalLog, signal: AbortSignal, keep?: Keep): Promise<Response> {
  let resource: Record<string, unknown>;
  let answer: InteractionAnswer;
  try {
    answer = chatCompletionAnswer(JSON.parse(await inner.text()));
    resource = interactionResource(meta, answer, interactionTimestamp());
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
  const stored = keep ? remember(keep, meta, answer, resource) : undefined;
  finalLog.commit({ status: 200, terminalStatus: "completed", closeReason: "non_stream" });
  const response = Response.json(resource);
  if (stored !== undefined) {
    response.headers.set(INTERACTION_STORED_HEADER, stored ? "true" : "false");
    response.headers.set("Access-Control-Expose-Headers", INTERACTION_STORED_HEADER);
  }
  return response;
}

function streamInteraction(meta: InteractionMeta, body: ReadableStream<Uint8Array>, finalLog: NativeFinalLog, signal: AbortSignal, keep?: Keep): Response {
  const budget = createTranslatorBudget();
  const remainingEntryBytes = keep?.owner === undefined ? 0 : Math.min(keep.maxBytes, MAX_INTERACTION_BYTES) - interactionEntryBytes({
    history: keep.history,
    resource: { ...interactionResource(meta, { content: "", reasoning: "", calls: [], status: "completed" }), steps: keep.inputSteps },
  });
  const state = createInteractionsStreamState(meta, budget, remainingEntryBytes);
  return streamNativeFromChat({
    dispose: () => disposeInteractionsStream(state),
    contentType: "text/event-stream",
    chunk: parsed => encodeInteractionsEvents(consumeInteractionsChatChunk(state, parsed)),
    terminal() {
      const answer = interactionsStreamAnswer(state);
      if (!answer) return { ok: false, error: "request did not complete" };
      const { status, usage } = answer;
      // frames() runs only after the inner path settled successfully.
      return { ok: true, frames: () => {
        const updated = interactionTimestamp();
        if (keep && state.retained) {
          const retained = interactionsStreamAnswer(state)!;
          remember(keep, meta, retained, interactionResource(meta, retained, updated));
        }
        return encodeInteractionsEvents(interactionsStreamTerminal(state, { status, usage }, updated));
      } };
    },
    failure: message => encodeInteractionsEvents(interactionsStreamFailure(state, 502, message)),
  }, body, finalLog, signal);
}


/**
 * GET and DELETE /v1beta|v1/interactions/{id}, POST …/{id}/cancel. Owner-scoped (a foreign id is
 * indistinguishable from a missing one, cancel included); never forwarded upstream.
 */
export function handleGeminiInteractionResource(
  route: { kind: "interaction" | "interaction-cancel"; id: string },
  req: Request,
  config: OcxConfig,
  admission: DataPlaneAdmission,
): Response {
  const owner = interactionOwner(req, config, admission);
  const method = req.method;
  if (route.kind === "interaction-cancel") {
    return recallInteraction(route.id, owner)
      ? geminiError(400, "only background interactions can be cancelled")
      : geminiError(404, "interaction not found");
  }
  if (method === "DELETE") return forgetInteraction(route.id, owner) ? Response.json({}) : geminiError(404, "interaction not found");
  const stored = recallInteraction(route.id, owner);
  return stored ? Response.json(stored.resource) : geminiError(404, "interaction not found");
}
