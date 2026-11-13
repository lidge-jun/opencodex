import { comboFailureDecision } from "../combos";
import { isProviderModerationRefusal } from "../combos/failover";
import { attachComboFailureEvidence } from "../lib/client-error-body";
import { explicitErrorEventStatus } from "./responses/combo-stream-preflight";
import { httpStatusFromTerminalError } from "../lib/errors";
import { redactSecretString } from "../lib/redact";
import { sseFieldValue } from "../lib/sse-decoder";
import type { TranslatorBudget } from "../lib/translator-budget";
import { anthropicUsageToOcx } from "./messages-shared";
import type { RequestLogContext } from "./request-log";
import { BoundedSseFrameBuffer, MAX_CLIENT_SSE_FRAME_BYTES, SseFrameCountLimitError, SseFrameTooLargeError } from "./sse-frame-buffer";
import { UNDECLARED_TOOL_CALL_ERROR_CODE } from "./responses-undeclared-tool-guard";

type Rec = Record<string, unknown>;
const isRec = (value: unknown): value is Rec => value !== null && typeof value === "object" && !Array.isArray(value);

/** Capture replay evidence before any relay can split a physical upstream read into frames. */
export function observeNativeMessagesReplayBoundary(body: ReadableStream<Uint8Array>, logCtx: RequestLogContext, replay: { committed: boolean; pending: boolean }): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  const inspector = new BoundedSseFrameBuffer();
  const decoder = new TextDecoder();
  let active = true;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) { inspector.dispose(); controller.close(); return; }
        if (active) {
          let errorSeen = false;
          let finished = false;
          try {
            for (const frame of inspector.feed(next.value)) {
              if (frame.continuation) continue;
              const lines = decoder.decode(frame.block).split(/\r\n|\r|\n/);
              const event = lines.map(line => sseFieldValue(line, "event")).findLast(value => value !== null) ?? null;
              const dataFields = lines.map(line => sseFieldValue(line, "data")).filter(value => value !== null);
              const data = dataFields.join("\n");
              let payload: unknown;
              try { payload = JSON.parse(data); } catch { payload = undefined; }
              const type = isRec(payload) && (event === null || event === payload.type) ? payload.type : undefined;
              if (errorSeen && (event !== null || dataFields.length > 0) && type !== "ping") logCtx.streamErrorFollowed = true;
              if (type === "error" && isRec(payload) && isRec(payload.error)) errorSeen = true;
              else if ((event !== null || dataFields.length > 0) && type !== "ping" && !(type === "message_start" && isRec(payload) && isRec(payload.message) && Array.isArray(payload.message.content) && payload.message.content.length === 0)) {
                replay.committed = true; finished = true;
              }
            }
            replay.pending = inspector.pendingBytes > 0;
            // An unfinished event can still acquire a different name or payload on the next read.
            if (errorSeen && inspector.pendingBytes > 0) logCtx.streamErrorFollowed = true;
            if (errorSeen || finished) { active = false; inspector.dispose(); }
          } catch (error) {
            if (!(error instanceof SseFrameTooLargeError || error instanceof SseFrameCountLimitError)) throw error;
            logCtx.streamErrorFollowed = true;
            replay.committed = true;
            active = false; inspector.dispose();
          }
        }
        controller.enqueue(next.value);
      } catch (error) { inspector.dispose(); controller.error(error); }
    },
    cancel(reason) { inspector.dispose(); return reader.cancel(reason); },
  }, { highWaterMark: 0 });
}

