/** One readiness observation over the existing audio key subprotocol, with bounded local teardown. */
import { audioTimeout } from "./access-audio-input";

const READY_TIMEOUT_MS = 15_000;
const CLOSE_TIMEOUT_MS = 2_000;
const FRAME_MAX_BYTES = 64 * 1024;
const SESSION_MAX_BYTES = 2 * 1024 * 1024;
const SESSION_UPDATE = {
  type: "session.update",
  session: { instructions: "", audio: { output: { voice: "cove" } }, delegation: { type: "client" } },
};
export type AudioClientSocket = WebSocket & { terminate(): void };
export interface AudioLiveDeps {
  audioReadyTimeoutMs?: number;
  audioCloseTimeoutMs?: number;
  audioSocket?: (url: string, protocols: string[]) => AudioClientSocket;
}
export interface AudioLiveReport {
  schemaVersion: 1;
  ready: boolean;
  close: "confirmed" | "unverified";
  check: "session-readiness";
  event?: "session.started" | "session.updated";
}

export async function checkAudioLive(origin: string, model: string, key: string, signal: AbortSignal, deps: AudioLiveDeps = {}): Promise<{ report: AudioLiveReport; ok: boolean }> {
  const readyMs = audioTimeout(deps.audioReadyTimeoutMs, READY_TIMEOUT_MS);
  const closeMs = audioTimeout(deps.audioCloseTimeoutMs, CLOSE_TIMEOUT_MS);
  signal.throwIfAborted();
  const url = new URL("/v1/live", origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("model", model);
  const protocols = ["opencodex-audio", `opencodex-key.${Buffer.from(key, "utf8").toString("base64url")}`];
  const report: AudioLiveReport = { schemaVersion: 1, ready: false, close: "unverified", check: "session-readiness" };
  const started = performance.now();
  // Native Bun rejects handshake redirects. Real two-endpoint regressions cover HTTP and WS Location forms.
  // The CLI runs on Bun; its native WebSocket adds terminate beyond the DOM type.
  const socket = (deps.audioSocket ?? ((address, carrier) => new WebSocket(address, carrier) as AudioClientSocket))(url.href, protocols);
  return await new Promise(resolve => {
    let finished = false;
    let closing = false;
    let failed = false;
    let total = 0;
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (confirmed: boolean) => {
      if (finished) return;
      finished = true;
      report.close = confirmed ? "confirmed" : "unverified";
      clearTimeout(readyTimer);
      clearTimeout(closeTimer);
      signal.removeEventListener("abort", onAbort);
      socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
      if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
      resolve({ report, ok: !failed && report.ready && confirmed });
    };
    const close = () => {
      if (closing || finished) return;
      closing = true;
      clearTimeout(readyTimer);
      closeTimer = setTimeout(() => finish(false), closeMs);
      try {
        if (socket.readyState === WebSocket.OPEN) socket.send('{"type":"session.close"}');
        socket.close(1000);
      } catch { failed = true; finish(false); }
    };
    const fail = () => { failed = true; close(); };
    const onAbort = () => { failed = true; finish(false); };
    const readyTimer = setTimeout(fail, Math.max(0, readyMs - (performance.now() - started)));
    socket.onopen = () => {
      if (closing || finished) return;
      try { socket.send(JSON.stringify(SESSION_UPDATE)); }
      catch { fail(); }
    };
    socket.onmessage = event => {
      if (finished) return;
      if (typeof event.data !== "string") { fail(); return; }
      const size = Buffer.byteLength(event.data, "utf8");
      total += size;
      if (size > FRAME_MAX_BYTES || total > SESSION_MAX_BYTES) { fail(); return; }
      let message: unknown;
      try { message = JSON.parse(event.data); } catch { fail(); return; }
      if (!message || typeof message !== "object" || Array.isArray(message) || !("type" in message) || typeof message.type !== "string") { fail(); return; }
      if (message.type === "error" || message.type === "protocol.error") { fail(); return; }
      if (message.type !== "session.started" && message.type !== "session.updated") return;
      const session = "session" in message ? message.session : undefined;
      if (!session || typeof session !== "object" || Array.isArray(session)) return;
      if ("status" in session && (session.status === "error" || session.status === "failed" || (!report.ready && session.status === "closed"))) { fail(); return; }
      if (!closing && "id" in session && typeof session.id === "string" && session.id.trim()) {
        report.ready = true;
        report.event = message.type;
        close();
      }
    };
    socket.onerror = fail;
    socket.onclose = event => finish(event.code === 1000);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}
