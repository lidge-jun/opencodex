/**
 * The definite context-window overflow verdict, shared by combo failover (src/combos/failover.ts,
 * which re-exports it) and the presentation classifier (src/lib/upstream-condition.ts). It has no
 * imports, so the dashboard's type-only use of the classifier never pulls in server modules.
 *
 * The rule is deliberately conservative: a positive verdict needs an overflow predicate attached to
 * a context subject, and it is discarded when a negator governs that predicate. Nothing here reads
 * "a request failed" or "the service is busy" as an overflow -- only wording that says this input
 * did not fit this model's window.
 */

/** A status can carry a verdict about the REQUEST; 401/403/429 speak about the credential. */
const CONTEXT_VERDICT_STATUSES: ReadonlySet<number> = new Set([400, 413, 422]);

/**
 * Phrases a provider emits when the INPUT does not fit this model's context window. These are the
 * verdicts `dev` already matched as substrings, kept at the same reach so a provider that worded its
 * refusal this way keeps failing over. Matched against the innermost provider message only.
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
 * A context subject: the input, or the conversation carrying it. Every generalized verdict below
 * needs one, so capacity prose about a service ("shards exhausted", "service is at capacity")
 * stays non-overflow.
 */
const CONTEXT_SUBJECT = String.raw`(?:history|conversation|input|prompt|request|turn|messages?)`;
/** A context capacity, in the forms providers actually write it. */
const CONTEXT_NOUN = String.raw`(?:model(?:['\u2019]s)?\s+)?context\s+(?:window|length|limit)`;
/** A copula that can sit between a subject or capacity and its predicate. */
const CONTEXT_AUX = String.raw`(?:[ \t]+(?:is|are|was|were|has|have|had))?`;
/**
 * The stretch between a capacity noun and its state predicate, over copulas, participles and
 * adverbs ("has been", "is now completely", "has (already) been"). Parentheticals are allowed
 * anywhere in it, which is why "has (already) been exceeded" reads as a verdict.
 */
const CONTEXT_STATE_LINK = String.raw`(?:[ \t]+(?:is|are|was|were|has|have|had|been|now|currently|already|completely|fully|totally|entirely|still|just|absolutely)|\s*\([^()]*\))*`;

interface OverflowVerdict {
  pattern: RegExp;
  /** 1-based capture group holding the predicate whose negation governs the verdict. */
  predicateGroup: number;
}

/** Wording that says the input is longer than the model's capacity. */
const CONTEXT_WINDOW_TOO_LONG_VERDICT: OverflowVerdict = {
  pattern: new RegExp(
    String.raw`\b(?:prompt|input|request|messages?)\s+(?:is|are|was|were)\s+(too\s+long)\s+for\b[^;!?\n.]{0,60}\b${CONTEXT_NOUN}\b`,
    "i",
  ),
  predicateGroup: 1,
};

/**
 * Wording that says a conversation/input reached or passed its model's context capacity: "its
 * history is at or past the model's context window", "the request has reached the model context
 * length limit". The subject must carry its own predicate and the capacity must follow it closely,
 * so a predicate word in an unrelated clause is not a verdict; the phrase list above still covers
 * the shorter dev-era wordings.
 */
const CONTEXT_WINDOW_POSITION_VERDICT: OverflowVerdict = {
  pattern: new RegExp(
    String.raw`\b${CONTEXT_SUBJECT}\b${CONTEXT_AUX}\s+(?:[a-z'\u2019]+\s+){0,3}?`
      + String.raw`(at\s+or\s+past|at\s+(?:the\s+)?(?:absolute\s+)?limit|past|over|beyond|exceed(?:s|ed|ing)?|reached)\b`
      + String.raw`[ \t]+(?:(?:the|this|that|its|their|our|your|a|an|selected|maximum|allowed|available)\s+){0,2}\b${CONTEXT_NOUN}\b`,
    "i",
  ),
  predicateGroup: 1,
};

/**
 * Wording that puts the context capacity itself into the overflow state: "the model's context window
 * is full", "the context length has been exceeded". Each predicate has to stand on its own, so
 * "full of cached tokens", "full size", "full-duplex" and "context limit exceeded expectations"
 * stay non-overflow.
 */
