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
const MODELS = new Set([TRANSCRIPTION_MODEL, "gpt-4o-mini-transcribe", "whisper-1"]);

interface TranscriptionInput {
  file: File;
  model: string;
  prompt?: string;
  language?: string;
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
    if (!FIELDS.has(name)) return invalid(`Unsupported transcription field: ${name.slice(0, 64)}`);
    if (seen.has(name)) return invalid(`Duplicate transcription field: ${name}`);
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
  if (language !== null && !/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/.test(language)) return invalid("Invalid transcription language");
  return { file, model, format, ...(prompt !== null ? { prompt } : {}), ...(language !== null ? { language } : {}) };
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
    form.append("file", input.file, "audio" + (/\.[a-z0-9]{1,8}$/i.exec(input.file.name)?.[0] ?? ".webm"));
    if (input.prompt !== undefined) form.append("prompt", input.prompt);
    if (input.language !== undefined) form.append("language", input.language);
    if (relay.keyed) {
      form.append("model", input.model);
      form.append("response_format", "json");
    }
    const upstream = await fetch(url, { method: "POST", headers, body: form, signal: signal.signal, redirect: "manual" });
    outcome = upstream.ok ? 502 : upstream.status;
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
    outcome = upstream.status;
    return input.format === "text"
      ? new Response(payload.text, { headers: { "content-type": "text/plain; charset=utf-8" } })
      : Response.json({ text: payload.text });
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
