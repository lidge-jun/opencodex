/**
 * The definite context-window overflow verdict, shared by combo failover (src/combos/failover.ts,
 * which re-exports it) and the presentation classifier (src/lib/upstream-condition.ts). It has no
 * imports, so the dashboard's type-only use of the classifier never pulls in server modules.
 */

/** A status can carry a verdict about the REQUEST; 401/403/429 speak about the credential. */
const CONTEXT_VERDICT_STATUSES: ReadonlySet<number> = new Set([400, 413, 422]);

/**
 * Phrases a provider emits when the INPUT does not fit this model's context window. Matched
 * against the innermost provider message only, so an unrelated refusal that merely quotes one
 * of these tokens in a code field cannot authorize a replay.
 */
const DEFINITE_CONTEXT_OVERFLOW_PHRASES = [
  "exceeds the context window",
  "exceed the context window",
  "context window exceeded",
  "context length exceeded",
  "maximum context length",
  "maximum context window",
  "too many tokens",
];

/**
 * Short provider verdicts that a validation error could otherwise echo as the caller's own value
 * (#7443). Each counts only at the very start of the provider's leaf message, after JSON envelopes
 * are unwrapped, and Anthropic's only with its token counts. Text that merely contains one, including
 * a serialized SDK exception or a quoted caller object, is not evidence: only the phrases dev already
 * matched as substrings keep that wider reach.
 */
const ANCHORED_CONTEXT_OVERFLOW_VERDICTS: readonly RegExp[] = [
  /^prompt is too long: \d+ tokens > \d+ maximum/i,
  /^input is too long for requested model\b/i,
  /^please reduce the length of the messages or completion\b/i,
];

/** Wrapper envelopes unwrapped before the leaf message is read. */
const MAX_CONTEXT_OVERFLOW_ENVELOPES = 4;

/**
 * Parameter validation echoes the caller's own value, so its prose is not a context verdict even
 * when the value reads like one: "Invalid 'tools[0].function.name': 'prompt is too long'". These
 * markers are read anywhere in the text, so an SDK error wrapper that serializes such a record as a
 * Python dict is refused too, while a quoted genuine verdict in the same wrapper stays evidence.
 */
const CONTEXT_PARAM_NAMES = "messages|input|input_text|input_tokens|prompt|contents?|max_tokens|max_completion_tokens|max_output_tokens";
/** A `param` naming the conversation or a token budget is consistent with an overflow. */
const CONTEXT_PARAM = new RegExp(`^(?:${CONTEXT_PARAM_NAMES})(?:$|[.[])`, "i");
const PARAMETER_VALIDATION_CODES: ReadonlySet<string> = new Set(["invalid_value", "invalid_type"]);
const PARAMETER_VALIDATION_MARKERS: readonly RegExp[] = [
  /\binvalid_(?:value|type)\b/i,
  new RegExp(`['"]param['"]\\s*:\\s*['"](?!(?:${CONTEXT_PARAM_NAMES})(?:['".[]))`, "i"),
  /\binvalid\s+(?:value\s+for\s+)?['"`\u2018\u201c]/i,
  /\binvalid\s+(?:tool|function|parameter|argument|field|value)\b/i,
  /\binput_value\s*=/i,
  /\bvalidation errors? for\b/i,
];

function isParameterValidationRecord(record: Record<string, unknown>): boolean {
  if (typeof record.code === "string" && PARAMETER_VALIDATION_CODES.has(record.code.toLowerCase())) return true;
  return typeof record.param === "string" && record.param.length > 0 && !CONTEXT_PARAM.test(record.param);
}

function isDefiniteContextOverflowMessage(text: string): boolean {
  const normalized = text.toLowerCase();
  return normalized === "context_length_exceeded"
    || DEFINITE_CONTEXT_OVERFLOW_PHRASES.some(phrase => normalized.includes(phrase))
    || ANCHORED_CONTEXT_OVERFLOW_VERDICTS.some(verdict => verdict.test(text.trim()));
}

/**
 * Confirm a context overflow from the provider MESSAGE rather than from a code token that
 * merely appears somewhere in the envelope. An upstream controls both fields and can emit a
 * contradictory pair -- `context_length_exceeded` beside `Unsupported parameter: user` -- and
 * that is not evidence the turn is too large for this model. `classifyError` reads the whole
 * blob, which is exactly the looseness this must not inherit.
 *
 * A JSON-shaped body that fails to parse is truncated or corrupt, not prose: `classificationText`
 * is capped at 500 characters by `normalizeUpstreamErrorText` before it reaches this function, so
 * a long envelope arrives here as a JSON prefix. Reading that prefix as plain text would let an
 * arbitrary field that happens to sit in the first 500 bytes authorize a hop, so it fails closed.
 *
 * Only the exact proxy wrapper is unwrapped, within a fixed envelope budget and 16,384 characters.
 * An optional caller matcher specializes the verdict on the unwrapped, validated leaf.
 * Exported for the sidecar loops, which classify their own provider failures with the same rule.
 */
export function isDefiniteContextOverflow(status: number, message: string, matchMessage = isDefiniteContextOverflowMessage): boolean {
  if (!CONTEXT_VERDICT_STATUSES.has(status) && status < 500) return false;
  if (message.length > 16_384) return false;
  let text = message.trim();
  // One pass per unwrapped envelope, plus one for the leaf the last envelope yields.
  for (let unwrapped = 0; unwrapped <= MAX_CONTEXT_OVERFLOW_ENVELOPES; unwrapped += 1) {
    const providerPrefix = /^Provider error \d{3}:\s*/.exec(text);
    if (providerPrefix) text = text.slice(providerPrefix[0].length).trim();
    if (!text.startsWith("{")) return !PARAMETER_VALIDATION_MARKERS.some(marker => marker.test(text)) && matchMessage(text);
    if (unwrapped === MAX_CONTEXT_OVERFLOW_ENVELOPES) return false;
    let payload: unknown;
    try { payload = JSON.parse(text); } catch { return false; }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
    const record = payload as Record<string, unknown>;
    const response = record.response && typeof record.response === "object" && !Array.isArray(record.response)
      ? record.response as Record<string, unknown>
      : undefined;
    const source = [record.error, response?.error, response?.last_error, record.last_error, record]
      .find((candidate): candidate is Record<string, unknown> =>
        !!candidate && typeof candidate === "object" && !Array.isArray(candidate)
        && typeof (candidate as Record<string, unknown>).message === "string");
    if (!source || isParameterValidationRecord(source)) return false;
    text = (source.message as string).trim();
  }
  return false;
}
