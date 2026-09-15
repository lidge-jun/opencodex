import { isCyberPolicyCode } from "../../lib/errors";
import { redactSecretString } from "../../lib/redact";
import type { AdapterEvent, OcxUsage } from "../../types";

// 260715 (issue #126): surface upstream error detail through the web-search sidecar loop.
// loop.ts only appends a suffix to "Provider error N" when the adapter exposes
// formatErrorBody; without it, strict OpenAI-compatible backends (NVIDIA NIM pydantic
// validation, "This model only supports single tool-calls at once!", etc.) were reduced
// to a bare status code. JSON-only extraction: recognized string fields are returned,
// HTML/non-JSON bodies yield "" so raw markup is never echoed to the client.
export function formatOpenAIChatErrorBody(status: number, _headers: Headers, payloadText: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadText);
  } catch {
    return "";
  }
  const detail = extractErrorDetail(parsed);
  if (!detail) return "";
  return redactSecretString(detail).slice(0, 400);
}

function extractErrorDetail(parsed: unknown): string | undefined {
  if (typeof parsed === "string") return parsed.trim() || undefined;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const obj = parsed as Record<string, unknown>;
  const err = obj.error;
  if (typeof err === "string" && err.trim()) return err.trim();
  if (err !== null && typeof err === "object" && !Array.isArray(err)) {
    const msg = (err as Record<string, unknown>).message;
    if (typeof msg === "string" && msg.trim()) return msg.trim();
  }
  const det = obj.detail;
  if (typeof det === "string" && det.trim()) return det.trim();
  if (Array.isArray(det)) {
    const msgs = det
      .map(item => (item !== null && typeof item === "object" && typeof (item as Record<string, unknown>).msg === "string"
        ? ((item as Record<string, unknown>).msg as string).trim()
        : ""))
      .filter(m => m.length > 0);
    if (msgs.length > 0) return msgs.join("; ");
  }
  if (typeof obj.message === "string" && obj.message.trim()) return obj.message.trim();
  if (typeof obj.title === "string" && obj.title.trim()) return obj.title.trim();
  return undefined;
}

export function unwrapChatCompletionPayload(json: Record<string, unknown>): Record<string, unknown> {
  if ((json.error !== undefined && json.error !== null) || Array.isArray(json.choices)) return json;
  const data = json.data;
  return data !== null && typeof data === "object" && !Array.isArray(data)
    ? data as Record<string, unknown>
    : json;
}

export interface OpenAIChatError {
  message?: unknown;
  code?: unknown;
  type?: unknown;
  status?: unknown;
  metadata?: unknown;
}

export function safeUpstreamRequestId(metadata: unknown): string | undefined {
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) return undefined;
  const record = metadata as Record<string, unknown>;
  const value = record.request_id ?? record.requestId;
  if (typeof value !== "string") return undefined;
  const requestId = value.trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(requestId)
    && redactSecretString(requestId) === requestId
    ? requestId
    : undefined;
}

export function upstreamErrorEvent(
  error: unknown,
  usage?: OcxUsage,
): Extract<AdapterEvent, { type: "error" }> {
  const details = error !== null && typeof error === "object" && !Array.isArray(error)
    ? error as OpenAIChatError
    : undefined;
  const rawMessage = typeof error === "string"
    ? error.trim() || "upstream error"
    : typeof details?.message === "string" ? details.message : "upstream error";
  const safeMessage = redactSecretString(rawMessage);
  const requestId = safeUpstreamRequestId(details?.metadata);
  const message = requestId !== undefined && !safeMessage.includes(requestId)
    ? `${safeMessage} (request ID: ${requestId})`
    : safeMessage;
  const code = typeof details?.code === "string"
    ? details.code
    : typeof details?.code === "number" && Number.isFinite(details.code) && Number.isInteger(details.code)
      ? String(details.code)
      : undefined;
  const errorType = typeof details?.type === "string" ? details.type : undefined;
  const codeStatus = typeof details?.code === "number"
    && Number.isInteger(details.code)
    && details.code >= 100
    && details.code <= 599
    ? details.code
    : undefined;
  const status = isCyberPolicyCode(code)
    ? 400
    : typeof details?.status === "number" && Number.isInteger(details.status)
      ? details.status
      : codeStatus;
  return {
    type: "error",
    message,
    ...(usage !== undefined ? { usage } : {}),
    ...(code !== undefined ? { code } : {}),
    ...(errorType !== undefined ? { errorType } : {}),
    ...(status !== undefined ? { status } : {}),
  };
}
