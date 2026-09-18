import { fetchAudioUpload } from "./api";
import { createBoundedFetch } from "./bounded-fetch";

export type AudioErrorCode = "auth" | "unavailable" | "rateLimit" | "invalid" | "size" | "network" | "timeout" | "protocol";
export class AudioApiError extends Error {
  readonly code: AudioErrorCode;
  constructor(code: AudioErrorCode) { super(code); this.code = code; }
}

export const AUDIO_FILE_MAX_BYTES = 25_000_000;
const RESPONSE_MAX_BYTES = 2 * 1024 * 1024;

export async function transcribeAudio(endpoint: string, model: string, key: string, file: File, signal: AbortSignal): Promise<string> {
  if (!file.size || file.size > AUDIO_FILE_MAX_BYTES) throw new AudioApiError("size");
  if (!key.trim()) throw new AudioApiError("auth");
  signal.throwIfAborted();
  const bounded = createBoundedFetch(130_000);
  const abort = () => bounded.controller.abort(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  try {
    const form = new FormData();
    form.set("file", file);
    form.set("model", model);
    form.set("response_format", "json");
    const response = await fetchAudioUpload(endpoint, {
      method: "POST", headers: { "X-OpenCodex-API-Key": key.trim() }, body: form, signal: bounded.signal,
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      throw new AudioApiError(response.status === 401 || response.status === 403 ? "auth"
        : response.status === 429 ? "rateLimit" : response.status === 413 ? "size"
        : response.status >= 500 ? "unavailable" : "invalid");
    }
    const reader = response.body?.getReader();
    if (!reader) throw new AudioApiError("protocol");
    const cancel = () => { void reader.cancel().catch(() => {}); };
    bounded.signal.addEventListener("abort", cancel, { once: true });
    let text = "";
    let bytes = 0;
    const decoder = new TextDecoder();
    try {
      bounded.signal.throwIfAborted();
      for (;;) {
        const part = await reader.read();
        bounded.signal.throwIfAborted();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > RESPONSE_MAX_BYTES) throw new AudioApiError("protocol");
        text += decoder.decode(part.value, { stream: true });
      }
      text += decoder.decode();
    } finally {
      bounded.signal.removeEventListener("abort", cancel);
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    let data: unknown;
    try { data = JSON.parse(text); } catch { throw new AudioApiError("protocol"); }
    if (!data || typeof data !== "object" || typeof (data as { text?: unknown }).text !== "string") throw new AudioApiError("protocol");
    return (data as { text: string }).text;
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    if (bounded.signal.aborted) throw new AudioApiError("timeout");
    throw error instanceof AudioApiError ? error : new AudioApiError("network");
  } finally {
    signal.removeEventListener("abort", abort);
    bounded.clear();
  }
}

export function audioSocketProtocols(key: string): string[] {
  const bytes = new TextEncoder().encode(key.trim());
  if (!bytes.length || bytes.length > 4096) throw new AudioApiError("auth");
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const encoded = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return ["opencodex-audio", `opencodex-key.${encoded}`];
}

export const LIVE_SESSION_UPDATE = {
  type: "session.update",
  session: { instructions: "", audio: { output: { voice: "cove" } }, delegation: { type: "client" } },
} as const;
export type LiveAudioState = "connecting" | "connected" | "disconnected" | "failed";
const DISPLAY_EVENTS = new Set(["session.started", "session.updated", "delegation.created", "output_audio.delta"]);

/** Connection-only probe: no microphone, audio frame, delegation execution or reconnect. */
export function connectLiveAudio(options: {
  endpoint: string; model: string; key: string;
  onState: (state: LiveAudioState, error?: AudioErrorCode) => void;
  onEvent: (type: string) => void;
  readyTimeoutMs?: number;
  maxSessionMs?: number;
}): () => void {
  const url = new URL(options.endpoint);
  if (!["ws:", "wss:"].includes(url.protocol) || url.pathname !== "/v1/live"
    || url.username || url.password || url.search || url.hash) throw new AudioApiError("invalid");
  url.searchParams.set("model", options.model);
  const socket = new WebSocket(url.href, audioSocketProtocols(options.key));
  let finished = false;
  let ready = false;
  let lifetime: ReturnType<typeof setTimeout> | undefined;
  const deadline = setTimeout(() => finish("failed", "timeout"), options.readyTimeoutMs ?? 15_000);
  const dispose = () => {
    clearTimeout(deadline);
    clearTimeout(lifetime);
    socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
    try {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "session.close" }));
      socket.close();
    } catch { /* A connecting or already closed browser socket has nothing left to send. */ }
  };
  function finish(state: LiveAudioState, error?: AudioErrorCode) {
    if (finished) return;
    finished = true;
    dispose();
    options.onState(state, error);
  }
  socket.onopen = () => {
    try { socket.send(JSON.stringify(LIVE_SESSION_UPDATE)); }
    catch { finish("failed", "network"); }
  };
  socket.onmessage = event => {
    if (finished) return;
    if (typeof event.data !== "string" || event.data.length > 64 * 1024) { finish("failed", "protocol"); return; }
    let message: { type?: unknown; session?: { id?: unknown; status?: unknown } };
    try { message = JSON.parse(event.data); } catch { finish("failed", "protocol"); return; }
    if (!message || typeof message !== "object" || typeof message.type !== "string") { finish("failed", "protocol"); return; }
    if (message.type === "error" || message.type === "protocol.error") { finish("failed", "protocol"); return; }
    if (message.type === "session.started" || message.type === "session.updated") {
      const session = message.session;
      if (session?.status === "error" || session?.status === "failed") {
        finish("failed", "protocol");
        return;
      }
      if (session?.status === "closed") {
        finish(ready ? "disconnected" : "failed", ready ? undefined : "protocol");
        return;
      }
      if (!ready && typeof session?.id === "string" && session.id.trim()) {
        ready = true;
        clearTimeout(deadline);
        lifetime = setTimeout(() => finish("disconnected"), options.maxSessionMs ?? 60_000);
        options.onState("connected");
      }
    }
    if (DISPLAY_EVENTS.has(message.type)) options.onEvent(message.type);
  };
  socket.onerror = () => finish("failed", "network");
  socket.onclose = event => finish(ready && event.code === 1000 ? "disconnected" : "failed", ready && event.code === 1000 ? undefined : "network");
  options.onState("connecting");
  return () => { if (!finished) { finished = true; dispose(); } };
}
