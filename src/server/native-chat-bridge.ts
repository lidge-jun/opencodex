/**
 * Shared plumbing for native ingresses that translate onto the internal Chat Completions path
 * (the Ollama-compatible and Gemini-compatible routes). It holds what is identical across them:
 * the identity-only internal request, Retry-After and refusal vocabulary, fixed error text by
 * status, and the SSE-to-native stream pump with its settlement and cancellation rules. The
 * protocol-specific parts (frame shapes, error bodies) stay in each ingress.
 */
import { parseRetryAfterMs } from "../combos";
import type { AdmissionLease } from "../lib/admission";
import { WORKFLOW_LOCAL_REFUSAL_HEADER } from "../lib/workflow-budget";
import type { CapturedAdmissionPolicy } from "../types/admission-policy";
import type { DataPlaneAdmission } from "./auth-cors";
import type { NativeFinalLog } from "./native-final-log";
import { linkRequestSessionLane } from "./request-log-conversation";

// Session and workflow identity only: lineage, session lanes and the workflow root's spend
// ceiling read these from the request Chat sees. Never authorization, cookies or admission keys.
const IDENTITY_HEADERS = ["session_id", "session-id", "thread-id", "x-session-id", "x-codex-parent-thread-id"] as const;

/** The synthesized Chat request: JSON content type, identity headers, the client signal and its session lane. */
export function internalChatRequest(req: Request, chatJson: string): Request {
  const headers = new Headers({ "content-type": "application/json" });
  for (const name of IDENTITY_HEADERS) {
    const value = req.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  const internal = new Request(new URL("/v1/chat/completions", req.url), { method: "POST", headers, body: chatJson, signal: req.signal });
  linkRequestSessionLane(req, internal);
  return internal;
}

/** The request-log and admission identity a native handler passes to the inner Chat path. */
export interface NativeLogIds {
  requestId: string;
  start: number;
  turnAdmissionLease?: AdmissionLease;
  admission?: DataPlaneAdmission;
  advisorAdmissionPolicy?: CapturedAdmissionPolicy;
}

/** Upper bound for the retry advice a native surface passes on. */
export const NATIVE_MAX_RETRY_AFTER_SECONDS = 3600;

/**
 * Retry-After as an integer we format ourselves. The incoming value may come from an upstream,
 * so only the parsed delay crosses this boundary, never its bytes; unparseable values are dropped.
 */
export function nativeRetryAfter(value: string | null | undefined, now = Date.now()): string | undefined {
  if (value?.trim() === "0") return "0";
  const ms = parseRetryAfterMs(value, now);
  if (ms === undefined) return undefined;
  return String(Math.min(NATIVE_MAX_RETRY_AFTER_SECONDS, Math.max(0, Math.ceil(ms / 1000))));
}

/**
 * The local refusal codes native surfaces pass on, each mapped to a constant defined here. The
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

export interface NativeRefusalParts {
  status: number;
  message: string;
  retryAfter: string | null;
  /** A constant from the known workflow refusal codes, never the incoming header value. */
  localRefusalCode?: string;
}

/** Reduce an existing proxy refusal (capacity, workflow, drain) to its status, fixed text and retry advice. */
export function nativeRefusalParts(response: Response): NativeRefusalParts {
  try { void response.body?.cancel().catch(() => {}); } catch { /* already consumed */ }
  const message = response.status === 429 ? "request budget exhausted; retry later"
    : response.status === 499 ? "request cancelled"
      : response.status === 503 ? "server temporarily unavailable; retry later" : "request refused";
  const code = LOCAL_REFUSAL_CODES.get(response.headers.get(WORKFLOW_LOCAL_REFUSAL_HEADER) ?? "");
  return { status: response.status, message, retryAfter: response.headers.get("retry-after"), ...(code !== undefined ? { localRefusalCode: code } : {}) };
}

