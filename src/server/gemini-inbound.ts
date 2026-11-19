/**
 * Gemini-compatible inbound API: GET /v1beta/models[/{model}] and POST
 * /v1beta|v1/models/{model}:generateContent|streamGenerateContent (countTokens and the embed
 * methods answer 501).
 *
 * Same shape as the Ollama inbound (./ollama-inbound): the model list describes configured
 * provider routes, generation is translated into an internal Chat Completions request handled by
 * the ordinary Chat path, and this handler owns the final request-log row. Errors use the Gemini
 * `{ error: { code, message, status } }` body with a fixed message chosen by HTTP status.
 */
import { GeminiCodecError, chatToGeminiResponse, consumeGeminiChatChunk, createGeminiStreamState, geminiStreamTerminal, geminiToChat } from "../protocols/codecs/gemini";
import { createTranslatorBudget, isTranslatorBudgetExceededError } from "../lib/translator-budget";
import type { OcxConfig } from "../types";
import type { DataPlaneAdmission } from "./auth-cors";
import { resolveAdmissionModelScope, routeAllowedByScope } from "./admission-model-scope";
import { handleChatCompletions } from "./chat-completions";
import type { GeminiMethod } from "./gemini-native-paths";
import {
  applyLocalRefusalCode,
  commitCancelled,
  drainedInnerErrorMessage,
  internalChatRequest,
  nativeRefusalParts,
  nativeRetryAfter,
  streamNativeFromChat,
  type NativeLogIds,
} from "./native-chat-bridge";
import { createNativeFinalLog, type NativeFinalLog } from "./native-final-log";
import { findOllamaRoute, listOllamaRoutes, preflightOllamaRoute } from "./ollama-route-policy";
import { DecompressedBodyTooLargeError, readJsonRequestBody, resolveInboundBodyLimitBytes } from "./request-decompress";
import { addFinalRequestLog, type RequestLogContext } from "./request-log";

const STATUS_NAMES: Readonly<Record<number, string>> = {
  400: "INVALID_ARGUMENT", 401: "UNAUTHENTICATED", 403: "PERMISSION_DENIED", 404: "NOT_FOUND", 413: "INVALID_ARGUMENT",
  429: "RESOURCE_EXHAUSTED", 499: "CANCELLED", 501: "UNIMPLEMENTED", 503: "UNAVAILABLE", 504: "DEADLINE_EXCEEDED",
};

export function geminiErrorBody(status: number, message: string): { error: { code: number; message: string; status: string } } {
  return { error: { code: status, message, status: STATUS_NAMES[status] ?? "INTERNAL" } };
}

/**
 * Every Gemini error response is built from scratch: content type, our own error text, and
 * optionally a reformatted Retry-After. Callers add CORS and the request-log id.
 */
export function geminiError(status: number, message: string, retryAfter?: string | null): Response {
  const headers = new Headers({ "content-type": "application/json" });
  const advice = nativeRetryAfter(retryAfter);
  if (advice !== undefined) headers.set("Retry-After", advice);
  return new Response(JSON.stringify(geminiErrorBody(status, message)), { status, headers });
}

/** Reshape an existing proxy refusal (capacity, workflow, drain) keeping its status and retry advice. */
export function toGeminiRefusal(response: Response): Response {
  const parts = nativeRefusalParts(response);
  return applyLocalRefusalCode(geminiError(parts.status, parts.message, parts.retryAfter), parts.localRefusalCode);
}

function eligibleRoutes(config: OcxConfig, req: Request, admission: DataPlaneAdmission) {
  const scope = resolveAdmissionModelScope(config, admission);
  return listOllamaRoutes(config, req)
    .filter(row => routeAllowedByScope(scope, { providerName: row.route.providerName, modelId: row.route.modelId }));
}

const modelResource = (selector: string) => ({
  name: `models/${selector}`,
  displayName: selector,
  supportedGenerationMethods: ["generateContent", "streamGenerateContent"],
});

export function handleGeminiModels(config: OcxConfig, req: Request, admission: DataPlaneAdmission): Response {
  return Response.json({ models: eligibleRoutes(config, req, admission).map(row => modelResource(row.selector)) });
}

