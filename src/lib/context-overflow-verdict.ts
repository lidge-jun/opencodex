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

/** Provider wording that says the conversation has reached/passed its model's context capacity. */
const CONTEXT_WINDOW_POSITION_VERDICTS: readonly RegExp[] = [
  /\b(?:history|conversation|input|prompt|request|turn|messages?)\b[^;!?\n.]{0,120}\b(?:at\s+or\s+past|at\s+(?:the\s+)?limit|past|over|beyond|exceed(?:s|ed|ing)?|reached)\b[^;!?\n.]{0,60}\b(?:(?:the|this|selected|its)\s+)?(?:model(?:'s)?\s+)?context\s+(?:window|length|limit)\b/i,
  // "full" only as the clause's last word: "full of cached tokens", "full size" and "full capacity
  // reached" describe something else.
  /\b(?:model(?:'s)?\s+)?context\s+(?:window|length|limit)\s+(?:(?:is|are|was|were)\s+|(?:has|have)\s+(?:(?:now|already|still)\s+)?been\s+)?(?:(?:now|currently|already|completely|fully|entirely|still)\s+){0,2}(?:full(?=\s*(?:$|[.!?;:,)\n]))|exceed(?:s|ed|ing)?\b|exhausted\b|at\s+its\s+limit\b)/i,
];

/** Explicit provider wording that an input is too long for a model's context capacity. */
const CONTEXT_WINDOW_TOO_LONG_VERDICTS: readonly RegExp[] = [
  /\b(?:prompt|input|request|messages?)\s+(?:is|are|was|were)\s+too\s+long\s+for\b[^;!?\n.]{0,60}\b(?:model(?:'s)?\s+)?context\s+(?:window|length|limit)\b/i,
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
  /\bunsupported\s+parameter\b/i,
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

const NEGATED_CONTEXT_VERDICT = /\b(?:not|no|never|neither|nor)\b|n['\u2019]t\b/i;
const MODAL_PROHIBITION = /\b(?:must|should|shall|may)\s+(?:not|never)\b|\b(?:mustn|shouldn)['\u2019]t\b|\bcan\s*not\b|\bcan['\u2019]t\b|\bcannot\b/i;
const OVERFLOW_COUNT_EVIDENCE = /\b\d+\s*(?:tokens?)?\s*(?:>|exceeds?|past)\s*\d+\b|\b(?:exceeded|exceeds|past|over)\s+(?:the\s+)?(?:limit|maximum|context\s+(?:window|length|limit))\s+by\s+\d+\b/i;

const OVERFLOW_PREDICATE = /\b(?:at\s+or\s+past|at\s+(?:the\s+)?limit|past|over|beyond|exceed(?:s|ed|ing)?|reached|too\s+long|full|exhausted)\b/i;
const CLAUSE_BOUNDARY = /[,():;!?.\n]|\b(?:and|but|because|although|though|while|whereas|since)\b/gi;
/**
 * A parenthetical inserted between a negator and its predicate ("is not (per the tokenizer) past",
 * "never, as far as we can tell, exceeded") does not end the clause: complete parenthesised and
 * comma-paired insertions before the predicate are removed before boundaries are read. A single comma
 * still separates independent clauses ("could not respond, maximum context length exceeded").
 */
function withoutInsertions(text: string): string {
  return text.replace(/\([^()]*\)/g, " ").replace(/,[^,;:!?.\n()]{0,60},/g, " ");
}

/** Negation must describe the matched verdict, not a separate statement earlier in its clause. */
function isNegatedAt(text: string, start: number, end: number): boolean {
  const matchSlice = text.slice(start, end);
  const predMatch = OVERFLOW_PREDICATE.exec(matchSlice);
  // Focus negation checks around the overflow predicate if present, or the matched phrase boundary.
  const predOffset = predMatch ? predMatch.index : 0;
  const predAbsoluteStart = start + predOffset;

  // Check the clause immediately preceding the predicate across clause boundaries.
  const before = withoutInsertions(text.slice(Math.max(0, predAbsoluteStart - 120), predAbsoluteStart));
  const boundaryMatches = Array.from(before.matchAll(CLAUSE_BOUNDARY));
  const lastClauseBoundary = boundaryMatches.length > 0
    ? (boundaryMatches[boundaryMatches.length - 1].index ?? -1) + boundaryMatches[boundaryMatches.length - 1][0].length
    : -1;
  const clauseBefore = lastClauseBoundary !== -1 ? before.slice(lastClauseBoundary) : before;

  // Modal prohibitions ("must not exceed", "should not exceed", "can't exceed", "can not exceed", etc.)
  // describe the limit that was violated rather than asserting the absence of an overflow.
  // Without count evidence that this request actually crossed the limit, a modal rule stays non-overflow.
  if (MODAL_PROHIBITION.test(clauseBefore)) {
    return !OVERFLOW_COUNT_EVIDENCE.test(text);
  }
  if (NEGATED_CONTEXT_VERDICT.test(clauseBefore)
    || /\b(?:in\s+no\s+way|by\s+no\s+means|let\s+alone)\b/i.test(clauseBefore)) {
    return true;
  }

  // Next inspect the predicate clause itself up to the next clause boundary within matchSlice.
  const afterPred = matchSlice.slice(predOffset);
  const nextBoundaryMatch = afterPred.search(CLAUSE_BOUNDARY);
  const predicateClause = nextBoundaryMatch !== -1 ? afterPred.slice(0, nextBoundaryMatch) : afterPred;

  if (MODAL_PROHIBITION.test(predicateClause)) {
    return !OVERFLOW_COUNT_EVIDENCE.test(text);
  }
  const nonModalVerdict = predicateClause
    .replace(new RegExp(MODAL_PROHIBITION.source, "gi"), "");
  if (NEGATED_CONTEXT_VERDICT.test(nonModalVerdict)) return true;

  return false;
}

function hasAffirmedVerdict(text: string, verdict: RegExp): boolean {
  const flags = verdict.flags.includes("g") ? verdict.flags : `${verdict.flags}g`;
  const globalVerdict = new RegExp(verdict.source, flags);
  for (const match of text.matchAll(globalVerdict)) {
    const start = match.index ?? 0;
    if (!isNegatedAt(text, start, start + match[0].length)) return true;
  }
  return false;
}

function hasAffirmedPhrase(text: string, phrase: string): boolean {
  for (let start = text.indexOf(phrase); start !== -1; start = text.indexOf(phrase, start + 1)) {
    if (!isNegatedAt(text, start, start + phrase.length)) return true;
  }
  return false;
}

function isDefiniteContextOverflowMessage(text: string): boolean {
  const normalized = text.toLowerCase();
  return normalized === "context_length_exceeded"
    || DEFINITE_CONTEXT_OVERFLOW_PHRASES.some(phrase => hasAffirmedPhrase(normalized, phrase))
    || CONTEXT_WINDOW_POSITION_VERDICTS.some(verdict => hasAffirmedVerdict(text, verdict))
    || CONTEXT_WINDOW_TOO_LONG_VERDICTS.some(verdict => hasAffirmedVerdict(text, verdict))
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
    const errorObject = record.error && typeof record.error === "object" && !Array.isArray(record.error)
      ? record.error as Record<string, unknown>
      : undefined;
    if (source) {
      if (isParameterValidationRecord(record)
        || (response !== undefined && isParameterValidationRecord(response))
        || (errorObject !== undefined && isParameterValidationRecord(errorObject))
        || isParameterValidationRecord(source)) return false;
      text = (source.message as string).trim();
      continue;
    }
    // Some gateways put their complete diagnostic in a string-valued `error` field rather
    // than the usual `{ error: { message } }` envelope. Read only that bounded leaf; a code
    // elsewhere in the JSON still cannot establish an overflow by itself.
    const errorTextSource = [
      { owner: record, value: record.error },
      ...(response ? [
        { owner: response, value: response.error },
        { owner: response, value: response.last_error },
      ] : []),
      { owner: record, value: record.last_error },
    ].find(candidate => typeof candidate.value === "string");
    if (!errorTextSource || typeof errorTextSource.value !== "string") return false;
    // A string-valued leaf can sit inside `response.error` while the outer envelope carries
    // the validation code, or sit as a top-level `last_error` alongside `response`. Check
    // all records before trusting the leaf's context wording.
    if (isParameterValidationRecord(record)
      || (response !== undefined && isParameterValidationRecord(response))
      || (errorObject !== undefined && isParameterValidationRecord(errorObject))
      || isParameterValidationRecord(errorTextSource.owner)) return false;
    text = errorTextSource.value.trim();
  }
  return false;
}
