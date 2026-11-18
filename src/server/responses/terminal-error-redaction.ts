import { REDACTED_SECRET, SENSITIVE_KEY_PATTERN, redactSecretString, redactSecrets } from "../../lib/redact";
import {
  CREDENTIAL_SUBSTRING_MIN_LENGTH,
  SENT_VALUE_GUARD_SCAN_CHARS,
  SecretIndex,
  createSentValueGuard,
  createSentValueMask,
  credentialComponents,
  maskSecretSpans,
} from "../../lib/outbound-credential-registry";
import { replaceSseDataPayload, sseDataPayload, type SseBlockRewrite } from "../sse-payload-rewrite";
import { isUntypedBareUpstreamError } from "../bare-upstream-error";
import { CYBER_POLICY_ERROR_CODE, isCyberPolicyCode, isCyberPolicyMessage, isTerminalRefusalCode, recognizedUpstreamError } from "../../lib/errors";

/**
 * A custom header carries a credential when a credential word is a whole segment of its name
 * (x-auth-token, x-proxy-secret), so a name that merely contains one (x-author) is not swept in.
 */
const CREDENTIAL_HEADER_SEGMENT = /(?:^|[-_])(?:api[-_]?key|secret|passwd|password|credentials?|auth|token)(?:$|[-_])/i;
/** A split-out part made only of letters, dots and underscores reads as protocol vocabulary (response, type). */
const PROTOCOL_WORD = /^[A-Za-z._]+$/;
/** An SSE event line naming a protocol event, which masking never rewrites. */
const PROTOCOL_EVENT_LINE = /^event:[ \t]*(?:response\.[a-z_.]+|error|done|ping)[ \t]*\r?$/;
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
 * Masking can remove the copy that makes a genuine terminal a policy refusal (policy wording that
 * overlaps a credential). The terminal boundary behind the tee rewrite must still reach the verdict
 * the eager boundary and the inspector reach from the original, so a record whose policy evidence
 * masking removed carries the policy code instead. Nothing of the masked copy is restored.
 */
