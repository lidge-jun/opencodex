import { addFinalRequestLog, type RequestLogContext } from "./request-log";

/** Observe delivery lifetime without parsing, retaining or rewriting Gemini payloads. */
export function logGeminiNativeDelivery(response: Response, req: Request, requestId: string, start: number, context: RequestLogContext): Response {
  let settled = false;
  const finish = (status: number) => {
    if (settled) return;
    settled = true;
    req.signal.removeEventListener("abort", onAbort);
    addFinalRequestLog(requestId, start, context, status, {
      terminalStatus: status < 400 ? "completed" : "failed",
      closeReason: status === 499 ? "client_cancel" : "terminal",
    });
  };
  const onAbort = () => finish(499);
  req.signal.addEventListener("abort", onAbort, { once: true });
  if (req.signal.aborted) onAbort();
  if (!response.body) { finish(response.status); return response; }
  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) { finish(response.status); controller.close(); }
        else controller.enqueue(next.value);
      } catch (error) { finish(req.signal.aborted ? 499 : 502); controller.error(error); }
    },
    cancel(reason) { finish(499); return reader.cancel(reason); },
  });
  const headers = new Headers(response.headers);
  headers.set("x-opencodex-request-id", requestId);
  return new Response(body, { status: response.status, headers });
}