const CONTEXT_WINDOW_STATE_VERDICTS: readonly OverflowVerdict[] = [
  {
    // "full" closes its clause; a trailing parenthetical ("full (8192 tokens used)") is allowed.
    pattern: new RegExp(
      String.raw`\b${CONTEXT_NOUN}${CONTEXT_STATE_LINK}[ \t]*(full)\b`
        + String.raw`(?=\s*(?:\([^()]*\)\s*)?(?:$|[.!?;:\n]))`,
      "i",
    ),
    predicateGroup: 1,
  },
  {
    pattern: new RegExp(
      String.raw`\b${CONTEXT_NOUN}${CONTEXT_STATE_LINK}[ \t]*(exhausted)\b`,
      "i",
    ),
    predicateGroup: 1,
  },
  {
    pattern: new RegExp(
      String.raw`\b${CONTEXT_NOUN}${CONTEXT_STATE_LINK}[ \t]*(at\s+its\s+limit)\b`,
      "i",
    ),
    predicateGroup: 1,
  },
  {
    // "exceeded" closes the clause (optionally naming the overage); "exceeded expectations" does not.
    pattern: new RegExp(
      String.raw`\b${CONTEXT_NOUN}${CONTEXT_STATE_LINK}[ \t]*(exceed(?:s|ed|ing)?)\b`
        + String.raw`(?=\s*(?:\([^()]*\)\s*)?(?:$|[.!?;:\n,]|\bby\s+\d))`,
      "i",
    ),
    predicateGroup: 1,
  },
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

/**
 * Capacity and availability framing. A "full" verdict inside such prose describes the service, not
 * this turn: "Server busy: the context window is full" and "the context window is full, retry later"
 * are target-level back-pressure, so they keep their cooldown instead of failing over.
 *
 * The predicate's own clause is read with the wide vocabulary, which covers inflections
 * ("retrying", "loaded") and the serving-stack resources that run out under load (KV cache, GPU
 * memory, replicas, workers, pools). What follows the clause (after a semicolon, or the next
 * sentence) is usually the provider's remedy ("Remove older messages before retrying", "consider
 * prompt caching"), so it is read only with the narrow availability vocabulary. On a 5xx the
 * ambiguous predicates never count at all (see `isDefiniteContextOverflow`).
 */
const CAPACITY_FRAMING = /\b(?:busy|overload\w*|capacity|retr(?:y|ies|ied|ying)|try(?:ing)?\s+again|peak\s+hours?|shards?|load\w*|servic\w*|allocat\w*|queu\w*|throttl\w*|cach\w*|kv|gpus?|memory|replicas?|workers?|pools?|scal(?:e|ed|es|ing)|stall\w*)\b/i;
/** Availability wording that marks back-pressure even in the trailing remedy text. */
const TRAILING_CAPACITY_FRAMING = /\b(?:busy|overload\w*|capacity|retry|try\s+again|peak\s+hours?|shards?|load|service|allocation|queue\w*|throttl\w*)\b/i;
/** State predicates that can describe either this input or the service's availability. */
const CAPACITY_AMBIGUOUS_PREDICATES: ReadonlySet<string> = new Set(["full", "exhausted", "at its limit"]);

function isParameterValidationRecord(record: Record<string, unknown>): boolean {
  if (typeof record.code === "string" && PARAMETER_VALIDATION_CODES.has(record.code.toLowerCase())) return true;
  return typeof record.param === "string" && record.param.length > 0 && !CONTEXT_PARAM.test(record.param);
}

/**
 * Negation is read at clause scope around the verdict's predicate. A negator in the same clause as
 * the predicate, before it, denies the verdict: "does not exceed the context window", "never, as
 * far as we can tell, exceeded", "has not been exceeded", "neither ... nor ... exceeded". A
 * negation in an earlier clause ("could not respond, maximum context length exceeded") cannot
 * cancel an overflow reported afterwards, which is the case three review rounds kept regressing.
 */
const NEGATOR = String.raw`(?:\b(?:not|never|no|none|nothing|neither|nor|nobody|without)\b|\b[a-z]+n['\u2019]t\b)`;
/**
 * Punctuation and conjunctions that start a new clause, ending a negator's reach. A full stop
 * counts: "The input is not past the context limit. Maximum context length exceeded instead."
 * negates one sentence and reports the overflow in the next.
 */
const CLAUSE_BREAK = String.raw`[,.;:!?\n]|\b(?:and|but|because|although|though|while|whereas|since)\b`;
/**
 * Curated asides that do not start a new clause: a negator still governs the predicate across
 * "never, as far as we can tell, exceeded" and "does not approach, let alone exceed". Only these
 * phrases are folded away; an arbitrary comma pair still separates clauses, because collapsing one
 * was what turned a negated first clause into an overflow verdict. Each aside is matched as whole
 * words: an unbounded `ever` would fold the negator out of "never" ("The input never exceeded the
 * context window") and read the prohibition as an overflow report.
 */
const NEGATION_ASIDE = String.raw`(?:in\s+fact|actually|ever|really|truly|yet|appear\s+to|seem\s+to|as\s+far\s+as\s+(?:we|i)\s+can\s+tell|per\s+(?:our\s+checks|the\s+tokenizer))`;
const NEGATION_ASIDE_PATTERN = new RegExp(`\\s*,?\\s*\\b${NEGATION_ASIDE}\\b\\s*,?\\s*`, "gi");
const LET_ALONE_PATTERN = /\s*,?\s*(?:approach|come\s+close\s+to)?\s*,?\s*let\s+alone\s*,?\s*/gi;

/** A count that shows this request crossed the limit, which overrides a modal prohibition. */
const OVERFLOW_COUNT_EVIDENCE = /\b\d+\s*(?:tokens?)?\s*(?:>|exceeds?|past)\s*\d+\b|\b(?:exceeded|exceeds|past|over)\s+(?:the\s+)?(?:limit|maximum|context\s+(?:window|length|limit))\s+by\s+\d+\b/i;
/** A rule about the limit ("must not exceed") rather than a report that this request crossed it. */
const MODAL_PROHIBITION = /\b(?:must|should|shall|may)\s+(?:not|never)\b|\b(?:mustn|shouldn)['\u2019]t\b|\bcan(?:not|['\u2019]t)\b/i;

