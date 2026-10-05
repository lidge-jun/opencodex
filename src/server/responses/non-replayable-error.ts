import { REDACTED_SECRET, redactSecrets, redactSecretString } from "../../lib/redact";
import { isNonReplayableResponse, isReplayRefusalResponse, markResponseNonReplayable } from "../../lib/upstream-retry";
import { clientCancelledResponse, readDisplaySafeErrorText } from "./core-errors";
import { createOutboundCredentialMask } from "./terminal-error-redaction";

function maskJson(value: unknown, mask: (text: string) => string, depth = 0): unknown {
  if (depth > 64) throw new Error("Upstream diagnostic nesting exceeds the display limit");
  if (typeof value === "string") return mask(value);
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    const text = String(value);
    return mask(text) === text ? value : REDACTED_SECRET;
  }
  if (Array.isArray(value)) return value.map(item => maskJson(item, mask, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      mask(key), maskJson(item, mask, depth + 1),
    ]));
  }
  return value;
}

function diagnosticBody(text: string, mask: (text: string) => string, status: number): string {
  const fallback = JSON.stringify({ error: { type: "upstream_error", message: `Provider error ${status}: diagnostic unavailable` } });
  if (!text.trim()) return fallback;
  let parsed: unknown;
  try { parsed = JSON.parse(text); }
  catch {
    // Malformed structured diagnostics may contain escaped secrets that cannot be decoded safely.
    if (/^[\s]*[\[{\"]/.test(text)) return fallback;
    return JSON.stringify({ error: { type: "upstream_error", message: redactSecretString(mask(text)) } });
  }
  try { return JSON.stringify(redactSecrets(maskJson(parsed, mask))); }
  catch { return fallback; }
}

/** Client projection never grants another send or turns a real upstream error into our refusal. */
export async function sanitizeNonReplayableUpstreamError(
  response: Response,
  outboundHeaders: Record<string, string>,
  signal: AbortSignal,
): Promise<Response> {
  if (response.ok || !isNonReplayableResponse(response) || isReplayRefusalResponse(response)) return response;
  const text = await readDisplaySafeErrorText(response, signal, "");
  if (signal.aborted) {
    const cancelled = clientCancelledResponse();
    markResponseNonReplayable(cancelled);
    return cancelled;
  }
  const mask = createOutboundCredentialMask(outboundHeaders, true);
  const headers = new Headers({ "content-type": "application/json" });
  if (response.headers.get("x-should-retry") === "false") headers.set("x-should-retry", "false");
  const safe = new Response(response.status === 304 ? null : diagnosticBody(text, mask, response.status), {
    status: response.status, headers,
  });
  markResponseNonReplayable(safe);
  return safe;
}
