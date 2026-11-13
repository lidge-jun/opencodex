/**
 * Ollama-compatible inbound API: /api/version, /api/tags, /api/show, /api/chat and /api/generate.
 *
 * The model list describes configured provider routes this proxy can serve, not models stored on
 * this machine. Generation is translated into an internal Chat Completions request and handled by
 * the ordinary Chat path, so routing, admission scope, retries and usage accounting stay shared.
 * The final request-log row is owned here (see ./native-final-log): only this handler knows
 * whether its own conversion succeeded or the client went away.
 */
import { OllamaCodecError, consumeOllamaChatChunk, createOllamaStreamState, ollamaBufferedResponse, ollamaStreamTerminal, ollamaToChat, type OllamaKind } from "../protocols/codecs/ollama";
import { createTranslatorBudget, isTranslatorBudgetExceededError } from "../lib/translator-budget";
import type { OcxConfig } from "../types";
import type { DataPlaneAdmission } from "./auth-cors";
import { resolveAdmissionModelScope, routeAllowedByScope } from "./admission-model-scope";
import { handleChatCompletions } from "./chat-completions";
import { VERSION } from "./management-api";
import {
  NATIVE_MAX_RETRY_AFTER_SECONDS,
  applyLocalRefusalCode,
  commitCancelled,
  drainedInnerErrorMessage,
  internalChatRequest,
  nativeInnerErrorMessage,
  nativeRefusalParts,
  nativeRetryAfter,
  streamNativeFromChat,
  type NativeLogIds,
} from "./native-chat-bridge";
import { createNativeFinalLog, type NativeFinalLog } from "./native-final-log";
import { findOllamaRoute, listOllamaRoutes, preflightOllamaRoute } from "./ollama-route-policy";
import { DecompressedBodyTooLargeError, readJsonRequestBody, resolveInboundBodyLimitBytes } from "./request-decompress";
import { addFinalRequestLog, type RequestLogContext } from "./request-log";

const SHOW_BODY_LIMIT_BYTES = 64 * 1024;

/** Upper bound for the retry advice this surface passes on. */
export const OLLAMA_MAX_RETRY_AFTER_SECONDS = NATIVE_MAX_RETRY_AFTER_SECONDS;

/** Retry-After as an integer we format ourselves; see nativeRetryAfter. */
export const ollamaRetryAfter = nativeRetryAfter;

/**
 * Every Ollama error response is built from scratch: content type, our own error text, and
 * optionally a reformatted Retry-After. Callers add CORS and the request-log id; nothing is
 * copied from another response.
 */
export function ollamaError(status: number, message: string, retryAfter?: string | null): Response {
  const headers = new Headers({ "content-type": "application/json" });
  const advice = ollamaRetryAfter(retryAfter);
  if (advice !== undefined) headers.set("Retry-After", advice);
  return new Response(JSON.stringify({ error: message }), { status, headers });
}

/** Reshape an existing proxy refusal (capacity, workflow, drain) keeping its status and retry advice. */
export function toOllamaRefusal(response: Response): Response {
  const parts = nativeRefusalParts(response);
  return applyLocalRefusalCode(ollamaError(parts.status, parts.message, parts.retryAfter), parts.localRefusalCode);
}

export function handleOllamaVersion(): Response {
  return Response.json({ version: VERSION });
}

function eligibleRoutes(config: OcxConfig, req: Request, admission: DataPlaneAdmission) {
  const scope = resolveAdmissionModelScope(config, admission);
  return listOllamaRoutes(config, req)
    .filter(row => routeAllowedByScope(scope, { providerName: row.route.providerName, modelId: row.route.modelId }));
}

export function handleOllamaTags(config: OcxConfig, req: Request, admission: DataPlaneAdmission): Response {
  return Response.json({ models: eligibleRoutes(config, req, admission).map(row => ({ name: row.selector, model: row.selector })) });
}

export async function handleOllamaShow(config: OcxConfig, req: Request, admission: DataPlaneAdmission): Promise<Response> {
  let body: unknown;
  try { body = await readJsonRequestBody(req, undefined, SHOW_BODY_LIMIT_BYTES); }
  catch (error) { return ollamaError(error instanceof DecompressedBodyTooLargeError ? 413 : 400, "invalid request body"); }
  const record = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : undefined;
  const model = record?.model;
  if (!record || Object.keys(record).some(key => key !== "model" && key !== "verbose") || typeof model !== "string" || !model.trim()) {
    return ollamaError(400, "model is required");
  }
  // Same eligibility as /api/tags: a configured concrete route the caller's key may use.
  // Same eligibility as /api/tags, resolved for this selector only.
  const row = findOllamaRoute(config, model, req);
  const scope = resolveAdmissionModelScope(config, admission);
  if (!row || !routeAllowedByScope(scope, { providerName: row.route.providerName, modelId: row.route.modelId })) return ollamaError(404, "model not found");
  // Only facts this proxy knows. No file size, digest, template, license or local model details.
  return Response.json({ details: {}, model_info: {}, capabilities: ["completion"] });
}

export type OllamaLogIds = NativeLogIds;

function failBeforeInner(ids: OllamaLogIds, logCtx: RequestLogContext, status: number, message: string): Response {
  addFinalRequestLog(ids.requestId, ids.start, logCtx, status, { closeReason: "non_stream" });
  return ollamaError(status, message);
}

