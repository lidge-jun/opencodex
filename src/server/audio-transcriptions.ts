import { formatErrorResponse } from "../bridge";
import { cancelBodyOnAbort, clearableDeadline, signalWithTimeout } from "../lib/abort";
import type { AdmissionLease } from "../lib/admission";
import { sidecarEnter } from "../lib/sidecar-tracker";
import type { OcxConfig } from "../types";
import type { DataPlaneAdmission } from "./auth-cors";
import { resolveAudioUpstream, TRANSCRIPTION_MODEL } from "./audio-upstream";
import { readBodyCapped } from "./live";
import type { RequestLogContext } from "./request-log";
import { registerTurn, unregisterTurn } from "./lifecycle";

export const AUDIO_FILE_MAX_BYTES = 25_000_000;
export const AUDIO_BODY_MAX_BYTES = 32 * 1024 * 1024;
const AUDIO_FIELD_MAX_BYTES = 16 * 1024;
const AUDIO_RESPONSE_MAX_BYTES = 2 * 1024 * 1024;
const AUDIO_TIMEOUT_MS = 120_000;
const FIELDS = new Set(["file", "model", "prompt", "language", "response_format"]);
/** Repeated multipart arrays, as OpenAI's create-transcription reference spells them. */
const LIST_FIELDS = new Set(["keywords[]", "languages[]"]);
const LIST_MAX_ITEMS = 100;
/** OpenAI's recommended file model; it takes keywords[] and languages[] instead of language. */
const LIST_MODEL = "gpt-transcribe";
const MODELS = new Set([TRANSCRIPTION_MODEL, "gpt-4o-mini-transcribe", "whisper-1", LIST_MODEL]);
const LANGUAGE_CODE = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/;

interface TranscriptionInput {
  file: File;
  model: string;
  prompt?: string;
  language?: string;
  keywords: string[];
  languages: string[];
  format: "json" | "text";
}

function invalid(message: string, status = 400): Response {
  return formatErrorResponse(status, "invalid_request_error", message);
}

async function parseTranscription(req: Request, operationSignal: AbortSignal): Promise<TranscriptionInput | Response> {
  if (!/^multipart\/form-data\s*;/i.test(req.headers.get("content-type") ?? "")) {
    return invalid("Expected multipart/form-data with file and model");
  }
  const encoding = req.headers.get("content-encoding")?.trim().toLowerCase();
  if (encoding && encoding !== "identity") return invalid("Compressed audio request bodies are not supported");
  const length = req.headers.get("content-length");
  if (length && /^\d+$/.test(length) && Number(length) > AUDIO_BODY_MAX_BYTES) {
    await req.body?.cancel().catch(() => {});
    return invalid("Audio request exceeds 32 MiB", 413);
  }
  let form: FormData;
  const uploadDeadline = clearableDeadline(30_000, operationSignal);
  try {
    const body = await readBodyCapped(req.body, AUDIO_BODY_MAX_BYTES, () => "Audio request too large", uploadDeadline.signal);
    if (body instanceof Response) return invalid("Audio request exceeds 32 MiB", 413);
    if (operationSignal.aborted) return formatErrorResponse(499, "client_closed_request", "Audio upload canceled");
    form = await new Response(body, { headers: { "content-type": req.headers.get("content-type")! } }).formData();
  } catch {
    if (uploadDeadline.didExpire()) return formatErrorResponse(408, "request_timeout", "Audio upload timed out");
    return operationSignal.aborted
      ? formatErrorResponse(499, "client_closed_request", "Audio upload canceled")
      : invalid("Malformed audio multipart body");
  } finally {
    uploadDeadline.clear();
  }
  const seen = new Set<string>();
  for (const [name, value] of form) {
    const list = LIST_FIELDS.has(name);
    if (!FIELDS.has(name) && !list) return invalid(`Unsupported transcription field: ${name.slice(0, 64)}`);
    if (seen.has(name) && !list) return invalid(`Duplicate transcription field: ${name}`);
    seen.add(name);
    if (name !== "file" && (typeof value !== "string" || Buffer.byteLength(value) > AUDIO_FIELD_MAX_BYTES)) {
      return invalid("Audio text fields must be strings no larger than 16 KiB", 413);
    }
  }
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) return invalid("A nonempty audio file is required");
  if (file.size > AUDIO_FILE_MAX_BYTES) return invalid("Audio file exceeds 25,000,000 bytes", 413);
  const model = form.get("model");
  if (typeof model !== "string" || !MODELS.has(model)) return invalid("Unsupported transcription model");
  const format = form.get("response_format") ?? "json";
  if (format !== "json" && format !== "text") return invalid("response_format must be json or text");
  const prompt = form.get("prompt") as string | null;
  const language = form.get("language") as string | null;
  if (language !== null && !LANGUAGE_CODE.test(language)) return invalid("Invalid transcription language");
  const keywords = form.getAll("keywords[]") as string[];
  const languages = form.getAll("languages[]") as string[];
  if (keywords.length > LIST_MAX_ITEMS || languages.length > LIST_MAX_ITEMS) {
    return invalid(`keywords[] and languages[] accept at most ${LIST_MAX_ITEMS} entries each`);
  }
  if (model === LIST_MODEL) {
    if (language !== null) return invalid(`${LIST_MODEL} takes languages[] instead of language`);
  } else if (keywords.length > 0 || languages.length > 0) {
    return invalid(`keywords[] and languages[] require ${LIST_MODEL}`);
  }
  if (keywords.some(keyword => !keyword.trim() || /[<>\r\n]/.test(keyword))) return invalid("Invalid transcription keyword");
  if (languages.some(code => !LANGUAGE_CODE.test(code))) return invalid("Invalid transcription language");
  return {
    file, model, format, keywords, languages,
    ...(prompt !== null ? { prompt } : {}), ...(language !== null ? { language } : {}),
  };
}

