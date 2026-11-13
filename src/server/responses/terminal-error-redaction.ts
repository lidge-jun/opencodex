import { REDACTED_SECRET, SENSITIVE_KEY_PATTERN, redactSecrets } from "../../lib/redact";
import { CREDENTIAL_SUBSTRING_MIN_LENGTH, credentialComponents, maskSecretSpans } from "../../lib/outbound-credential-registry";
import { replaceSseDataPayload, sseDataPayload, type SseBlockRewrite } from "../sse-payload-rewrite";
import { isUntypedBareUpstreamError } from "../bare-upstream-error";

/**
 * A custom header carries a credential when a credential word is a whole segment of its name
 * (x-auth-token, x-proxy-secret), so a name that merely contains one (x-author) is not swept in.
 */
const CREDENTIAL_HEADER_SEGMENT = /(?:^|[-_])(?:api[-_]?key|secret|passwd|password|credentials?|auth|token)(?:$|[-_])/i;
/** A split-out part made only of letters, dots and underscores reads as protocol vocabulary (response, type). */
const PROTOCOL_WORD = /^[A-Za-z._]+$/;
/**
 * Field names of the Responses frames this rewrite touches. They are protocol, not upstream copy, so
 * masking never renames them, whatever a credential happens to equal.
 */
const PROTOCOL_KEYS = new Set([
  "type", "response", "error", "last_error", "message", "code", "param", "status", "id", "object",
  "incomplete_details", "reason", "output", "usage", "metadata", "sequence_number", "model", "created_at",
  "retryable",
]);

function withEscapedSpelling(part: string): string[] {
  const escaped = JSON.stringify(part).slice(1, -1);
  return escaped === part ? [part] : [part, escaped];
}

/**
 * Mask the selected outbound credential even when upstream echoes only its raw value. A secret
 * containing a quote, backslash or control character appears JSON-escaped inside an SSE payload,
 * so the escaped spelling is masked too. Custom credential headers count as well as the fixed list,
 * and every part a server could authenticate with on its own is masked once it is long enough not
 * to occur in copy by chance and is not a protocol word. The full credential is masked at any
 * length. Spans are merged before replacement, so overlapping credentials leave nothing between them.
 */
export function createOutboundCredentialMask(outboundHeaders: Record<string, string>): (text: string) => string {
  const secrets = Object.entries(outboundHeaders)
    .filter(([name]) => SENSITIVE_KEY_PATTERN.test(name) || CREDENTIAL_HEADER_SEGMENT.test(name))
    .flatMap(([name, value]) => {
      const credential = /^(?:authorization|proxy-authorization)$/i.test(name)
        ? value.replace(/^\S+\s+/, "")
        : value;
      if (!credential) return [];
      const parts = new Set([credential, ...credentialComponents(value)
        .filter(part => part.length >= CREDENTIAL_SUBSTRING_MIN_LENGTH && !PROTOCOL_WORD.test(part))]);
      return [...parts].flatMap(withEscapedSpelling);
    });
  return (text) => maskSecretSpans(text, REDACTED_SECRET, secrets);
}

/**
 * Mask upstream diagnostics before either SSE delivery or buffered JSON reconstruction. Protocol
 * structure is never masked: the `event:` line, the root `type` and Responses field names stay as
 * they are, so the client always recognizes the frame the inspector saw. An untyped envelope is not
 * delivered to a client at all (the terminal boundary withholds it and delivers the terminal it
 * decides); it is masked here only as a fallback for a path that forwards it.
 */
export function createTerminalErrorRedactionBlockRewrite(
  outboundHeaders: Record<string, string>,
  maskCredential = createOutboundCredentialMask(outboundHeaders),
): SseBlockRewrite {
  const redactDiagnostic = (value: unknown): unknown => {
    const maskKnown = (entry: unknown, root = false): unknown => {
      if (typeof entry === "string") return maskCredential(entry);
      if (Array.isArray(entry)) return entry.map(item => maskKnown(item));
      if (entry && typeof entry === "object") {
        // A key is upstream text too: a rewritten terminal copies extra root fields verbatim. Its
        // sensitivity is decided before masking, which could rename a key such as authorization.
        return Object.fromEntries(Object.entries(entry).map(([key, item]) => [
          PROTOCOL_KEYS.has(key) ? key : maskCredential(key),
          SENSITIVE_KEY_PATTERN.test(key) ? REDACTED_SECRET
            : root && key === "type" ? item : maskKnown(item),
        ]));
      }
      return entry;
    };
    // The exact selected credential first: a pattern rule that matches a token inside it (sk-...,
    // Bearer ...) would otherwise split it and leave a prefix the exact mask can no longer find.
    return redactSecrets(maskKnown(value, true));
  };
  // SSE comments and extension fields can also carry upstream text; the event name and the data
  // payload (already masked structurally) are left as they are.
  const maskExtensionLines = (block: string): string => block
    .split("\n")
    .map(line => /^(?:event|data):/.test(line) ? line : maskCredential(line))
    .join("\n");
  return (block) => {
    const terminalFrame = /^event:[ \t]*response\.(?:failed|incomplete)[ \t]*\r?$/m.test(block);
    const payload = sseDataPayload(block);
    if (payload === null) return [terminalFrame ? maskExtensionLines(block) : block];
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      return [terminalFrame ? maskExtensionLines(block) : block];
    }
    if (event?.type !== "response.failed" && event?.type !== "response.incomplete" && !isUntypedBareUpstreamError(event)) {
      return [terminalFrame ? maskExtensionLines(block) : block];
    }
    const safeEvent = redactDiagnostic(event);
    const rewritten = JSON.stringify(safeEvent);
    return [maskExtensionLines(rewritten === payload ? block : replaceSseDataPayload(block, rewritten))];
  };
}