/** How far before a predicate its clause is read. */
const NEGATION_LOOKBEHIND = 120;

/**
 * True when a negator governs the predicate at `predicateStart`. A modal prohibition ("must not
 * exceed") keeps the verdict only when the text also carries count evidence that this request
 * crossed the limit: "Total tokens must not exceed the context window: 9000 > 8192" reports an
 * overflow, while "the input must not exceed the model context window" states a rule.
 *
 * Parenthetical content is not part of the surrounding clause, so "not (per the tokenizer) beyond"
 * keeps its negator and "No compression applied (maximum context length exceeded)" starts a fresh
 * clause at the opening parenthesis instead of inheriting "No".
 */
function isNegatedBefore(text: string, predicateStart: number): boolean {
  let window = text.slice(Math.max(0, predicateStart - NEGATION_LOOKBEHIND), predicateStart)
    .replace(/\([^()]*\)/g, " ")
    .replace(NEGATION_ASIDE_PATTERN, " ")
    .replace(LET_ALONE_PATTERN, " ");
  const openParenthesis = window.lastIndexOf("(");
  if (openParenthesis > window.lastIndexOf(")")) window = window.slice(openParenthesis + 1);
  const boundary = new RegExp(CLAUSE_BREAK, "gi");
  let clauseStart = 0;
  for (const match of window.matchAll(boundary)) clauseStart = (match.index ?? 0) + match[0].length;
  const clause = window.slice(clauseStart);
  if (MODAL_PROHIBITION.test(clause)) return !OVERFLOW_COUNT_EVIDENCE.test(text);
  return new RegExp(NEGATOR, "i").test(clause);
}

/**
 * Capacity framing around an ambiguous verdict at `index`. The predicate's own clause (sentence
 * start to the next `;` or sentence end) is checked with the wide vocabulary; the rest of that
 * sentence and the next one with the narrow one, because back-pressure often arrives split across
 * two sentences ("The context window is full. Please retry later.") while a remedy does too.
 */
