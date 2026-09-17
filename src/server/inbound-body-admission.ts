import {
  MAX_CONFIGURABLE_INBOUND_BODY_BYTES,
  MAX_DECOMPRESSED_BODY_BYTES,
  resolveInboundBodyLimitBytes,
} from "./request-decompress";
import { withCors, type RequestPolicyView } from "./auth-cors";
import { codexCompatibleUrl } from "../codex/context-compat";
import { addFinalRequestLog, markLocalRequestLogRefusal } from "./request-log";
import type { WorkflowRefusalLog } from "./workflow-refusal";

/** Admission units, not a bound on process RSS or the size of parsed object graphs. */
export const MAX_CONCURRENT_INBOUND_BODY_BYTES = MAX_CONFIGURABLE_INBOUND_BODY_BYTES;
let reservedInboundBodyBytes = 0;

// Match the HTTP routes whose JSON readers use maxInboundBodyBytes. Keep the
// current image/search/count_tokens support; management, audio, context relay,
// and WebSocket frames have separate limits and are not part of this gate.
// Exported so the contract tests classify the dispatcher's own route list
// instead of copying it: a new loopback route has to land in one of these two
// sets, or `tests/server/server-request-body-size.test.ts` fails.
export const CONFIGURABLE_JSON_BODY_ROUTES: ReadonlySet<string> = new Set([
  "/v1/responses",
  "/v1/responses/compact",
  "/v1/chat/completions",
  "/v1/messages",
  "/v1/messages/count_tokens",
  "/v1/images/generations",
  "/v1/images/edits",
  "/v1/alpha/search",
]);

/**
 * Loopback routes deliberately outside this gate. Audio uploads, realtime/live
 * control and the model list do not read JSON under `maxInboundBodyBytes`, so
 * reserving that allowance for them would refuse traffic the limit never covered.
 */
export const UNGATED_LOOPBACK_ROUTES: ReadonlySet<string> = new Set([
  "/v1/audio/transcriptions",
  "/v1/audio/transcriptions/stream",
  "/v1/models",
  "/v1/realtime",
  "/v1/realtime/calls",
  "/v1/live",
]);

export class InboundBodyCapacityError extends Error {
  constructor() {
    super("OpenCodex inbound request body capacity is temporarily exhausted. Retry after the current request completes.");
    this.name = "InboundBodyCapacityError";
  }
}

function cancelUnreadBody(req: Request, reason: unknown): void {
  if (!req.body || req.body.locked) return;
  try {
    // A tee's cancellation can wait for the other branch. Refusal must not wait
    // for a peer that has not finished uploading, or for an unconsumed clone.
    void req.body.cancel(reason).catch(() => undefined);
  } catch { /* Non-standard streams may throw synchronously. */ }
}

function capacityResponse(pathname: string, error: InboundBodyCapacityError): Response {
  const anthropic = pathname === "/v1/messages" || pathname === "/v1/messages/count_tokens";
  return Response.json({
    ...(anthropic ? { type: "error" } : {}),
    error: {
      type: anthropic ? "overloaded_error" : "server_error",
      code: "server_busy",
      message: error.message,
    },
  }, { status: 503, headers: { "Retry-After": "1" } });
}

function retainUntilResponseSettles(response: Response, release: () => void): Response {
  if (!response.body) {
    release();
    return response;
  }
  const reader = response.body.getReader();
  let cancelling = false;
  let finalized = false;
  const finalize = (): void => {
    if (finalized) return;
    finalized = true;
    try { reader.releaseLock(); } finally { release(); }
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read();
        // cancel() can resolve a pending read as EOF before the producer's
        // asynchronous cancellation completes. Only cancel owns release then.
        if (cancelling) return;
        if (result.done) {
          finalize();
          controller.close();
        } else {
          controller.enqueue(result.value);
        }
      } catch (error) {
        if (cancelling) return;
        finalize();
        controller.error(error);
      }
    },
    async cancel(reason) {
      cancelling = true;
      try { await reader.cancel(reason); } finally { finalize(); }
    },
  }, { highWaterMark: 0 });
  // This is the outermost HTTP wrapper, after protocol conversion, relay
  // preflight and request logging; no internal relay marker is consumed later.
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/**
 * Own one raised-limit HTTP request from before body reading through response
 * EOF/error or settled cancellation. Call only at the admitted HTTP boundary,
 * after auth/origin checks, not from readers or internal combo/translation hops.
 * pathname is the same canonical pathname used by the server's dispatcher.
 */
export async function withRaisedInboundBodyAdmission(
  req: Request,
  pathname: string,
  configuredLimit: number | undefined,
  work: () => Promise<Response>,
  onRefusal: (response: Response) => Response = response => response,
): Promise<Response> {
  const maxBytes = resolveInboundBodyLimitBytes(configuredLimit);
  if (req.method !== "POST" || !CONFIGURABLE_JSON_BODY_ROUTES.has(pathname)
    || maxBytes <= MAX_DECOMPRESSED_BODY_BYTES || req.signal.aborted) {
    return work();
  }
  const declared = req.headers.get("content-length");
  const declaredBytes = declared === null || declared.trim() === "" ? NaN : Number(declared);
  if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
    // The existing bounded reader rejects this before allocating. Let its
    // protocol-specific 413 win over temporary capacity refusal, unchanged.
    return work();
  }
  if (maxBytes > MAX_CONCURRENT_INBOUND_BODY_BYTES - reservedInboundBodyBytes) {
    const error = new InboundBodyCapacityError();
    cancelUnreadBody(req, error);
    return onRefusal(capacityResponse(pathname, error));
  }
  reservedInboundBodyBytes += maxBytes;
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    reservedInboundBodyBytes -= maxBytes;
  };
  try {
    return retainUntilResponseSettles(await work(), release);
  } catch (error) {
    release();
    throw error;
  }
}

/**
 * The admitted HTTP call site. Refusal is recorded as a local terminal and
 * carries the receiving listener's CORS headers, so a browser dashboard can
 * read it. No request content is read or logged on this path.
 */
export function runAdmittedBodyWork(
  req: Request,
  policy: RequestPolicyView,
  configuredLimit: number | undefined,
  work: () => Promise<Response>,
  refusalLog?: WorkflowRefusalLog,
): Promise<Response> {
  return withRaisedInboundBodyAdmission(req, codexCompatibleUrl(req.url).pathname, configuredLimit, work, refused => {
    if (refusalLog) {
      markLocalRequestLogRefusal(refusalLog.logCtx, "server_busy");
      refusalLog.logCtx.errorCode = "server_busy";
      addFinalRequestLog(refusalLog.requestId, refusalLog.start, refusalLog.logCtx, refused.status, {
        closeReason: "terminal",
      });
    }
    return withCors(refused, req, policy);
  });
}
