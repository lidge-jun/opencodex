import { inheritAccountAutoPauseResponse } from "../lib/account-auto-pause-response";
import { readBoundedResponseBody } from "../lib/bounded-body";
import { redactSecretString } from "../lib/redact";

const ABSOLUTE_PATH_PATTERN = /(?:\/Users\/[^ "';,]+|\/home\/[^ "';,]+|\/root\/[^ "';,]*|[A-Za-z]:\\Users\\[^ "';,]+)/g;

export function sanitizeUpstreamErrorText(value: string): string {
  return redactSecretString(value).replace(ABSOLUTE_PATH_PATTERN, "[REDACTED_PATH]");
}

export function safeUpstreamErrorString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function parseUpstreamJsonPayload(payloadText: string): unknown | undefined {
  const trimmed = payloadText.trim();
  if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

export async function readDisplaySafeErrorPayloadText(res: Response, signal?: AbortSignal): Promise<string> {
  try {
    const body = await readBoundedResponseBody(res, { signal });
    return body.displaySafe ? body.text : "";
  } catch (error) {
    if (signal?.aborted) throw error;
    return "";
  }
}

export async function normalizeUpstreamHttpErrorResponse(
  res: Response,
  opts: { signal?: AbortSignal; formatMessage: (payloadText: string) => string | Promise<string> },
): Promise<Response> {
  if (res.ok) return res;
  const payloadText = await readDisplaySafeErrorPayloadText(res, opts.signal);
  const headers = new Headers(res.headers);
  headers.delete("content-encoding");
  headers.delete("content-length");
  return inheritAccountAutoPauseResponse(res, new Response(await opts.formatMessage(payloadText), {
    status: res.status,
    statusText: res.statusText,
    headers,
  }));
}
