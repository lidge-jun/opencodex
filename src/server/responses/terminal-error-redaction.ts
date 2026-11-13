import { REDACTED_SECRET, SENSITIVE_KEY_PATTERN, redactSecrets } from "../../lib/redact";
import {
  CREDENTIAL_SUBSTRING_MIN_LENGTH,
  SENT_VALUE_GUARD_SCAN_CHARS,
  createSentValueGuard,
  createSentValueMask,
  credentialComponents,
  maskSecretSpans,
} from "../../lib/outbound-credential-registry";
import { replaceSseDataPayload, sseDataPayload, type SseBlockRewrite } from "../sse-payload-rewrite";
import { isUntypedBareUpstreamError } from "../bare-upstream-error";
import { isCyberPolicyCode, isTerminalRefusalCode, recognizedUpstreamError } from "../../lib/errors";

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
 * A recognized error class (a refusal, policy, rate-limit, overload or client-error class) is public
 * protocol vocabulary, not a secret: masking it hides nothing and would make a reader that classifies
 * the masked frame disagree with one that reads the original. An unrecognized code or type is masked.
 */
function isPublicClassValue(key: string, value: unknown): boolean {
  if (typeof value !== "string") return false;
  if (key === "code") return isTerminalRefusalCode(value) || isCyberPolicyCode(value) || recognizedUpstreamError({ code: value }) !== undefined;
  if (key === "type") return recognizedUpstreamError({ type: value }) !== undefined;
  return false;
}

/** An error identity a client acts on (recognized class, refusal code, generic upstream failure). */
function isPublicErrorVocabulary(value: string): boolean {
  return value === "upstream_error" || value === "upstream_server_error" || value === "invalid_request_error"
    || isPublicClassValue("code", value) || isPublicClassValue("type", value);
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
 * The mask for copy a terminal boundary synthesizes from upstream evidence (verdict tails, policy
 * terminals, buffered error presentations). Beyond the exact credential mask, copy that repeats any
 * value this request sent is refused whole ({@link createSentValueGuard}: credential-named values
 * whole or by any 8+ character excerpt, other non-correlation values whole at 8+). Only the scanned
 * head of the copy is returned, so nothing unread is emitted. Request-correlation identifiers are
 * not credentials and are left to diagnostics, as the outbound registry leaves them.
 */
export function createSynthesizedCopyMask(
  outboundHeaders: Record<string, string>,
  repeatsSentValue = createSentValueGuard(outboundHeaders),
): (text: string) => string {
  const exact = createOutboundCredentialMask(outboundHeaders);
  return (text) => {
    // Error identities are public protocol vocabulary (buffered presentations pass type and code here).
    if (isPublicErrorVocabulary(text)) return text;
    const head = text.length > SENT_VALUE_GUARD_SCAN_CHARS ? text.slice(0, SENT_VALUE_GUARD_SCAN_CHARS) : text;
    return repeatsSentValue(head) ? REDACTED_SECRET : exact(head);
  };
}

/**
 * Mask upstream diagnostics before either SSE delivery or buffered JSON reconstruction. Protocol
 * structure is never masked: the `event:` line, the root `type` and Responses field names stay as
 * they are, so the client always recognizes the frame the inspector saw. An untyped envelope passes
 * through unchanged: no client receives it (every delivery path ends in a terminal boundary or the
 * buffered collector, which withhold it and build the terminal from guarded copy), and the boundary
 * behind the tee rewrite must classify the provider's own frame, exactly as the inspector does.
 */
export function createTerminalErrorRedactionBlockRewrite(
  outboundHeaders: Record<string, string>,
  maskCredential = createOutboundCredentialMask(outboundHeaders),
): SseBlockRewrite {
  // Upstream text under a terminal line that is not a Responses terminal has every sent value masked
  // in place (only the scanned head is emitted), so refusal wording survives for the tee boundary.
  const maskSentValues = createSentValueMask(outboundHeaders, REDACTED_SECRET);
  const guardedText = (text: string): string => maskCredential(maskSentValues(text));
  // `refuseSentValues`: a payload under a terminal event line that is not a Responses terminal is
  // upstream copy throughout, so every string in it that repeats a sent value is withheld whole.
  const redactDiagnostic = (value: unknown, refuseSentValues = false): unknown => {
    const maskKnown = (entry: unknown, root = false): unknown => {
      if (typeof entry === "string") return refuseSentValues ? guardedText(entry) : maskCredential(entry);
      if (Array.isArray(entry)) return entry.map(item => maskKnown(item));
      if (entry && typeof entry === "object") {
        // A key is upstream text too: a rewritten terminal copies extra root fields verbatim. Its
        // sensitivity is decided before masking, which could rename a key such as authorization.
        return Object.fromEntries(Object.entries(entry).map(([key, item]) => [
          PROTOCOL_KEYS.has(key) ? key : refuseSentValues ? guardedText(key) : maskCredential(key),
          SENSITIVE_KEY_PATTERN.test(key) ? REDACTED_SECRET
            : (root && key === "type") || isPublicClassValue(key, item) ? item : maskKnown(item),
        ]));
      }
      return entry;
    };
    // The exact selected credential first: a pattern rule that matches a token inside it (sk-...,
    // Bearer ...) would otherwise split it and leave a prefix the exact mask can no longer find.
    return redactSecrets(maskKnown(value, true));
  };
  // SSE comments and extension fields can also carry upstream text: one that repeats a sent value
  // becomes a redacted comment. The event name and the data payload (already masked structurally)
  // are left as they are.
  const maskExtensionLines = (block: string): string => block
    .split("\n")
    .map(line => /^(?:event|data):/.test(line) ? line : guardedText(line))
    .join("\n");
  // A terminal frame this rewrite cannot restructure (unparsable or non-target JSON) still has its
  // data payload masked, as text; only the event line is left as it is.
  const maskTerminalBlock = (block: string, payload: string | null): string => {
    if (payload === null) return maskExtensionLines(block);
    const masked = guardedText(payload);
    return maskExtensionLines(masked === payload ? block : replaceSseDataPayload(block, masked));
  };
  return (block) => {
    const terminalFrame = /^event:[ \t]*response\.(?:failed|incomplete)[ \t]*\r?$/m.test(block);
    const payload = sseDataPayload(block);
    if (payload === null) return [terminalFrame ? maskTerminalBlock(block, payload) : block];
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      return [terminalFrame ? maskTerminalBlock(block, payload) : block];
    }
    if (isUntypedBareUpstreamError(event)) return [block];
    if (event?.type !== "response.failed" && event?.type !== "response.incomplete") {
      if (!terminalFrame) return [block];
      // A terminal event line over another JSON payload (a typed error, for one) is masked field by
      // field like a terminal, so recognized classes survive for every reader.
      if (!event || typeof event !== "object" || Array.isArray(event)) return [maskTerminalBlock(block, payload)];
      const rewrittenOther = JSON.stringify(redactDiagnostic(event, true));
      return [maskExtensionLines(rewrittenOther === payload ? block : replaceSseDataPayload(block, rewrittenOther))];
    }
    const safeEvent = redactDiagnostic(event);
    const rewritten = JSON.stringify(safeEvent);
    return [maskExtensionLines(rewritten === payload ? block : replaceSseDataPayload(block, rewritten))];
  };
}
