import { comboFailureDecision } from "../combos";
import { httpStatusFromTerminalError } from "../lib/errors";
import { redactSecretString } from "../lib/redact";
import type { TranslatorBudget } from "../lib/translator-budget";
import { createSseInspector } from "./relay";
import { anthropicUsageToOcx } from "./messages-shared";
import type { RequestLogContext } from "./request-log";
import { MAX_CLIENT_SSE_FRAME_BYTES } from "./sse-frame-buffer";
import { UNDECLARED_TOOL_CALL_ERROR_CODE } from "./responses-undeclared-tool-guard";

type Rec = Record<string, unknown>;
const isRec = (value: unknown): value is Rec => value !== null && typeof value === "object" && !Array.isArray(value);

/** Inspect only the bounded protocol prelude. Any block, unknown payload or cap commits. */
export async function preflightNativeMessagesResponse(
  response: Response, logCtx: RequestLogContext, budget: TranslatorBudget,
): Promise<{ kind: "accepted" | "failed"; response: Response }> {
  if (!response.ok || !response.body || !response.headers.get("content-type")?.includes("text/event-stream")) {
    return { kind: "accepted", response };
  }
  let committed = false;
  let terminal = false;
  let failure: Rec | undefined;
  let failureStatus = 502;
  let usage: Rec = {};
  const inspector = createSseInspector({
    onOpaquePayload: () => { if (!failure) committed = true; },
    onParsedPayload: payload => {
      if (committed || terminal || failure) return;
      if (!isRec(payload)) { committed = true; return; }
      if (payload.type === "message_start" && isRec(payload.message)) {
        if (isRec(payload.message.usage)) usage = { ...usage, ...payload.message.usage };
        if (!Array.isArray(payload.message.content) || payload.message.content.length !== 0) committed = true;
      } else if (payload.type === "ping") {
        // Protocol liveness is not output.
      } else if (payload.type === "error" && isRec(payload.error)) {
        const error = payload.error;
        const status = httpStatusFromTerminalError({ type: typeof error.type === "string" ? error.type : undefined,
          code: typeof error.code === "string" ? error.code : undefined,
          message: typeof error.message === "string" ? error.message : undefined }) ?? 502;
        if (logCtx.terminalSource !== "synthetic" && logCtx.errorCode !== UNDECLARED_TOOL_CALL_ERROR_CODE
          && comboFailureDecision(status, typeof error.message === "string" ? error.message : "", {
          code: typeof error.code === "string" ? error.code : undefined,
        }) === "hop") { failure = error; failureStatus = status; }
        else committed = true;
      } else if (payload.type === "message_stop") terminal = true;
      else committed = true;
    },
  });
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
      budget.chargeRetained(next.value.byteLength, { kind: "retained_collectors" });
      retained += next.value.byteLength;
      chunks.push(next.value);
      inspector.feed(next.value);
      if (committed || terminal || failure) break;
    }
    if (failure && !committed) {
      logCtx.usage = anthropicUsageToOcx(usage);
      logCtx.upstreamError = redactSecretString(typeof failure.message === "string" ? failure.message : "Provider stream failed before output");
      void reader.cancel("retrying native Messages pre-output refusal").catch(() => {});
      release();
      const headers = new Headers(response.headers);
      headers.set("content-type", "application/json"); headers.delete("content-length"); headers.delete("content-encoding");
      return { kind: "failed", response: Response.json({ error: {
        ...(typeof failure.type === "string" ? { type: failure.type } : {}),
        ...(typeof failure.code === "string" ? { code: failure.code } : {}),
        message: logCtx.upstreamError,
      } }, { status: failureStatus, headers }) };
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
