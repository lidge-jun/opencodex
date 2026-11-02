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
import { parseRetryAfterMs } from "../combos";
import { WORKFLOW_LOCAL_REFUSAL_HEADER } from "../lib/workflow-budget";
import type { OcxConfig } from "../types";
import type { DataPlaneAdmission } from "./auth-cors";
import type { CapturedAdmissionPolicy } from "../types/admission-policy";
import type { AdmissionLease } from "../lib/admission";
import { resolveAdmissionModelScope, routeAllowedByScope } from "./admission-model-scope";
import { handleChatCompletions } from "./chat-completions";
import { VERSION } from "./management-api";
import { createNativeFinalLog, type NativeFinalLog } from "./native-final-log";
import { findOllamaRoute, linkRequestSessionLane, listOllamaRoutes, preflightOllamaRoute } from "./ollama-route-policy";
import { DecompressedBodyTooLargeError, readJsonRequestBody, resolveInboundBodyLimitBytes } from "./request-decompress";
import { addFinalRequestLog, type RequestLogContext } from "./request-log";

const SHOW_BODY_LIMIT_BYTES = 64 * 1024;
// Session and workflow identity only: lineage, session lanes and the workflow root's spend
// ceiling read these from the request Chat sees. Never authorization, cookies or admission keys.
const IDENTITY_HEADERS = ["session_id", "session-id", "thread-id", "x-session-id", "x-codex-parent-thread-id"] as const;

/** Upper bound for the retry advice this surface passes on. */
export const OLLAMA_MAX_RETRY_AFTER_SECONDS = 3600;

/**
 * Retry-After as an integer we format ourselves. The incoming value may come from an upstream,
 * so only the parsed delay crosses this boundary, never its bytes; unparseable values are dropped.
 */
export function ollamaRetryAfter(value: string | null | undefined, now = Date.now()): string | undefined {
  if (value?.trim() === "0") return "0";
  const ms = parseRetryAfterMs(value, now);
  if (ms === undefined) return undefined;
  return String(Math.min(OLLAMA_MAX_RETRY_AFTER_SECONDS, Math.max(0, Math.ceil(ms / 1000))));
}

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

/**
 * The local refusal codes this surface passes on, each mapped to a constant defined here. The
 * emitted header value is always the constant; an incoming value only selects it, and any value
 * not in this table is dropped.
 */
const LOCAL_REFUSAL_CODES: ReadonlyMap<string, string> = new Map([
  ["workflow_sends_exhausted", "workflow_sends_exhausted"],
  ["workflow_children_exhausted", "workflow_children_exhausted"],
  ["workflow_concurrency_exhausted", "workflow_concurrency_exhausted"],
  ["workflow_spend_exhausted", "workflow_spend_exhausted"],
  ["workflow_tracking_exhausted", "workflow_tracking_exhausted"],
  ["workflow_send_replayed", "workflow_send_replayed"],
  ["workflow_pool_history_unresolved", "workflow_pool_history_unresolved"],
  ["workflow_spend_undurable", "workflow_spend_undurable"],
]);