function keepPolicyEvidence(original: unknown, masked: unknown): unknown {
  const record = (value: unknown): Record<string, unknown> | undefined =>
    value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  const isPolicy = (entry: Record<string, unknown> | undefined): boolean => !!entry && (
    isCyberPolicyCode(typeof entry.code === "string" ? entry.code : undefined)
    || (typeof entry.message === "string" && isCyberPolicyMessage(entry.message)));
  const pick = (root: unknown): Array<Record<string, unknown> | undefined> => {
    const top = record(root);
    const response = record(top?.response);
    return [record(top?.error), record(top?.last_error), record(response?.error), record(response?.incomplete_details)];
  };
  const before = pick(original);
  const after = pick(masked);
  if (after.some(isPolicy)) return masked;
  const index = before.findIndex(isPolicy);
  if (index < 0 || after[index] === undefined) return masked;
  after[index]!.code = CYBER_POLICY_ERROR_CODE;
  return masked;
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
  // Indexed once per request: masking each string of a frame is then linear in that string alone.
  const index = new SecretIndex(secrets);
  return (text) => maskSecretSpans(text, REDACTED_SECRET, index);
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
 * The redaction helpers one request's rewrite and terminal boundary share. Protocol structure is never
 * masked: the `event:` line, the root `type`, Responses field names and recognized error classes stay
 * as they are, so the client always recognizes the frame the inspector saw.
 */
function createRedactionTools(outboundHeaders: Record<string, string>, maskCredential: (text: string) => string) {
  // Upstream copy that is not a Responses terminal has every sent value masked in place (only the
  // scanned head is emitted), so refusal wording a reader classifies survives.
  const maskSentValues = createSentValueMask(outboundHeaders, REDACTED_SECRET);
  // Whole credentials first, then the pattern rules, then excerpts: an excerpt window shared with
  // another credential, or one inside a "Bearer <token>" the pattern rules recognize, would otherwise
  // split it and leave a remainder neither the exact mask nor the pattern rules can find.
  const guardedText = (text: string): string => maskSentValues(redactSecretString(maskCredential(text)));
  // A genuine terminal is masked for every excerpt of a sent credential too, never for other header
  // values (ordinary text there), and never cut: its output must reach the client whole.
  const maskCredentialExcerpts = createSentValueMask(outboundHeaders, REDACTED_SECRET, { credentialOnly: true, wholeText: true });
  const credentialText = (text: string): string => maskCredentialExcerpts(redactSecretString(maskCredential(text)));
  // `refuseSentValues`: a payload that is upstream copy throughout masks every sent value in its
  // strings and non-protocol keys, not only the selected credentials.
  const redactDiagnostic = (value: unknown, refuseSentValues = false): unknown => {
    // A number is upstream text too once serialized: one that repeats a sent value is dropped from
    // an object (keeping every field's type valid) and replaced inside an array.
    const numberMask = refuseSentValues ? maskSentValues : maskCredentialExcerpts;
    const repeatsSentNumber = (entry: unknown): boolean => typeof entry === "number" && numberMask(String(entry)) !== String(entry);
    const maskKnown = (entry: unknown, root = false): unknown => {
      if (typeof entry === "string") return refuseSentValues ? guardedText(entry) : credentialText(entry);
      if (Array.isArray(entry)) return entry.map(item => repeatsSentNumber(item) ? REDACTED_SECRET : maskKnown(item));
      if (entry && typeof entry === "object") {
        // A key is upstream text too: a rewritten terminal copies extra root fields verbatim. Its
        // sensitivity is decided before masking, which could rename a key such as authorization.
        return Object.fromEntries(Object.entries(entry).filter(([, item]) => !repeatsSentNumber(item)).map(([key, item]) => [
          PROTOCOL_KEYS.has(key) ? key : refuseSentValues ? guardedText(key) : credentialText(key),
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
  // SSE comments and extension fields can also carry upstream text. A protocol event name and the
  // data payload (already masked structurally) are left as they are; any other event name is
  // provider text and is masked like the rest.
  // Lines end in CRLF, CR or LF as the SSE parser accepts them; each separator is kept as it was.
  const maskExtensionLines = (block: string): string => block
    .split(/(\r\n|\r|\n)/)
    .map((line, index) => {
      if (index % 2 === 1 || /^data:/.test(line) || PROTOCOL_EVENT_LINE.test(line)) return line;
      const event = /^event:[ \t]*/.exec(line);
      return event ? `${event[0]}${guardedText(line.slice(event[0].length))}` : guardedText(line);
    })
    .join("");
  // A frame that cannot be restructured (unparsable or non-object JSON) has its data masked as text.
  const maskUnstructuredBlock = (block: string, payload: string | null): string => {
    if (payload === null) return maskExtensionLines(block);
    const masked = guardedText(payload);
    return maskExtensionLines(masked === payload ? block : replaceSseDataPayload(block, masked));
  };
  // Upstream copy throughout (a non-terminal payload under a terminal line, a forwarded typed error).
  const redactUpstreamCopyBlock = (block: string, payload: string | null, event: unknown): string => {
    if (payload === null || !event || typeof event !== "object" || Array.isArray(event)) return maskUnstructuredBlock(block, payload);
    const rewritten = JSON.stringify(redactDiagnostic(event, true));
    return maskExtensionLines(rewritten === payload ? block : replaceSseDataPayload(block, rewritten));
  };
  return { redactDiagnostic, maskExtensionLines, maskUnstructuredBlock, redactUpstreamCopyBlock };
}

/**
 * Redaction the terminal boundary applies to a typed bare `error` frame it forwards to the client,
 * after it has reduced the frame's verdict from the original. Running it inside the boundary keeps
 * classification on the provider's own words on both relays; the client still never receives a sent
 * value from the frame.
 */
export function createForwardedEvidenceRedaction(
  outboundHeaders: Record<string, string>,
  maskCredential = createOutboundCredentialMask(outboundHeaders),
): (block: string) => string {
  const { redactUpstreamCopyBlock } = createRedactionTools(outboundHeaders, maskCredential);
  return (block) => {
    const payload = sseDataPayload(block);
    let event: unknown;
    try { event = payload === null ? undefined : JSON.parse(payload); } catch { event = undefined; }
    return redactUpstreamCopyBlock(block, payload, event);
  };
}

/**
 * Mask upstream diagnostics before either SSE delivery or buffered JSON reconstruction. Bare evidence
 * passes through unchanged: an untyped envelope reaches no client (every delivery path ends in a
 * terminal boundary or the buffered collector, which withhold it and build the terminal from guarded
 * copy), and a typed `error` frame is redacted by the boundary after it is classified
 * ({@link createForwardedEvidenceRedaction}), so the boundary behind the tee rewrite classifies the
 * provider's own frame exactly as the inspector does.
 */
export function createTerminalErrorRedactionBlockRewrite(
  outboundHeaders: Record<string, string>,
  maskCredential = createOutboundCredentialMask(outboundHeaders),
): SseBlockRewrite {
  const { redactDiagnostic, maskExtensionLines, maskUnstructuredBlock, redactUpstreamCopyBlock } = createRedactionTools(outboundHeaders, maskCredential);
  return (block) => {
    const terminalFrame = /^event:[ \t]*response\.(?:failed|incomplete)[ \t]*\r?$/m.test(block);
    const payload = sseDataPayload(block);
    if (payload === null) return [terminalFrame ? maskUnstructuredBlock(block, payload) : block];
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      return [terminalFrame ? maskUnstructuredBlock(block, payload) : block];
    }
    if (isUntypedBareUpstreamError(event) || event?.type === "error") return [block];
    if (event?.type !== "response.failed" && event?.type !== "response.incomplete") {
      // A terminal event line over another JSON payload is upstream copy throughout, masked field by
      // field so recognized classes survive for every reader.
      return [terminalFrame ? redactUpstreamCopyBlock(block, payload, event) : block];
    }
    const safeEvent = keepPolicyEvidence(event, redactDiagnostic(event));
    const rewritten = JSON.stringify(safeEvent);
    return [maskExtensionLines(rewritten === payload ? block : replaceSseDataPayload(block, rewritten))];
  };
}