type UploadFormat = { extension: string; type: string };

/**
 * The container a file's leading bytes declare. openai/codex names its upload from the clip's MIME
 * type (backend-client client.rs transcribe_audio), but Bun's multipart parser drops a part's
 * Content-Type, so the bytes are the only type evidence that survives ingress here.
 */
function sniffAudioFormat(head: Uint8Array): UploadFormat | undefined {
  const ascii = (start: number, text: string) => [...text].every((char, index) => head[start + index] === char.charCodeAt(0));
  if (ascii(0, "RIFF") && ascii(8, "WAVE")) return { extension: ".wav", type: "audio/wav" };
  if (ascii(0, "OggS")) return { extension: ".ogg", type: "audio/ogg" };
  if (ascii(0, "fLaC")) return { extension: ".flac", type: "audio/flac" };
  if (ascii(4, "ftyp")) return { extension: ".m4a", type: "audio/mp4" };
  if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return { extension: ".webm", type: "audio/webm" };
  // ID3 tag, or an MPEG audio frame sync whose layer bits are set (ADTS AAC leaves them zero).
  if (ascii(0, "ID3") || (head[0] === 0xff && (head[1]! & 0xe0) === 0xe0 && ((head[1]! >> 1) & 3) !== 0)) {
    return { extension: ".mp3", type: "audio/mpeg" };
  }
  return undefined;
}

/** Name and type the upstream part so it can be identified; an unknown extensionless clip keeps the old .webm name. */
async function uploadFile(file: File): Promise<File> {
  const sniffed = sniffAudioFormat(new Uint8Array(await file.slice(0, 12).arrayBuffer()));
  const extension = /\.[a-z0-9]{1,8}$/i.exec(file.name)?.[0] ?? sniffed?.extension ?? ".webm";
  return new File([file], "audio" + extension, sniffed ? { type: sniffed.type } : {});
}

/** Detected languages, reduced to their codes; anything else in the upstream array is dropped. */
function detectedLanguages(payload: object): Array<{ code: string }> | undefined {
  if (!("languages" in payload) || !Array.isArray(payload.languages)) return undefined;
  return payload.languages.flatMap(entry => entry && typeof entry === "object" && "code" in entry
    && typeof entry.code === "string" && LANGUAGE_CODE.test(entry.code) ? [{ code: entry.code }] : []);
}