function hasCapacityFraming(text: string, index: number): boolean {
  const before = text.slice(0, index);
  const start = Math.max(before.lastIndexOf("."), before.lastIndexOf("!"), before.lastIndexOf("?"), before.lastIndexOf("\n")) + 1;
  const clauseEnd = /[;.!?\n]/.exec(text.slice(index));
  const clauseStop = clauseEnd === null ? text.length : index + (clauseEnd.index ?? 0);
  if (CAPACITY_FRAMING.test(text.slice(start, clauseStop))) return true;
  const firstEnd = /[.!?\n]/.exec(text.slice(index));
  const resume = firstEnd === null ? text.length : index + (firstEnd.index ?? 0) + 1;
  const secondEnd = /[.!?\n]/.exec(text.slice(resume));
  const end = secondEnd === null ? text.length : resume + (secondEnd.index ?? 0) + 1;
  return TRAILING_CAPACITY_FRAMING.test(text.slice(clauseStop, end));
}

function hasAffirmedVerdict(text: string, verdict: OverflowVerdict, allowAmbiguous: boolean): boolean {
  const flags = verdict.pattern.flags.includes("g") ? verdict.pattern.flags : `${verdict.pattern.flags}g`;
  const pattern = new RegExp(verdict.pattern.source, flags);
  for (const match of text.matchAll(pattern)) {
    const predicate = match[verdict.predicateGroup];
    if (predicate === undefined) continue;
    const predicateStart = (match.index ?? 0) + match[0].indexOf(predicate);
    if (isNegatedBefore(text, predicateStart)) continue;
    // "full", "exhausted" and "at its limit" are ambiguous between an input overflow and service
    // back-pressure. They count only on a status that speaks about the request, and only when the
    // text around the predicate is free of capacity framing.
    // The predicate pattern allows any whitespace ("at  its\tlimit"), so normalize it before the
    // set lookup or a reflowed message would bypass the 5xx rule.
    if (CAPACITY_AMBIGUOUS_PREDICATES.has(predicate.toLowerCase().replace(/\s+/g, " "))
      && (!allowAmbiguous || hasCapacityFraming(text, predicateStart))) continue;
    return true;
  }
  return false;
}

function hasAffirmedPhrase(text: string, phrase: string): boolean {
  const pattern = new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
  for (const match of text.matchAll(pattern)) {
    if (!isNegatedBefore(text, match.index ?? 0)) return true;
  }
  return false;
}

function isDefiniteContextOverflowMessage(text: string, allowAmbiguous = true): boolean {
  const normalized = text.toLowerCase();
  return normalized === "context_length_exceeded"
    || DEFINITE_CONTEXT_OVERFLOW_PHRASES.some(phrase => hasAffirmedPhrase(text, phrase))
    || hasAffirmedVerdict(text, CONTEXT_WINDOW_POSITION_VERDICT, allowAmbiguous)
    || hasAffirmedVerdict(text, CONTEXT_WINDOW_TOO_LONG_VERDICT, allowAmbiguous)
    || CONTEXT_WINDOW_STATE_VERDICTS.some(verdict => hasAffirmedVerdict(text, verdict, allowAmbiguous))
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
 *
 * On a 5xx the ambiguous state predicates ("full", "exhausted", "at its limit") never count: a
 * server error that says the context window is exhausted is far more often KV-cache or capacity
 * back-pressure than this turn being too large, and a hop there would skip the target cooldown.
 */
export function isDefiniteContextOverflow(status: number, message: string, matchMessage?: (text: string) => boolean): boolean {
  if (!CONTEXT_VERDICT_STATUSES.has(status) && status < 500) return false;
  if (message.length > 16_384) return false;
  const matches = matchMessage ?? ((leaf: string) => isDefiniteContextOverflowMessage(leaf, status < 500));
  let text = message.trim();
  // One pass per unwrapped envelope, plus one for the leaf the last envelope yields.
  for (let unwrapped = 0; unwrapped <= MAX_CONTEXT_OVERFLOW_ENVELOPES; unwrapped += 1) {
    const providerPrefix = /^Provider error \d{3}:\s*/.exec(text);
    if (providerPrefix) text = text.slice(providerPrefix[0].length).trim();
    if (!text.startsWith("{")) return !PARAMETER_VALIDATION_MARKERS.some(marker => marker.test(text)) && matches(text);
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