/** Put the workflow refusal constant on a native refusal and expose it to browsers. */
export function applyLocalRefusalCode(native: Response, code: string | undefined): Response {
  if (code === undefined) return native;
  native.headers.set(WORKFLOW_LOCAL_REFUSAL_HEADER, code);
  native.headers.set("Access-Control-Expose-Headers", WORKFLOW_LOCAL_REFUSAL_HEADER);
  return native;
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

export function nativeInnerErrorMessage(status: number): string {
  return INNER_ERROR_MESSAGES[status] ?? (status >= 500 ? "upstream request failed" : "request failed");
}

export async function drainedInnerErrorMessage(response: Response): Promise<string> {
  await response.body?.cancel().catch(() => {});
  return nativeInnerErrorMessage(response.ok ? 502 : response.status);
}

/** A client that left before the outer outcome was committed owns a 499 row, whatever the inner path reported. */
export function commitCancelled(finalLog: NativeFinalLog): void {
  finalLog.commit({ status: 499, closeReason: "client_cancel" });
}

export type NativeStreamTerminal = { ok: true; frames(): Uint8Array[] } | { ok: false; error: string };

/** The protocol-specific half of a native stream: how Chat chunks become frames. */
export interface NativeStreamTranslator {
  contentType: string;
  /** One parsed Chat chunk to zero or more encoded frames. Throwing marks the stream failed. */
  chunk(parsed: unknown): Uint8Array[];
  /** Evaluated once at end of stream, before settlement is known; frames are produced only on success. */
  terminal(): NativeStreamTerminal;
  /** Encoded frames that end a stream that failed or did not settle. */
  failure(message: string): Uint8Array[];
}

/**
 * Pump an inner Chat SSE body through a translator. A stream's terminal frames are emitted only
 * after the Chat stream reached EOF and the inner path settled, so trailing usage is included and
 * a later error never follows a success terminal. The row is committed exactly once through
 * the final log; a client that cancels, even while settlement is pending, owns a 499 row.
 */
export function streamNativeFromChat(translator: NativeStreamTranslator, body: ReadableStream<Uint8Array>, finalLog: NativeFinalLog, signal: AbortSignal): Response {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  // ended: no further reads or frames. cancelled: the client went away, possibly while end() waits.
  let ended = false;
  let cancelled = false;
  // The inner Chat path can finalize on EOF after [DONE], so keep draining to EOF before ending.
  let sawDone = false;
  const cancelInner = () => { try { void reader.cancel().catch(() => {}); } catch { /* released */ } };
  const end = async (controller: ReadableStreamDefaultController<Uint8Array>, failure?: string) => {
    if (ended) return;
    ended = true;
    if (failure !== undefined) cancelInner();
    const terminal = failure === undefined ? translator.terminal() : undefined;
    const settled = await finalLog.waitForInner();
    if (cancelled || signal.aborted) {
      commitCancelled(finalLog);
      try { controller.close(); } catch { /* already cancelled by the client */ }
      return;
    }
    try {
      if (terminal?.ok === true && settled) {
        for (const frame of terminal.frames()) controller.enqueue(frame);
        finalLog.commit({ status: 200, terminalStatus: "completed", closeReason: "terminal" });
      } else {
        const message = failure ?? (terminal?.ok === false ? terminal.error : "request did not complete");
        for (const frame of translator.failure(message)) controller.enqueue(frame);
        finalLog.commit({ status: 502, terminalStatus: "failed", closeReason: "terminal" });
      }
      controller.close();
    } catch {
      // The client cancelled between settlement and the terminal frames; the row still lands once.
      commitCancelled(finalLog);
    }
  };
  // Returns how many frames were enqueued. Finish and usage chunks may enqueue nothing.
  const consume = (controller: ReadableStreamDefaultController<Uint8Array>, block: string): number => {
    let emitted = 0;
    for (const raw of block.split("\n")) {
      const text = raw.trimEnd();
      if (!text.startsWith("data:")) continue;
      // Chat ends at [DONE]; any later data (an error frame, say) means the stream did not settle cleanly.
      if (sawDone) throw new Error("data after the Chat stream terminator");
      const payload = text.slice(5).trim();
      if (payload === "[DONE]") { sawDone = true; continue; }
      for (const frame of translator.chunk(JSON.parse(payload))) { controller.enqueue(frame); emitted++; }
    }
    return emitted;
  };
  return new Response(new ReadableStream<Uint8Array>({
    // A pull that resolves without enqueueing is not called again, so keep reading until this
    // pull has produced a frame or ended the stream.
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
      commitCancelled(finalLog);
    },
  }, { highWaterMark: 0 }), { status: 200, headers: { "content-type": translator.contentType } });
}
