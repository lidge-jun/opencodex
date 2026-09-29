import { REDACTED_SECRET, SENSITIVE_KEY_PATTERN, redactSecrets } from "../../lib/redact";
import { replaceSseDataPayload, sseDataPayload, type SseBlockRewrite } from "../sse-payload-rewrite";

/** Mask upstream diagnostics before either SSE delivery or buffered JSON reconstruction. */
export function createTerminalErrorRedactionBlockRewrite(outboundHeaders: Record<string, string>): SseBlockRewrite {
  const knownSecrets = Object.entries(outboundHeaders)
    .filter(([name]) => SENSITIVE_KEY_PATTERN.test(name))
    .flatMap(([name, value]) => {
      const credential = /^(?:authorization|proxy-authorization)$/i.test(name)
        ? value.replace(/^\S+\s+/, "")
        : value;
      return credential ? [credential] : [];
    })
    .sort((a, b) => b.length - a.length);
  const redactDiagnostic = (value: unknown): unknown => {
    const safe = redactSecrets(value);
    const maskKnown = (entry: unknown): unknown => {
      if (typeof entry === "string") {
        return knownSecrets.reduce((text, secret) => text.replaceAll(secret, REDACTED_SECRET), entry);
      }
      if (Array.isArray(entry)) return entry.map(maskKnown);
      if (entry && typeof entry === "object") {
        return Object.fromEntries(Object.entries(entry).map(([key, item]) => [key, maskKnown(item)]));
      }
      return entry;
    };
    return maskKnown(safe);
  };
  return (block) => {
    const payload = sseDataPayload(block);
    if (payload === null) return [block];
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      return [block];
    }
    if (event?.type !== "response.failed" && event?.type !== "response.incomplete") return [block];
    const response = event.response;
    if (!response || typeof response !== "object" || Array.isArray(response)) return [block];
    const safeResponse = { ...response } as Record<string, unknown>;
    for (const key of ["error", "last_error", "incomplete_details"]) {
      if (key in safeResponse) safeResponse[key] = redactDiagnostic(safeResponse[key]);
    }
    const safeEvent: Record<string, unknown> = { ...event, response: safeResponse };
    for (const key of ["error", "last_error"]) {
      if (key in safeEvent) safeEvent[key] = redactDiagnostic(safeEvent[key]);
    }
    const rewritten = JSON.stringify(safeEvent);
    return [rewritten === payload ? block : replaceSseDataPayload(block, rewritten)];
  };
}