async function transcribeAdmitted(
  req: Request,
  config: OcxConfig,
  log: RequestLogContext,
  admission: DataPlaneAdmission,
  operation: { lease?: AdmissionLease; signal: AbortSignal; didExpire: () => boolean },
): Promise<Response> {
  const input = await parseTranscription(req, operation.signal);
  if (input instanceof Response) return input;
  if (operation.signal.aborted) return formatErrorResponse(499, "client_closed_request", "Audio request canceled");
  const relay = await resolveAudioUpstream(req.headers, config, log, { admission, model: input.model, lease: operation.lease, signal: operation.signal });
  if (relay instanceof Response) return relay;
  const signal = signalWithTimeout(AUDIO_TIMEOUT_MS, operation.signal);
  const exit = sidecarEnter("audio-transcription");
  let outcome: number | "timeout" | "connect_error" | undefined;
  try {
    if (!relay.keyed && input.model !== TRANSCRIPTION_MODEL) return invalid(`ChatGPT transcription supports only ${TRANSCRIPTION_MODEL}`);
    const url = relay.keyed
      ? `${relay.providerBaseUrl}/audio/transcriptions`
      : "https://chatgpt.com/backend-api/transcribe";
    const headers = new Headers();
    for (const name of ["authorization", "chatgpt-account-id", "user-agent", "originator", "version"]) {
      const value = new Headers(relay.headers).get(name);
      if (value) headers.set(name, value);
    }
    if (!relay.keyed) {
      const nativeAgent = req.headers.get("user-agent");
      headers.set("user-agent", nativeAgent && /^codex(?:[_ /-]|$)/i.test(nativeAgent)
        ? nativeAgent.slice(0, 2048) : "codex_cli_rs");
      if (!headers.has("originator")) headers.set("originator", "codex_cli_rs");
    }
    const form = new FormData();
    form.append("file", await uploadFile(input.file));
    if (input.prompt !== undefined) form.append("prompt", input.prompt);
    if (input.language !== undefined) form.append("language", input.language);
    for (const keyword of input.keywords) form.append("keywords[]", keyword);
    for (const code of input.languages) form.append("languages[]", code);
    if (relay.keyed) {
      form.append("model", input.model);
      form.append("response_format", "json");
    }
    const upstream = await fetch(url, { method: "POST", headers, body: form, signal: signal.signal, redirect: "manual" });
    outcome = upstream.status;
    const detach = cancelBodyOnAbort(upstream.body, signal.signal);
    let body: ArrayBuffer | Response;
    try {
      body = await readBodyCapped(upstream.body, AUDIO_RESPONSE_MAX_BYTES, () => "Audio upstream response too large", signal.signal);
    } finally {
      detach();
    }
    if (body instanceof Response) return body;
    if (!upstream.ok) {
      const status = upstream.status >= 400 && upstream.status <= 599 ? upstream.status : 502;
      return formatErrorResponse(status, "upstream_error", `Audio upstream returned HTTP ${upstream.status}`);
    }
    let payload: unknown;
    try { payload = JSON.parse(new TextDecoder().decode(body)); } catch {
      return formatErrorResponse(502, "upstream_error", "Audio upstream returned invalid JSON");
    }
    if (!payload || typeof payload !== "object" || !("text" in payload) || typeof payload.text !== "string") {
      return formatErrorResponse(502, "upstream_error", "Audio upstream response is missing text");
    }
    const languages = detectedLanguages(payload);
    return input.format === "text"
      ? new Response(payload.text, { headers: { "content-type": "text/plain; charset=utf-8" } })
      : Response.json({ text: payload.text, ...(languages ? { languages } : {}) });
  } catch {
    if (operation.signal.aborted) {
      outcome = operation.didExpire() ? "timeout" : undefined;
      return formatErrorResponse(499, "client_closed_request", "Audio request canceled");
    }
    const timedOut = signal.signal.aborted;
    outcome = timedOut ? "timeout" : "connect_error";
    return formatErrorResponse(timedOut ? 504 : 502, "upstream_error", timedOut ? "Audio upstream timed out" : "Audio upstream connection failed");
  } finally {
    try {
      if (outcome !== undefined) relay.recordOutcome?.(outcome);
    } finally {
      relay.release();
      signal.cleanup();
      exit();
    }
  }
}

export async function handleAudioTranscriptions(
  req: Request,
  config: OcxConfig,
  log: RequestLogContext,
  admission: DataPlaneAdmission,
  lease?: AdmissionLease,
): Promise<Response> {
  const operation = new AbortController();
  if (lease) registerTurn(operation, lease);
  const deadline = clearableDeadline(AUDIO_TIMEOUT_MS, AbortSignal.any([req.signal, operation.signal]));
  try {
    const response = await transcribeAdmitted(req, config, log, admission, { lease, signal: deadline.signal, didExpire: deadline.didExpire });
    if (req.signal.aborted) return formatErrorResponse(499, "client_closed_request", "Audio request canceled");
    if (operation.signal.aborted) return formatErrorResponse(503, "server_draining", "Audio request stopped during shutdown");
    if (deadline.didExpire()) return formatErrorResponse(504, "upstream_error", "Audio request timed out");
    return response;
  } finally {
    deadline.clear();
    if (lease) unregisterTurn(operation);
  }
}