export const ollamaInnerErrorMessage = nativeInnerErrorMessage;

/** /api/chat and /api/generate. `req` is the admitted, session-promoted request. */
export async function handleOllamaGeneration(
  kind: OllamaKind,
  req: Request,
  config: OcxConfig,
  logCtx: RequestLogContext,
  ids: OllamaLogIds,
): Promise<Response> {
  const limit = resolveInboundBodyLimitBytes(config.maxInboundBodyBytes);
  const budget = createTranslatorBudget();
  let chat: Record<string, unknown>;
  try {
    chat = ollamaToChat(kind, await readJsonRequestBody(req, budget, limit));
  } catch (error) {
    if (req.signal.aborted) return failBeforeInner(ids, logCtx, 499, "request cancelled");
    if (error instanceof DecompressedBodyTooLargeError) return failBeforeInner(ids, logCtx, 413, "request body too large");
    if (isTranslatorBudgetExceededError(error)) return failBeforeInner(ids, logCtx, 502, "request translation buffer exceeded the safe limit");
    return failBeforeInner(ids, logCtx, 400, error instanceof OllamaCodecError ? error.message : "invalid JSON body");
  } finally {
    budget.dispose();
  }
  const model = chat.model as string;
  logCtx.requestedModel = model;
  const preflight = preflightOllamaRoute(config, model, req);
  if (!preflight.ok) {
    logCtx.errorCode = preflight.error.code;
    return failBeforeInner(ids, logCtx, preflight.error.status, preflight.error.message);
  }
  // Both Chat delivery paths already report streamed usage on their own; the body stays as a Chat caller sends it.
  const stream = chat.stream === true;
  const chatJson = JSON.stringify(chat);
  if (Buffer.byteLength(chatJson) > limit) return failBeforeInner(ids, logCtx, 413, "request body too large");
  const internal = internalChatRequest(req, chatJson);
  const finalLog = createNativeFinalLog(ids.requestId, ids.start, logCtx);
  const createdAt = new Date().toISOString();
  let inner: Response;
  try {
    inner = await handleChatCompletions(internal, config, logCtx, { ...ids, suppressProtocolTrace: true });
  } catch {
    await finalLog.waitForInner();
    if (req.signal.aborted) return cancelledNonStream(finalLog);
    finalLog.commit({ status: 502, terminalStatus: "failed", closeReason: "non_stream" });
    return ollamaError(502, "request failed");
  }
  if (!inner.ok || !inner.body) {
    const message = await drainedInnerErrorMessage(inner);
    await finalLog.waitForInner();
    if (req.signal.aborted) return cancelledNonStream(finalLog);
    finalLog.commit({ status: inner.ok ? 502 : inner.status, terminalStatus: "failed", closeReason: "non_stream" });
    return ollamaError(inner.ok ? 502 : inner.status, message, inner.headers.get("retry-after"));
  }
  return stream
    ? streamOllama(kind, model, createdAt, inner.body, finalLog, req.signal)
    : bufferedOllama(kind, model, createdAt, inner, finalLog, req.signal);
}

/** A client that left before the outer outcome was committed owns a 499 row, whatever the inner path reported. */
function cancelledNonStream(finalLog: NativeFinalLog): Response {
  commitCancelled(finalLog);
  return ollamaError(499, "request cancelled");
}

/** Exported for the settlement-window cancellation test; production callers go through handleOllamaGeneration. */
export async function bufferedOllama(kind: OllamaKind, model: string, createdAt: string, inner: Response, finalLog: NativeFinalLog, signal: AbortSignal): Promise<Response> {
  let native: Record<string, unknown>;
  try {
    native = ollamaBufferedResponse(kind, model, JSON.parse(await inner.text()), createdAt);
  } catch {
    await finalLog.waitForInner();
    if (signal.aborted) return cancelledNonStream(finalLog);
    finalLog.commit({ status: 502, terminalStatus: "failed", closeReason: "non_stream" });
    return ollamaError(502, "invalid upstream response");
  }
  const settled = await finalLog.waitForInner();
  if (signal.aborted) return cancelledNonStream(finalLog);
  if (native.done !== true || !settled) {
    finalLog.commit({ status: 502, terminalStatus: "failed", closeReason: "non_stream" });
    return ollamaError(502, typeof native.error === "string" ? native.error : "request did not complete");
  }
  finalLog.commit({ status: 200, terminalStatus: "completed", closeReason: "non_stream" });
  return Response.json(native);
}

const encoder = new TextEncoder();
const line = (record: unknown) => encoder.encode(`${JSON.stringify(record)}\n`);

/** Exported for the settlement-window cancellation test; production callers go through handleOllamaGeneration. */
export function streamOllama(kind: OllamaKind, model: string, createdAt: string, body: ReadableStream<Uint8Array>, finalLog: NativeFinalLog, signal: AbortSignal): Response {
  const state = createOllamaStreamState(kind, model, createdAt);
  return streamNativeFromChat({
    contentType: "application/x-ndjson",
    chunk: parsed => consumeOllamaChatChunk(state, parsed).map(line),
    terminal() {
      const record = ollamaStreamTerminal(state);
      return record.done === true
        ? { ok: true, frames: () => [line(record)] }
        : { ok: false, error: typeof record.error === "string" ? record.error : "request did not complete" };
    },
    failure: message => [line({ error: message })],
  }, body, finalLog, signal);
}