/** Reshape an existing proxy refusal (capacity, workflow, drain) keeping its status and retry advice. */
export function toOllamaRefusal(response: Response): Response {
  try { void response.body?.cancel().catch(() => {}); } catch { /* already consumed */ }
  const message = response.status === 429 ? "request budget exhausted; retry later"
    : response.status === 499 ? "request cancelled"
      : response.status === 503 ? "server temporarily unavailable; retry later" : "request refused";
  const native = ollamaError(response.status, message, response.headers.get("retry-after"));
  // The workflow refusal names its local reason; only a recognized code selects our constant.
  const code = LOCAL_REFUSAL_CODES.get(response.headers.get(WORKFLOW_LOCAL_REFUSAL_HEADER) ?? "");
  if (code !== undefined) {
    native.headers.set(WORKFLOW_LOCAL_REFUSAL_HEADER, code);
    native.headers.set("Access-Control-Expose-Headers", WORKFLOW_LOCAL_REFUSAL_HEADER);
  }
  return native;
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

export interface OllamaLogIds {
  requestId: string;
  start: number;
  turnAdmissionLease?: AdmissionLease;
  admission?: DataPlaneAdmission;
  advisorAdmissionPolicy?: CapturedAdmissionPolicy;
}

function failBeforeInner(ids: OllamaLogIds, logCtx: RequestLogContext, status: number, message: string): Response {
  addFinalRequestLog(ids.requestId, ids.start, logCtx, status, { closeReason: "non_stream" });
  return ollamaError(status, message);
}

function internalChatRequest(req: Request, chatJson: string): Request {
  const headers = new Headers({ "content-type": "application/json" });
  for (const name of IDENTITY_HEADERS) {
    const value = req.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  const internal = new Request(new URL("/v1/chat/completions", req.url), { method: "POST", headers, body: chatJson, signal: req.signal });
  linkRequestSessionLane(req, internal);
  return internal;
}

/**
 * Native error text is chosen by status only. The inner body can carry upstream-authored text,
 * which may echo a credential no pattern recognizes, so it is drained and never forwarded.
 */
const INNER_ERROR_MESSAGES: Readonly<Record<number, string>> = {
  400: "request rejected",
  401: "upstream authentication failed",
  402: "upstream payment required",
  403: "request not permitted",
  404: "model not found",
  408: "upstream request timed out",
  409: "request conflict",
  413: "request too large",
  422: "request rejected",
  429: "rate limited; retry later",
  499: "request cancelled",
  500: "upstream request failed",
  502: "upstream request failed",
  503: "upstream unavailable; retry later",
  504: "upstream request timed out",
};

export function ollamaInnerErrorMessage(status: number): string {
  return INNER_ERROR_MESSAGES[status] ?? (status >= 500 ? "upstream request failed" : "request failed");
}

async function innerErrorMessage(response: Response): Promise<string> {
  await response.body?.cancel().catch(() => {});
  return ollamaInnerErrorMessage(response.ok ? 502 : response.status);
}

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
    const message = await innerErrorMessage(inner);
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
  finalLog.commit({ status: 499, closeReason: "client_cancel" });
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
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const state = createOllamaStreamState(kind, model, createdAt);
  let pending = "";
  // ended: no further reads or records. cancelled: the client went away, possibly while end() waits.
  let ended = false;
  let cancelled = false;
  // The inner Chat path can finalize on EOF after [DONE], so keep draining to EOF before ending.
  let sawDone = false;
  const cancelInner = () => { try { void reader.cancel().catch(() => {}); } catch { /* released */ } };
  const commitCancelled = () => finalLog.commit({ status: 499, closeReason: "client_cancel" });
  const end = async (controller: ReadableStreamDefaultController<Uint8Array>, failure?: string) => {
    if (ended) return;
    ended = true;
    if (failure !== undefined) cancelInner();
    const terminal = failure === undefined ? ollamaStreamTerminal(state) : undefined;
    const settled = await finalLog.waitForInner();
    if (cancelled || signal.aborted) {
      commitCancelled();
      try { controller.close(); } catch { /* already cancelled by the client */ }
      return;
    }
    try {
      if (terminal?.done === true && settled) {
        controller.enqueue(line(terminal));
        finalLog.commit({ status: 200, terminalStatus: "completed", closeReason: "terminal" });
      } else {
        controller.enqueue(line({ error: failure ?? (typeof terminal?.error === "string" ? terminal.error : "request did not complete") }));
        finalLog.commit({ status: 502, terminalStatus: "failed", closeReason: "terminal" });
      }
      controller.close();
    } catch {
      // The client cancelled between settlement and the terminal record; the row still lands once.
      commitCancelled();
    }
  };
  // Returns how many native records were enqueued. Finish and usage frames enqueue nothing.
  const consume = (controller: ReadableStreamDefaultController<Uint8Array>, block: string): number => {
    let emitted = 0;
    for (const raw of block.split("\n")) {
      const text = raw.trimEnd();
      if (!text.startsWith("data:")) continue;
      // Chat ends at [DONE]; any later data (an error frame, say) means the stream did not settle cleanly.
      if (sawDone) throw new Error("data after the Chat stream terminator");
      const payload = text.slice(5).trim();
      if (payload === "[DONE]") { sawDone = true; continue; }
      for (const record of consumeOllamaChatChunk(state, JSON.parse(payload))) { controller.enqueue(line(record)); emitted++; }
    }
    return emitted;
  };
  return new Response(new ReadableStream<Uint8Array>({
    // A pull that resolves without enqueueing is not called again, so keep reading until this
    // pull has produced a record or ended the stream.
    async pull(controller) {
      try {
        while (!ended) {
          const { done, value } = await reader.read();
          if (done) {
            pending += decoder.decode();
            if (pending) consume(controller, pending);
            pending = "";
            await end(controller);
            return;
          }
          pending += decoder.decode(value, { stream: true });
          const boundary = pending.lastIndexOf("\n");
          if (boundary < 0) continue;
          const complete = pending.slice(0, boundary);
          pending = pending.slice(boundary + 1);
          if (consume(controller, complete) > 0) return;
        }
      } catch {
        await end(controller, signal.aborted ? "request cancelled" : "upstream stream failed");
      }
    },
    async cancel() {
      cancelled = true;
      // When end() is already waiting for settlement it sees the flag and writes the 499 row.
      if (ended) return;
      ended = true;
      cancelInner();
      await finalLog.waitForInner();
      commitCancelled();
    },
  }, { highWaterMark: 0 }), { status: 200, headers: { "content-type": "application/x-ndjson" } });
}
