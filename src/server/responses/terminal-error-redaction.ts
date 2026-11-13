import { REDACTED_SECRET, SENSITIVE_KEY_PATTERN, redactSecrets } from "../../lib/redact";
import { CREDENTIAL_SUBSTRING_MIN_LENGTH, credentialComponents, isCredentialName } from "../../lib/outbound-credential-registry";
import { replaceSseDataPayload, sseDataPayload, type SseBlockRewrite } from "../sse-payload-rewrite";
import { isUntypedBareUpstreamError } from "../bare-upstream-error";

/**
 * Mask the selected outbound credential even when upstream echoes only its raw value. A secret
 * containing a quote, backslash or control character appears JSON-escaped inside an SSE payload,
 * so the escaped spelling is masked too. Headers are recognized as credentials by the same rule as
 * the outbound registry (custom names such as x-auth-token included), and every part a server could
 * authenticate with on its own is masked once it is long enough not to occur in copy by chance.
 */
export function createOutboundCredentialMask(outboundHeaders: Record<string, string>): (text: string) => string {
  const knownSecrets = Object.entries(outboundHeaders)
    .filter(([name]) => isCredentialName(name))
    .flatMap(([name, value]) => {
      const credential = /^(?:authorization|proxy-authorization)$/i.test(name)
        ? value.replace(/^\S+\s+/, "")
        : value;
      if (!credential) return [];
      const parts = new Set([credential, ...credentialComponents(value).filter(part => part.length >= CREDENTIAL_SUBSTRING_MIN_LENGTH)]);
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
    return redactSecrets(maskKnown(value));
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
