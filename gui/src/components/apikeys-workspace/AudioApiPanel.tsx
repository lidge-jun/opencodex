import { useEffect, useId, useRef, useState } from "react";
import { AudioApiError, connectLiveAudio, transcribeAudio, type AudioErrorCode, type LiveAudioState } from "../../audio-api-client";
import { IconLink, IconPlay, IconX } from "../../icons";
import { useT } from "../../i18n/shared";
import { CopyableExample, EndpointUrl } from "../../pages/api-keys-copy";
import type { AudioApiInfo } from "../../pages/api-keys-utils";

function socketSample(endpoint: string, live: boolean, model: string): string {
  const url = new URL(endpoint);
  if (live) url.searchParams.set("model", model);
  const start = live
    ? { type: "session.update", session: { instructions: "", audio: { output: { voice: "cove" } }, delegation: { type: "client" } } }
    : { type: "session.start", config: { input_audio_format: "pcm16", sample_rate_hz: 48000, num_channels: 1, max_buffer_size_bytes: 4194304, max_utterance_duration_ms: 30000, session_ttl_ms: 300000, provider_mode: "streaming_sse", transcript_delivery_mode: "segment", vad: { type: "server_vad", threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 500 } } };
  return `const key = prompt("OpenCodex data key").trim();
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

function AudioKeyInput({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const t = useT();
  const id = useId();
  return <label className="audio-api-field" htmlFor={id}>
    <span>{t("audio.key")}</span>
    <input id={id} className="input" type="password" autoComplete="off" spellCheck={false}
      maxLength={4096} value={value} onChange={event => onChange(event.target.value)} />
  </label>;
}

function AudioError({ code }: { code: AudioErrorCode | null }) {
  const t = useT();
  return code ? <p className="audio-api-error" role="alert">{t(`audio.error.${code}`)}</p> : null;
}

export function DictationPanel({ audio }: { audio?: AudioApiInfo }) {
  const t = useT();
  const [key, setKey] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [pending, setPending] = useState(false);
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<AudioErrorCode | null>(null);
  const request = useRef<AbortController | null>(null);
  const fileId = useId();
  const titleId = useId();
  useEffect(() => () => { request.current?.abort(); request.current = null; }, []);
  const cancel = () => {
    request.current?.abort();
    request.current = null;
    setPending(false);
  };
  const upload = async () => {
    if (!audio?.transcriptionConfigured || !file || !key.trim() || request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setPending(true);
    setError(null);
    setText(null);
    try {
      const result = await transcribeAudio(audio.transcriptionEndpoint, audio.transcriptionModel, key, file, controller.signal);
      if (request.current === controller) setText(result);
    } catch (failure) {
      if (request.current === controller && !controller.signal.aborted) setError(failure instanceof AudioApiError ? failure.code : "network");
    } finally {
      if (request.current === controller) { request.current = null; setPending(false); }
    }
  };
  return <section className="audio-api-section" aria-labelledby={titleId}>
    <header className="audio-api-head">
      <h3 id={titleId}>{t("audio.dictation")}</h3>
      <span className="muted small">{t(audio?.transcriptionConfigured ? "audio.configured" : audio ? "audio.notConfigured" : "audio.unknown")}</span>
    </header>
    {audio && <>
      <div className="audio-api-endpoints"><code>{audio.transcriptionModel}</code><EndpointUrl url={audio.transcriptionEndpoint} /></div>
      <form className="audio-api-form" onSubmit={event => { event.preventDefault(); void upload(); }}>
        <AudioKeyInput value={key} onChange={value => { cancel(); setError(null); setKey(value); }} />
        <label className="audio-api-field" htmlFor={fileId}>
          <span>{t("audio.file")}</span>
          <input id={fileId} className="input" type="file" accept="audio/*,.mp4,.webm" onChange={event => {
            cancel(); setError(null); setText(null); setFile(event.target.files?.[0] ?? null);
          }} />
        </label>
        <div className="audio-api-actions">
          <button className="btn btn-primary" type="submit" disabled={pending || !audio.transcriptionConfigured || !file || !key.trim()}>
            <IconPlay width={16} height={16} aria-hidden="true" />{t(pending ? "audio.transcribing" : "audio.transcribe")}
          </button>
          {pending && <button className="btn" type="button" onClick={cancel}><IconX width={16} height={16} aria-hidden="true" />{t("common.cancel")}</button>}
        </div>
      </form>
      <AudioError code={error} />
      {text !== null && <div className="audio-api-result" aria-live="polite"><h4>{t("audio.transcript")}</h4>{text ? <CopyableExample text={text} /> : <p className="muted small">{t("audio.emptyTranscript")}</p>}</div>}
      <details className="audio-api-examples"><summary>{t("audio.examples")}</summary>
        <CopyableExample text={[
          `curl ${JSON.stringify(audio.transcriptionEndpoint)}`,
          '  -H "X-OpenCodex-API-Key: $OPENCODEX_API_KEY"',
          `  -F "file=@recording.wav" -F "model=${audio.transcriptionModel}"`,
        ].join(" \\\n")} />
        <div className="audio-api-head"><h4>{t("audio.streaming")}</h4><span className="muted small">{t(audio.dictationConfigured ? "audio.configured" : "audio.notConfigured")}</span></div>
        <EndpointUrl url={audio.dictationStreamEndpoint} />
        <CopyableExample text={socketSample(audio.dictationStreamEndpoint, false, audio.transcriptionModel)} />
      </details>
    </>}
  </section>;
}

export function LiveVoicePanel({ audio }: { audio?: AudioApiInfo }) {
  const t = useT();
  const [key, setKey] = useState("");
  const [state, setState] = useState<LiveAudioState | "idle">("idle");
  const [error, setError] = useState<AudioErrorCode | null>(null);
  const [events, setEvents] = useState<string[]>([]);
  const connection = useRef<{ dispose?: () => void } | null>(null);
  const id = useId();
  useEffect(() => () => { connection.current?.dispose?.(); connection.current = null; }, []);
  const disconnect = () => {
    connection.current?.dispose?.(); connection.current = null;
    setState("disconnected");
  };
  const connect = () => {
    if (!audio?.liveConfigured || !key.trim() || connection.current) return;
    setError(null); setEvents([]);
    const current: { dispose?: () => void } = {};
    connection.current = current;
    try {
      current.dispose = connectLiveAudio({ endpoint: audio.liveEndpoint, model: audio.liveModel, key,
        onState: (next, code) => {
          if (connection.current !== current) return;
          setState(next); setError(code ?? null);
          if (next === "failed" || next === "disconnected") connection.current = null;
        },
        onEvent: type => { if (connection.current === current) setEvents(previous => [...previous.slice(-7), type]); },
      });
    } catch (failure) {
      connection.current = null;
      setState("failed"); setError(failure instanceof AudioApiError ? failure.code : "network");
    }
  };
  const busy = state === "connecting" || state === "connected";
  return <section className="audio-api-section" aria-labelledby={id}>
    <header className="audio-api-head"><h3 id={id}>{t("audio.liveVoice")}</h3><span className="muted small">{t(audio?.liveConfigured ? "audio.configured" : audio ? "audio.notConfigured" : "audio.unknown")}</span></header>
    {audio && <>
      <div className="audio-api-endpoints"><code>{audio.liveModel}</code><EndpointUrl url={audio.liveEndpoint} /><EndpointUrl url={audio.realtimeCallsEndpoint} /></div>
      <form className="audio-api-form" onSubmit={event => { event.preventDefault(); connect(); }}>
        <AudioKeyInput value={key} onChange={value => { disconnect(); setError(null); setEvents([]); setKey(value); }} />
        <div className="audio-api-actions">
          <button className="btn btn-primary" type="submit" disabled={busy || !audio.liveConfigured || !key.trim()}><IconLink width={16} height={16} aria-hidden="true" />{t("audio.connect")}</button>
          {busy && <button className="btn" type="button" onClick={disconnect}><IconX width={16} height={16} aria-hidden="true" />{t("audio.disconnect")}</button>}
          <span className="audio-api-status" role="status">{t(`audio.state.${state}`)}</span>
        </div>
      </form>
      <AudioError code={error} />
      {events.length > 0 && <pre className="audio-api-events" aria-label={t("audio.events")}>{events.join("\n")}</pre>}
      <details className="audio-api-examples"><summary>{t("audio.examples")}</summary><CopyableExample text={socketSample(audio.liveEndpoint, true, audio.liveModel)} /></details>
    </>}
  </section>;
}
