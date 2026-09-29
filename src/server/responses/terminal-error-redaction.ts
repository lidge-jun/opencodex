import { REDACTED_SECRET, SENSITIVE_KEY_PATTERN, redactSecrets } from "../../lib/redact";
import { replaceSseDataPayload, sseDataPayload, type SseBlockRewrite } from "../sse-payload-rewrite";

/** Mask the selected outbound credential even when upstream echoes only its raw value. */
export function createOutboundCredentialMask(outboundHeaders: Record<string, string>): (text: string) => string {
  const knownSecrets = Object.entries(outboundHeaders)
    .filter(([name]) => SENSITIVE_KEY_PATTERN.test(name))
    .flatMap(([name, value]) => {
      const credential = /^(?:authorization|proxy-authorization)$/i.test(name)
        ? value.replace(/^\S+\s+/, "")
        : value;
      return credential ? [credential] : [];
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
