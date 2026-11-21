/**
 * Gemini-compatible inbound API: GET /v1beta/models[/{model}] and POST
 * /v1beta|v1/models/{model}:generateContent|streamGenerateContent (countTokens and the embed
 * methods answer 501).
 *
 * Like the Ollama inbound (./ollama-inbound), the catalog starts with configured
 * provider routes. Unless the native leg applies, generation is translated into an internal Chat Completions request handled by
 * the ordinary Chat path, and this handler owns the final request-log row. Errors use the Gemini
 * `{ error: { code, message, status } }` body with a fixed message chosen by HTTP status.
 */
import { GeminiCodecError, chatToGeminiResponse, consumeGeminiChatChunk, createGeminiStreamState, geminiStreamTerminal, geminiToChat } from "../protocols/codecs/gemini";
import { createTranslatorBudget, isTranslatorBudgetExceededError } from "../lib/translator-budget";
import type { OcxConfig, OcxParsedRequest } from "../types";
import type { RouteResult } from "../router";
import { configuredContextWindow, configuredMaxInputTokens } from "../codex/catalog/model-hints";
import { modelRecordValue } from "../reasoning-effort";
import { getModelMetadata, resolveMetadataProvider } from "../generated/model-metadata";
import { chatConversationToIr } from "../protocols/codecs/chat-ir";
import { ChatCompletionsRequestError } from "../chat/inbound";
import { estimateInputTokens } from "./responses/input-admission";
import type { DataPlaneAdmission } from "./auth-cors";
import { resolveAdmissionModelScope, routeAllowedByScope } from "./admission-model-scope";
import type { GeminiMethod } from "./gemini-native-paths";
import { geminiNativeCatalogAliases, geminiNativeCatalogLookup, geminiNativeDiscoveredRoutes } from "./gemini-native-catalog";
import {
  applyLocalRefusalCode,
  commitCancelled,
  drainedInnerErrorMessage,
  handleNativeChat,
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
  // google.rpc.Code by HTTP mapping; 402 has no canonical code, so the closest precondition.
  402: "FAILED_PRECONDITION", 405: "UNIMPLEMENTED", 408: "DEADLINE_EXCEEDED", 409: "ABORTED", 422: "INVALID_ARGUMENT",
  500: "INTERNAL", 502: "UNAVAILABLE",
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

function geminiCatalogRoutes(config: OcxConfig, req: Request) {
  const configured = listOllamaRoutes(config, req);
  const selectors = new Set(configured.map(row => row.selector));
  const discovered = geminiNativeDiscoveredRoutes(config, req).filter(row => !selectors.has(row.selector));
  return [...configured, ...discovered];
}

/** Token limits from configuration first, then generated model metadata; omitted when unknown. */
function tokenLimits(config: OcxConfig, route: RouteResult): { inputTokenLimit?: number; outputTokenLimit?: number } {
  const metadataProvider = resolveMetadataProvider(route.providerName) ?? route.providerName;
  const metadata = getModelMetadata(metadataProvider, route.modelId);
  const custom = config.customModels?.find(row => row.provider === route.providerName && row.modelId === route.modelId);
  const customContext = custom?.contextWindow;
  const input = configuredMaxInputTokens(route.provider, route.modelId)
    ?? configuredContextWindow(route.provider, route.modelId)
    ?? (typeof customContext === "number" && customContext > 0 ? customContext : metadata?.contextWindow);
  const output = modelRecordValue(route.provider.modelMaxOutputTokens, route.modelId) ?? route.provider.defaultMaxOutputTokens ?? metadata?.maxTokens;
  return {
    ...(typeof input === "number" && input > 0 ? { inputTokenLimit: input } : {}),
    ...(typeof output === "number" && output > 0 ? { outputTokenLimit: output } : {}),
  };
}

const modelResource = (config: OcxConfig, row: { selector: string; route: RouteResult }) => ({
  name: `models/${row.selector}`,
  displayName: row.selector,
  ...tokenLimits(config, row.route),
  supportedGenerationMethods: ["generateContent", "streamGenerateContent", "countTokens"],
});

export function handleGeminiModels(config: OcxConfig, req: Request, admission: DataPlaneAdmission): Response {
  const scope = resolveAdmissionModelScope(config, admission);
  const candidates = geminiCatalogRoutes(config, req);
  const rows = candidates.filter(row => routeAllowedByScope(scope, row.route));
  // A key can allow a concrete effort tier while excluding its source family.
  const aliases = geminiNativeCatalogAliases(config, req, candidates, scope);
  return Response.json({ models: [...rows, ...aliases].map(row => modelResource(config, row)) });
}

function findGeminiCatalogRow(config: OcxConfig, req: Request, admission: DataPlaneAdmission, model: string) {
  const row = findOllamaRoute(config, model, req) ?? geminiNativeDiscoveredRoutes(config, req, model)[0];
  const scope = resolveAdmissionModelScope(config, admission);
  if (row && routeAllowedByScope(scope, row.route)) return row;
  return geminiNativeCatalogLookup(config, req, model, () => geminiCatalogRoutes(config, req), scope);
}

export function handleGeminiModel(config: OcxConfig, req: Request, admission: DataPlaneAdmission, model: string): Response {
  const row = findGeminiCatalogRow(config, req, admission, model);
  return row ? Response.json(modelResource(config, row)) : geminiError(404, "model not found");
}

/**
 * `:countTokens`: a local estimate over the same Chat projection generation uses, for the routes the
 * key may reach. No upstream call. Body: `{contents, systemInstruction, tools}` or `{generateContentRequest}`.
 */
export async function handleGeminiCountTokens(config: OcxConfig, req: Request, admission: DataPlaneAdmission, model: string): Promise<Response> {
  const row = findGeminiCatalogRow(config, req, admission, model);
  if (!row) return geminiError(404, "model not found");
  const limit = resolveInboundBodyLimitBytes(config.maxInboundBodyBytes);
  const budget = createTranslatorBudget();
  try {
    const body = await readJsonRequestBody(req, budget, limit);
    const source = body && typeof body === "object" && !Array.isArray(body) && (body as Record<string, unknown>).generateContentRequest !== undefined
      ? (body as Record<string, unknown>).generateContentRequest
      : body;
    const chat = geminiToChat(row.route.modelId, source, false);
    const conversation = chatConversationToIr(chat, row.route.modelId);
    const totalTokens = estimateInputTokens({ ...conversation, modelId: row.route.modelId } as unknown as OcxParsedRequest, row.route.modelId, row.route.provider);
    return Response.json({ totalTokens });
  } catch (error) {
    if (req.signal.aborted) return geminiError(499, "request cancelled");
    if (error instanceof DecompressedBodyTooLargeError) return geminiError(413, "request body too large");
    if (isTranslatorBudgetExceededError(error)) return geminiError(502, "request translation buffer exceeded the safe limit");
    if (error instanceof GeminiCodecError || error instanceof ChatCompletionsRequestError) return geminiError(400, error.message);
    return geminiError(400, "invalid JSON body");
  } finally {
    budget.dispose();
  }
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
  let originalBody: unknown;
  let chat: Record<string, unknown>;
  try {
    originalBody = await readJsonRequestBody(req, budget, limit);
    chat = geminiToChat(model, originalBody, stream);
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
