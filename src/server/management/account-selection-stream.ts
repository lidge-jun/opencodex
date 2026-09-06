import { currentAccountSelectionRevision, subscribeAccountSelections } from "../../lib/account-selection-events";
import { registerOptionalShutdownHook } from "../../lib/optional-shutdown-hooks";

const MAX_SELECTION_STREAMS = 64;
const HEARTBEAT_MS = 15_000;
const encoder = new TextEncoder();
const connections = new Set<() => void>();

/** The management boundary admits the request; every frame revalidates current authority. */
export function accountSelectionStream(request: Request, validate: () => boolean): Response {
  const authorized = () => {
    try { return validate() === true; } catch { return false; }
  };
  if (!authorized()) return Response.json({ error: "Management session is no longer authorized" }, { status: 401 });
  if (connections.size >= MAX_SELECTION_STREAMS) {
    return Response.json({ error: "Too many account selection streams" }, {
      status: 429, headers: { "Retry-After": "15" },
    });
  }
  let cleanup = () => {};
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let unsubscribe = () => {};
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      const close = () => {
        if (closed) return;
        closed = true;
        unsubscribe();
        if (heartbeat) clearInterval(heartbeat);
        request.signal.removeEventListener("abort", close);
        connections.delete(close);
        try { controller.close(); } catch { /* The consumer may already have cancelled. */ }
      };
      cleanup = close;
      const send = (frame: string) => {
        if (closed) return;
        if (!authorized()) {
          // Error clears queued frames as well, so a revoked consumer cannot drain them.
          try { controller.error(new DOMException("Management session is no longer authorized", "NotAllowedError")); }
          finally { close(); }
          return;
        }
        // Reconnection sends a ready event, so a slow reader can reconcile without an
        // unbounded queue or silently dropping a provider's latest invalidation.
        if (controller.desiredSize !== null && controller.desiredSize <= 0) { close(); return; }
        try { controller.enqueue(encoder.encode(frame)); } catch { close(); }
      };
      connections.add(close);
      registerOptionalShutdownHook("account-selection-streams", () => {
        for (const finish of [...connections]) finish();
      });
      if (request.signal.aborted) { close(); return; }
      request.signal.addEventListener("abort", close, { once: true });
      unsubscribe = subscribeAccountSelections(event => {
        send(`event: account-selection\ndata: ${JSON.stringify(event)}\n\n`);
      });
      send(`event: ready\ndata: ${JSON.stringify({ revision: currentAccountSelectionRevision() })}\n\n`);
      if (closed) return;
      heartbeat = setInterval(() => send(": heartbeat\n\n"), HEARTBEAT_MS);
      heartbeat.unref?.();
    },
    cancel() { cleanup(); },
  }, { highWaterMark: 16 });
  return new Response(body, { headers: {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "X-Accel-Buffering": "no",
  } });
}