/** Inspect only the bounded protocol prelude. Any block, unknown payload or cap commits. */
export async function preflightNativeMessagesResponse(
  response: Response, logCtx: RequestLogContext, budget: TranslatorBudget, replay?: { committed: boolean },
): Promise<{ kind: "accepted" | "failed"; response: Response }> {
  if (!response.ok || !response.body || !response.headers.get("content-type")?.toLowerCase().includes("text/event-stream")) {
    return { kind: "accepted", response };
  }
  let committed = false;
  let terminal = false;
  let failure: Rec | undefined;
  let failureStatus = 502;
  /** The whole error event, kept when a moderation verdict decided the hop. */
  let failureEvidence: string | undefined;
  let usage: Rec = {};
  const inspector = new BoundedSseFrameBuffer();
  const decoder = new TextDecoder();
  const inspectFrame = (block: Uint8Array) => {
      // A retryable failure keeps reading its chunk: later output in it still commits.
      if (committed || terminal) return;
      const lines = decoder.decode(block).split(/\r\n|\r|\n/);
      const event = lines.map(line => sseFieldValue(line, "event")).findLast(value => value !== null) ?? null;
      const data = lines.map(line => sseFieldValue(line, "data")).filter(value => value !== null).join("\n");
      // A named event without a payload is malformed and commits; a comment-only block is skipped.
      if (!data) { if (event !== null) committed = true; return; }
      let payload: unknown;
      try { payload = JSON.parse(data); } catch { committed = true; return; }
      // Match the native log tap: the last, untrimmed event field is authoritative. A payload
      // under another event name is unknown output, never a replayable refusal or prelude.
      if (!isRec(payload) || (event !== null && event !== payload.type)) { committed = true; return; }
      if (payload.type === "message_start" && isRec(payload.message)) {
        if (isRec(payload.message.usage)) usage = { ...usage, ...payload.message.usage };
        if (!Array.isArray(payload.message.content) || payload.message.content.length !== 0) committed = true;
      } else if (payload.type === "ping") {
        // Protocol liveness is not output.
      } else if (payload.type === "error" && isRec(payload.error)) {
        const error = payload.error;
        const wholeEvent = JSON.stringify(payload);
        // A status the event states for itself (any spelling the responses preflight reads) is
        // evidence of its own: a framed 429 or 503 is never read as a moderation refusal.
        const framed = explicitErrorEventStatus(payload);
        const framedAllowsModeration = framed === undefined || framed === 400 || framed === 422;
        // Otherwise a structured moderation verdict on the whole event is a request-level refusal,
        // whatever status the terminal mapping infers for its code; judge it like the HTTP reader.
        const moderation = framedAllowsModeration && isProviderModerationRefusal(400, wholeEvent, undefined, true);
        const mapped = httpStatusFromTerminalError({ type: typeof error.type === "string" ? error.type : undefined,
          code: typeof error.code === "string" ? error.code : undefined,
          message: typeof error.message === "string" ? error.message : undefined }) ?? 502;
        const status = moderation && mapped !== 400 && mapped !== 422 ? 400 : mapped;
        if (logCtx.terminalSource !== "synthetic" && logCtx.errorCode !== UNDECLARED_TOOL_CALL_ERROR_CODE
          && comboFailureDecision(status, typeof error.message === "string" ? error.message : "", {
          code: typeof error.code === "string" ? error.code : undefined,
          rootCode: typeof payload.code === "string" ? payload.code : undefined,
          // The whole event, as the HTTP and stream readers judge it, so transports cannot disagree.
          providerModerationRefusal: status === 400 || status === 422
            ? framedAllowsModeration && isProviderModerationRefusal(status, wholeEvent, undefined, true) : undefined,
        }) === "hop") {
          failure = error; failureStatus = status;
          failureEvidence = moderation && (status === 400 || status === 422) ? wholeEvent : undefined;
        }
        else committed = true;
      } else if (payload.type === "message_stop") terminal = true;
      else committed = true;
  };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let retained = 0;
  const release = () => { budget.releaseRetained(retained, { kind: "retained_collectors" }); retained = 0; };
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) { terminal = true; break; }
      // The one upstream chunk already exists; retain it without a copy if the cap commits.
      if (retained + next.value.byteLength > MAX_CLIENT_SSE_FRAME_BYTES || chunks.length >= 1024) {
        chunks.push(next.value); committed = true; break;
      }
      // Classify before retaining: a chunk that commits is held like the cap's, so a budget
      // refusal can only meet a prelude that is still safe to replay.
      try {
        for (const frame of inspector.feed(next.value)) if (!frame.continuation) inspectFrame(frame.block);
      } catch (error) {
        if (!(error instanceof SseFrameTooLargeError || error instanceof SseFrameCountLimitError)) throw error;
        committed = true;
      }
      if (!committed) {
        budget.chargeRetained(next.value.byteLength, { kind: "retained_collectors" });
        retained += next.value.byteLength;
      }
      chunks.push(next.value);
      if (committed || terminal || failure) break;
    }
    // The tap read the original upstream chunk; output after the error there commits too.
    if (failure && !committed && !replay?.committed && !logCtx.streamErrorFollowed) {
      logCtx.usage = anthropicUsageToOcx(usage);
      const message = redactSecretString(typeof failure.message === "string" ? failure.message : "Provider stream failed before output");
      logCtx.upstreamError = `Provider stream failed (${failureStatus})`;
      void reader.cancel("retrying native Messages pre-output refusal").catch(() => {});
      release();
      const headers = new Headers(response.headers);
      headers.set("content-type", "application/json"); headers.delete("content-length"); headers.delete("content-encoding");
      const failed = Response.json({ error: {
        ...(typeof failure.type === "string" ? { type: failure.type } : {}),
        ...(typeof failure.code === "string" ? { code: failure.code } : {}),
        message,
      } }, { status: failureStatus, headers });
      // The rebuilt envelope drops the evidence (root code, innererror) the verdict was judged on.
      return { kind: "failed", response: failureEvidence === undefined ? failed : attachComboFailureEvidence(failed, failureEvidence) };
    }
    let index = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          if (index < chunks.length) { controller.enqueue(chunks[index++]!); return; }
          chunks.length = 0;
          release();
          const next = await reader.read();
          if (next.done) controller.close(); else controller.enqueue(next.value);
        } catch (error) { release(); controller.error(error); }
      },
      cancel(reason) { release(); void reader.cancel(reason).catch(() => {}); },
    }, { highWaterMark: 0 });
    return { kind: "accepted", response: new Response(body, { status: response.status, headers: response.headers }) };
  } catch (error) {
    release(); void reader.cancel(error).catch(() => {}); throw error;
  } finally { inspector.dispose(); }
}
