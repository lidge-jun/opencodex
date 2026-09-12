import { LIVE_SESSION_UPDATE } from "./audio-api-client";

/** Executable protocol samples, not UI copy; credentials are supplied by the reader. */
export function audioSocketExample(endpoint: string, live: boolean, model: string, keyLabel: string): string {
  const url = new URL(endpoint);
  if (live) url.searchParams.set("model", model);
  const start = live ? LIVE_SESSION_UPDATE
    : { type: "session.start", config: { input_audio_format: "pcm16", sample_rate_hz: 48000, num_channels: 1, max_buffer_size_bytes: 4194304, max_utterance_duration_ms: 30000, session_ttl_ms: 300000, provider_mode: "streaming_sse", transcript_delivery_mode: "segment", vad: { type: "server_vad", threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 500 } } };
  return `const key = prompt(${JSON.stringify(keyLabel)})?.trim();
if (!key) throw new Error("missing_data_key");
const encoded = btoa(String.fromCharCode(...new TextEncoder().encode(key)))
  .replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");
const ws = new WebSocket(${JSON.stringify(url.href)},
  ["opencodex-audio", "opencodex-key." + encoded]);
ws.onopen = () => ws.send(JSON.stringify(${JSON.stringify(start)}));
ws.onmessage = ({ data }) => console.log(JSON.parse(data).type);
// After session.started, send your protocol's audio frames.
// Dictation: mono PCM16 at the declared sample_rate_hz (48000 here).
// Live Voice: input_audio.append / output_audio.delta, 24 kHz mono.
const closeSession = () => ws.send(JSON.stringify({ type: "session.close" }));`;
}

export function audioUploadExample(endpoint: string, model: string): string {
  return [
    `curl ${JSON.stringify(endpoint)}`,
    '  -H "X-OpenCodex-API-Key: $OPENCODEX_API_KEY"',
    `  -F "file=@recording.wav" -F "model=${model}"`,
  ].join(" \\\n");
}