export function handleGeminiModel(config: OcxConfig, req: Request, admission: DataPlaneAdmission, model: string): Response {
  const row = findOllamaRoute(config, model, req);
  const scope = resolveAdmissionModelScope(config, admission);
  if (!row || !routeAllowedByScope(scope, { providerName: row.route.providerName, modelId: row.route.modelId })) return geminiError(404, "model not found");
  return Response.json(modelResource(row.selector));
}

function failBeforeInner(ids: NativeLogIds, logCtx: RequestLogContext, status: number, message: string): Response {
  addFinalRequestLog(ids.requestId, ids.start, logCtx, status, { closeReason: "non_stream" });
  return geminiError(status, message);
}

function cancelledNonStream(finalLog: NativeFinalLog): Response {
  commitCancelled(finalLog);
  return geminiError(499, "request cancelled");
}

/** generateContent and streamGenerateContent. `req` is the admitted, session-promoted request. */
export async function handleGeminiGeneration(
  method: Extract<GeminiMethod, "generateContent" | "streamGenerateContent">,
  model: string,
  sse: boolean,
  req: Request,
  config: OcxConfig,
  logCtx: RequestLogContext,
  ids: NativeLogIds,
): Promise<Response> {
  const limit = resolveInboundBodyLimitBytes(config.maxInboundBodyBytes);
  const stream = method === "streamGenerateContent";
  const budget = createTranslatorBudget();
  let chat: Record<string, unknown>;
  try {
    chat = geminiToChat(model, await readJsonRequestBody(req, budget, limit), stream);
  } catch (error) {
    if (req.signal.aborted) return failBeforeInner(ids, logCtx, 499, "request cancelled");
    if (error instanceof DecompressedBodyTooLargeError) return failBeforeInner(ids, logCtx, 413, "request body too large");
    if (isTranslatorBudgetExceededError(error)) return failBeforeInner(ids, logCtx, 502, "request translation buffer exceeded the safe limit");
    return failBeforeInner(ids, logCtx, 400, error instanceof GeminiCodecError ? error.message : "invalid JSON body");
  } finally {
    budget.dispose();
  }
  logCtx.requestedModel = model;
  const preflight = preflightOllamaRoute(config, model, req);
  if (!preflight.ok) {
    logCtx.errorCode = preflight.error.code;
    return failBeforeInner(ids, logCtx, preflight.error.status, preflight.error.message);
  }
  const chatJson = JSON.stringify(chat);
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
  return stream
    ? streamGemini(model, sse, inner.body, finalLog, req.signal)
    : bufferedGemini(model, inner, finalLog, req.signal);
}

async function bufferedGemini(model: string, inner: Response, finalLog: NativeFinalLog, signal: AbortSignal): Promise<Response> {
  let native: Record<string, unknown>;
  try {
    native = chatToGeminiResponse(model, JSON.parse(await inner.text()));
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
  return Response.json(native);
}

const encoder = new TextEncoder();

/** How records become bytes: SSE data frames, or the elements of one JSON array. */
interface GeminiFraming {
  contentType: string;
  frames(records: unknown[]): Uint8Array[];
  end(records: unknown[]): Uint8Array[];
}

const sseFraming = (): GeminiFraming => {
  const frames = (records: unknown[]) => records.map(record => encoder.encode(`data: ${JSON.stringify(record)}\r\n\r\n`));
  return { contentType: "text/event-stream", frames, end: frames };
};

const arrayFraming = (): GeminiFraming => {
  let opened = false;
  const frames = (records: unknown[]) => records.map(record => {
    const prefix = opened ? ",\n" : "[\n";
    opened = true;
    return encoder.encode(prefix + JSON.stringify(record));
  });
  return { contentType: "application/json", frames, end: records => [...frames(records), encoder.encode("\n]")] };
};

function streamGemini(model: string, sse: boolean, body: ReadableStream<Uint8Array>, finalLog: NativeFinalLog, signal: AbortSignal): Response {
  const state = createGeminiStreamState(model);
  const framing = sse ? sseFraming() : arrayFraming();
  return streamNativeFromChat({
    contentType: framing.contentType,
    chunk: parsed => framing.frames(consumeGeminiChatChunk(state, parsed)),
    terminal() {
      const record = geminiStreamTerminal(state);
      return record ? { ok: true, frames: () => framing.end([record]) } : { ok: false, error: "request did not complete" };
    },
    failure: message => framing.end([geminiErrorBody(502, message)]),
  }, body, finalLog, signal);
}
