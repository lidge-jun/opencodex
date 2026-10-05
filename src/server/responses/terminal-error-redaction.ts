import { REDACTED_SECRET, SENSITIVE_KEY_PATTERN, redactSecrets } from "../../lib/redact";
import { replaceSseDataPayload, sseDataPayload, type SseBlockRewrite } from "../sse-payload-rewrite";

// Terminal diagnostics are withheld whenever they carry encoding syntax or non-ASCII text:
// no bounded decoder or Unicode fold can be proven equivalent to what a client or reader recovers.
const ENCODING_SYNTAX = /%[0-9A-Fa-f]{2}|\\(?:u[0-9A-Fa-f]{4}|["\\/bfnrt])|&[A-Za-z#]/;
const NON_PRINTABLE_ASCII = /[^\t\n\r\x20-\x7E]/;

function withholdUnprovableDiagnostic(text: string): string {
  return ENCODING_SYNTAX.test(text) || NON_PRINTABLE_ASCII.test(text) ? REDACTED_SECRET : text;
}

/** Mask the selected outbound credential even when upstream echoes only its raw value. */
export function createOutboundCredentialMask(
  outboundHeaders: Record<string, string>,
  encodedDiagnostics = false,
): (text: string) => string {
  // Match the normalized values actually sent by Fetch, including trimmed header OWS.
  const knownSecrets = [...new Headers(outboundHeaders).entries()]
    .filter(([name]) => SENSITIVE_KEY_PATTERN.test(name))
    .flatMap(([name, value]) => {
      const credential = /^(?:authorization|proxy-authorization)$/i.test(name)
        ? value.replace(/^\S+\s+/, "")
        : value;
      return credential ? [credential] : [];
    })
    .sort((a, b) => b.length - a.length);
  return (text) => {
    const safe = knownSecrets.reduce((value, secret) => value.replaceAll(secret, REDACTED_SECRET), text);
    return encodedDiagnostics ? withholdUnprovableDiagnostic(safe) : safe;
  };
}

/** Mask upstream diagnostics before either SSE delivery or buffered JSON reconstruction. */
export function createTerminalErrorRedactionBlockRewrite(
  outboundHeaders: Record<string, string>,
  maskCredential = createOutboundCredentialMask(outboundHeaders),
): SseBlockRewrite {
  const redactDiagnostic = (value: unknown): unknown => {
    const safe = redactSecrets(value);
    const maskKnown = (entry: unknown): unknown => {
      if (typeof entry === "string") return maskCredential(entry);
      if (Array.isArray(entry)) return entry.map(maskKnown);
      if (entry && typeof entry === "object") {
        return Object.fromEntries(Object.entries(entry).map(([key, item]) => [key, maskKnown(item)]));
      }
      return entry;
    };
    return maskKnown(safe);
  };
  return (block) => {
    const terminalFrame = /^event:[ \t]*response\.(?:failed|incomplete)[ \t]*\r?$/m.test(block);
    const payload = sseDataPayload(block);
    if (payload === null) return [terminalFrame ? maskCredential(block) : block];
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      return [terminalFrame ? maskCredential(block) : block];
    }
    if (event?.type !== "response.failed" && event?.type !== "response.incomplete") {
      return [terminalFrame ? maskCredential(block) : block];
    }
    const safeEvent = redactDiagnostic(event);
    const rewritten = JSON.stringify(safeEvent);
    // SSE comments and extension fields can also carry upstream text.
    return [maskCredential(rewritten === payload ? block : replaceSseDataPayload(block, rewritten))];
  };
}
