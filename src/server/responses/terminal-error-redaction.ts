import { REDACTED_SECRET, SENSITIVE_KEY_PATTERN, redactSecrets } from "../../lib/redact";
import { foldForMatching, NAMED_ENTITY_PLACEHOLDER } from "../../lib/redact-folding";
import { replaceSseDataPayload, sseDataPayload, type SseBlockRewrite } from "../sse-payload-rewrite";

// An exact credential match cannot be proven while undecoded encoding syntax remains.
const UNRESOLVED_ENCODING = /\\["\\/bfnrt]|&#|&[A-Za-z][A-Za-z0-9]{0,31}(?![A-Za-z0-9;=])/;

function maskEncodedCredentials(text: string, secrets: string[]): string {
  let view = text;
  let offsets = Array.from({ length: text.length + 1 }, (_, index) => index);
  for (let depth = 0; depth < 4; depth++) {
    const next = foldForMatching(view);
    // An unresolved named reference has unknown decoded width, so an exact
    // credential match cannot be proven; withhold the diagnostic.
    if (next.folded.includes(NAMED_ENTITY_PLACEHOLDER)) return REDACTED_SECRET;
    if (next.folded === view) break;
    offsets = next.map.map(index => offsets[index]!);
    view = next.folded;
  }
  // Never expose a diagnostic whose encoding exceeds the bounded matching view.
  if (foldForMatching(view).folded !== view) return REDACTED_SECRET;
  if (UNRESOLVED_ENCODING.test(view)) return REDACTED_SECRET;
  const ranges: Array<{ start: number; end: number }> = [];
  for (const secret of secrets) {
    let needle = secret;
    for (let depth = 0; depth < 4; depth++) needle = foldForMatching(needle).folded;
    if (!needle) continue;
    for (let at = view.indexOf(needle); at !== -1; at = view.indexOf(needle, at + 1)) {
      ranges.push({ start: offsets[at]!, end: offsets[at + needle.length]! });
    }
  }
  const merged: typeof ranges = [];
  for (const range of ranges.sort((a, b) => a.start - b.start)) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
    else merged.push(range);
  }
  for (const { start, end } of merged.reverse()) text = text.slice(0, start) + REDACTED_SECRET + text.slice(end);
  return text;
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
    return encodedDiagnostics ? maskEncodedCredentials(safe, knownSecrets) : safe;
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
