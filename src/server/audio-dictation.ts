import { formatErrorResponse } from "../bridge";
import type { AdmissionLease } from "../lib/admission";
import type { OcxConfig } from "../types";
import type { AudioClient } from "./audio-client";
import { resolveAudioUpstream, TRANSCRIPTION_MODEL, type AudioUpstream } from "./audio-upstream";
import type { RequestLogContext } from "./request-log";

export const DICTATION_SESSION_MAX_MS = 300_000;
const DICTATION_FRAME_MAX_BYTES = 64 * 1024;
type JsonObject = Record<string, unknown>;
function object(value: unknown): value is JsonObject { return !!value && typeof value === "object" && !Array.isArray(value); }
function integer(value: unknown, min: number, max: number): boolean {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

export function createDictationFrameValidator(): (frame: string | Buffer) => boolean {
  let started = false;
  let closed = false;
  return frame => {
    if (closed || typeof frame !== "string" || Buffer.byteLength(frame) > DICTATION_FRAME_MAX_BYTES) return false;
    let event: unknown;
    try { event = JSON.parse(frame); } catch { return false; }
    if (!object(event)) return false;
    if (event.type === "session.start" && !started) {
      const config = event.config;
      if (!object(config) || Object.keys(event).some(key => key !== "type" && key !== "config")) return false;
      const fields = new Set(["input_audio_format", "sample_rate_hz", "num_channels", "max_buffer_size_bytes", "max_utterance_duration_ms", "session_ttl_ms", "provider_mode", "transcript_delivery_mode", "vad"]);
      if (Object.keys(config).some(key => !fields.has(key)) || config.input_audio_format !== "pcm16" || config.num_channels !== 1
        || !integer(config.sample_rate_hz, 8000, 192000) || !integer(config.max_buffer_size_bytes, 1, 4 * 1024 * 1024)
        || !integer(config.max_utterance_duration_ms, 1, 30000) || !integer(config.session_ttl_ms, 1, DICTATION_SESSION_MAX_MS)
        || !["buffered", "streaming_sse"].includes(String(config.provider_mode))
        || !["final_only", "segment", "delta"].includes(String(config.transcript_delivery_mode))) return false;
      const vad = config.vad;
      if (!object(vad) || Object.keys(vad).some(key => !["type", "threshold", "prefix_padding_ms", "silence_duration_ms"].includes(key))
        || vad.type !== "server_vad" || typeof vad.threshold !== "number" || !Number.isFinite(vad.threshold) || vad.threshold < 0 || vad.threshold > 1
        || !integer(vad.prefix_padding_ms, 0, 1000) || !integer(vad.silence_duration_ms, 0, 5000)) return false;
      started = true;
      return true;
    }
    if (!started) return false;
    if (event.type === "session.close" && Object.keys(event).length === 1) { closed = true; return true; }
    if (event.type !== "audio.append" || Object.keys(event).some(key => key !== "type" && key !== "audio") || typeof event.audio !== "string" || !event.audio) return false;
    const bytes = Buffer.from(event.audio, "base64");
    return bytes.length > 0 && bytes.length % 2 === 0 && bytes.toString("base64") === event.audio;
  };
}

export interface AudioSocketTarget {
  headers: Record<string, string>;
  upstreamWsUrl: string;
  protocols?: string[];
  validateFrame?: (frame: string | Buffer) => boolean;
  maxSessionMs: number;
  finish: (outcome?: number | "timeout" | "connect_error") => void;
}

export function finishAudioUpstream(relay: AudioUpstream): AudioSocketTarget["finish"] {
  let finished = false;
  return outcome => {
    if (finished) return;
    finished = true;
    try { if (outcome !== undefined) relay.recordOutcome?.(outcome); }
    finally { relay.release(); }
  };
}

export async function resolveDictationSocket(
  client: AudioClient, config: OcxConfig, log: RequestLogContext, lease: AdmissionLease, signal?: AbortSignal,
): Promise<AudioSocketTarget | Response> {
  const relay = await resolveAudioUpstream(client.headers, config, log, { admission: client.admission, model: TRANSCRIPTION_MODEL, lease, signal });
  if (relay instanceof Response) return relay;
  if (relay.keyed) {
    relay.release();
    return formatErrorResponse(400, "invalid_request_error", "Streaming dictation requires a connected ChatGPT account");
  }
  const headers = new Headers(relay.headers);
  const token = headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
  if (!token || /[\s,]/.test(token)) {
    relay.release();
    return formatErrorResponse(401, "authentication_error", "Dictation account authentication unavailable");
  }
  headers.delete("authorization");
  return {
    upstreamWsUrl: "wss://chatgpt.com/backend-api/dictation/stream",
    headers: Object.fromEntries(headers),
    protocols: ["chatgpt-dictation", `openai-bearer.${token}`, "codex-desktop"],
    validateFrame: createDictationFrameValidator(),
    maxSessionMs: DICTATION_SESSION_MAX_MS,
    finish: finishAudioUpstream(relay),
  };
}
