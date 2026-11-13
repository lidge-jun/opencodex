import { REDACTED_SECRET, SENSITIVE_KEY_PATTERN, redactSecrets } from "../../lib/redact";
import { CREDENTIAL_SUBSTRING_MIN_LENGTH, credentialComponents, outboundCredentials } from "../../lib/outbound-credential-registry";
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
 * Mask the selected outbound credential even when upstream echoes only its raw value. A secret
 * containing a quote, backslash or control character appears JSON-escaped inside an SSE payload,
 * so the escaped spelling is masked too. Custom credential headers count as well as the fixed list,
 * and every part a server could authenticate with on its own is masked once it is long enough not
 * to occur in copy by chance and is not a protocol word, so masking never rewrites an event name,
 * a `type` or a field name of the frame it protects. The full credential is masked at any length.
 */
export function createOutboundCredentialMask(outboundHeaders: Record<string, string>): (text: string) => string {
  const knownSecrets = Object.entries(outboundHeaders)
    .filter(([name]) => SENSITIVE_KEY_PATTERN.test(name) || CREDENTIAL_HEADER_SEGMENT.test(name))
    .flatMap(([name, value]) => {
      const credential = /^(?:authorization|proxy-authorization)$/i.test(name)
        ? value.replace(/^\S+\s+/, "")
        : value;
      if (!credential) return [];
      const parts = new Set([credential, ...credentialComponents(value)
        .filter(part => part.length >= CREDENTIAL_SUBSTRING_MIN_LENGTH && !PROTOCOL_WORD.test(part))]);
      return [...parts].flatMap(part => {
        const escaped = JSON.stringify(part).slice(1, -1);
        return escaped === part ? [part] : [part, escaped];
      });
    })
    .sort((a, b) => b.length - a.length);
  return (text) => knownSecrets.reduce((safe, secret) => safe.replaceAll(secret, REDACTED_SECRET), text);
}

/** Mask upstream diagnostics before either SSE delivery or buffered JSON reconstruction. */
export function createTerminalErrorRedactionBlockRewrite(
  outboundHeaders: Record<string, string>,
  maskCredential = createOutboundCredentialMask(outboundHeaders),
): SseBlockRewrite {
  const redactDiagnostic = (value: unknown): unknown => {
    const maskKnown = (entry: unknown): unknown => {
      if (typeof entry === "string") return maskCredential(entry);
      if (Array.isArray(entry)) return entry.map(maskKnown);
      if (entry && typeof entry === "object") {
        // A key is upstream text too: a rewritten terminal copies extra root fields verbatim. Its
        // sensitivity is decided before masking, which could rename a key such as authorization.
        return Object.fromEntries(Object.entries(entry).map(([key, item]) => [
          maskCredential(key),
          SENSITIVE_KEY_PATTERN.test(key) ? REDACTED_SECRET : maskKnown(item),
        ]));
      }
      return entry;
    };
    // The exact selected credential first: a pattern rule that matches a token inside it (sk-...,
    // Bearer ...) would otherwise split it and leave a prefix the exact mask can no longer find.
    const masked = maskKnown(value);
    return redactSecrets(isUntypedBareUpstreamError(value) ? guardUntypedDiagnostics(masked as Record<string, unknown>) : masked);
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
    if (event?.type !== "response.failed" && event?.type !== "response.incomplete" && !isUntypedBareUpstreamError(event)) {
      return [terminalFrame ? maskCredential(block) : block];
    }
    const safeEvent = redactDiagnostic(event);
    const rewritten = JSON.stringify(safeEvent);
    // SSE comments and extension fields can also carry upstream text.
    return [maskCredential(rewritten === payload ? block : replaceSseDataPayload(block, rewritten))];
  };
}

/**
 * An untyped envelope's diagnostic records hold the same guard as the bare-verdict copy built from
 * them: every value this process sent upstream, by the outbound registry's coverage (credential-named
 * headers, other headers at 8+ characters, Basic halves and parameter values), is masked inside each
 * string. The rest of the copy survives, so the relay's tail still reads the provider's refusal
 * wording and codes from the rewritten frame. Only error records are guarded, so the frame's own
 * fields and names stay intact.
 */
function guardUntypedDiagnostics(event: Record<string, unknown>): Record<string, unknown> {
  const registry = outboundCredentials();
  const guard = (entry: unknown): unknown => {
    if (typeof entry === "string") return registry.mask(entry, REDACTED_SECRET);
    if (Array.isArray(entry)) return entry.map(guard);
    if (entry && typeof entry === "object") return Object.fromEntries(Object.entries(entry).map(([key, item]) => [key, guard(item)]));
    return entry;
  };
  return {
    ...event,
    ...(event.error !== undefined ? { error: guard(event.error) } : {}),
    ...(event.last_error !== undefined ? { last_error: guard(event.last_error) } : {}),
  };
}
