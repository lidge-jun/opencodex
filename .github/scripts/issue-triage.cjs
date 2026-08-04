"use strict";

/**
 * Parse + harden duplicate/related triage model output.
 * Related matches are high-noise; prefer empty over weak overlap.
 * Each related entry must carry its own concrete shared-failure reason.
 */

const WEAK_RELATED_REASON_RE =
  /\b(?:somewhat|broadly|loosely|vaguely)\s+related\b|\bboth\s+(?:issues?\s+)?pertain\s+to\s+errors?\b|\bsame\s+(?:client|app)\b|\berrors?\s+in\s+general\b|\bgeneral\s+proxy\s+errors?\b|\bHTTP\s+error\b/i;

/** Well-known errno / syscall failure tokens (allowlist only — never E[A-Z]{4,}). */
const KNOWN_ERRNO_RE =
  /\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EPIPE|EAI_AGAIN|ECONNABORTED|EHOSTUNREACH|ENETUNREACH|EADDRINUSE)\b/;

/**
 * HTTP statuses require status-indicating context so bare issue/PR numbers
 * (e.g. 410, 503 as ticket ids) are not treated as failure evidence.
 */
const HTTP_STATUS_RE =
  /\b(?:(?:HTTP(?:\s+status)?(?:\s+code)?|status(?:\s+code)?)\s+|(?:returns?|returning|got|getting|receive[ds]?|reports?|reporting|code)\s+)([1-5]\d\d)\b/gi;

/** One-sided attribution of a concrete failure to only one issue. */
const ONE_SIDED_ATTRIBUTION_RE =
  /\b(?:only\s+(?:the\s+)?(?:new\s+)?(?:issue|one|first|second|other)|only\s+one|just\s+the\s+(?:first|second|new|other)|(?:issue\s+#?\d+\s+)?alone|appearing\s+only(?:\s+in)?|appears?\s+only(?:\s+in)?|exclusive\s+to|the\s+(?:other|existing(?:\s+issue)?)\s+does\s+not|(?:does|do)\s+not\s+(?:show|report|include|return|have))\b/i;

/**
 * Issue-role attribution between a shared binder and a concrete token means the
 * token is not shared evidence (e.g. "both fail: issue 410 returns HTTP 500").
 */
const ISSUE_SPECIFIC_ATTR_RE =
  /\b(?:issue\s+#?\d+|the\s+(?:new|current|present)\s+issue|this\s+issue|the\s+(?:first|second|other)(?:\s+issue)?)\b/i;

const BOTH_FAILURE_VERB_RE =
  /\bboth(?:\s+issues?)?(?:\s+\w+){0,6}\s+(?:return|report|show|have|hit|fail|reproduce|receive|share)\b/i;

function extractHttpStatuses(text) {
  const found = [];
  const re = new RegExp(HTTP_STATUS_RE.source, "gi");
  let match;
  while ((match = re.exec(String(text || ""))) !== null) {
    found.push(match[1]);
  }
  return [...new Set(found)];
}

function extractErrnoTokens(text) {
  const found = [];
  const copy = new RegExp(KNOWN_ERRNO_RE.source, "g");
  let match;
  while ((match = copy.exec(String(text || ""))) !== null) {
    found.push(match[0].toUpperCase());
  }
  return [...new Set(found)];
}

/**
 * Locate concrete failure signature spans inside a clause.
 * @returns {{ start: number, end: number, text: string }[]}
 */
function findSignatureSpans(text) {
  const spans = [];
  const pushMatches = (re) => {
    const copy = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
    let match;
    while ((match = copy.exec(text)) !== null) {
      spans.push({
        start: match.index,
        end: match.index + match[0].length,
        text: match[0],
      });
    }
  };

  pushMatches(KNOWN_ERRNO_RE);
  pushMatches(HTTP_STATUS_RE);
  pushMatches(/\bField required\b/gi);
  pushMatches(/\bcontent\[\d+\]/g);
  pushMatches(/\b[\w]+\.[\w.]+\.(?:text|content|type)\b/g);

  if (/\b(?:taskkill|ghost\s+LISTEN|listen(?:-|\s)?port)\b/i.test(text) && /\b\d{2,5}\b/.test(text)) {
    const m = text.match(/\b(?:taskkill|ghost\s+LISTEN|listen(?:-|\s)?port)\b/i);
    if (m && m.index != null) {
      spans.push({ start: m.index, end: m.index + m[0].length, text: m[0] });
    }
  }

  spans.sort((a, b) => a.start - b.start || a.end - b.end);
  return spans;
}

function hasConcreteFailureToken(text) {
  return findSignatureSpans(String(text || "")).length > 0
    || (/\breproduc(?:e|es|ed|tion)\b/i.test(text) && /\b(?:when|if|after|on)\b/i.test(text));
}

/**
 * True when the reason attributes distinct concrete failures to different issues.
 */
function hasDistinctFailureSignatures(text) {
  const statuses = extractHttpStatuses(text);
  if (statuses.length > 1) return true;

  const errnos = extractErrnoTokens(text);
  if (errnos.length > 1) return true;

  // Mixed concrete failure types (HTTP status + errno) are not a shared signature.
  if (statuses.length >= 1 && errnos.length >= 1) return true;

  if (/\b(?:the\s+first|one)\b[\s\S]{0,100}\b(?:the\s+second|the\s+other)\b/i.test(text)) {
    return true;
  }
  if (/\bwhereas\b/i.test(text)) return true;
  if (/\brespectively\b/i.test(text)) return true;
  if (/\bwhile\s+(?:the\s+)?(?:other|second|issue)\b/i.test(text)) return true;
  if (/\bone\b[^.]{0,80}\band\s+the\s+other\b/i.test(text)) return true;
  if (/\balone\s+reports\b/i.test(text)) return true;
  if (/\bseparate\s+\d{3}\s+problem\b/i.test(text)) return true;
  if (/\b(?:failures?|root\s+causes?|status(?:es)?|errors?|symptoms?)\s+differ\b/i.test(text)) {
    return true;
  }
  if (/\bdifferent\s+(?:failure|root\s+cause|status|error|problem|symptom)s?\b/i.test(text)) {
    return true;
  }
  return false;
}

/**
 * Require a shared quantifier in the same clause as the concrete signature,
 * with no one-sided attribution between the binder and the token (or immediately
 * after the token). Generic "both fail" + a later one-issue token does not pass.
 */
function clauseBindsSharedToSignature(clause) {
  const signatures = findSignatureSpans(clause);
  if (!signatures.length) {
    // Reproduction phrases count as signatures when shared-bound.
    if (!(/\breproduc(?:e|es|ed|tion)\b/i.test(clause) && /\b(?:when|if|after|on)\b/i.test(clause))) {
      return false;
    }
  }

  const spans = signatures.length
    ? signatures
    : [{ start: clause.search(/\breproduc/i), end: clause.length, text: "repro" }];

  for (const sig of spans) {
    if (sig.start < 0) continue;

    const binders = [];
    const binderRe = /\b(?:both(?:\s+issues?)?|(?:the\s+)?issues?\s+share|share|shared|same|identical(?:ly)?)\b/gi;
    let match;
    while ((match = binderRe.exec(clause)) !== null) {
      if (match.index < sig.start) binders.push(match);
    }

    for (const binder of binders) {
      const between = clause.slice(binder.index, sig.start);
      const trail = clause.slice(sig.end, Math.min(clause.length, sig.end + 72));
      if (ONE_SIDED_ATTRIBUTION_RE.test(between) || ONE_SIDED_ATTRIBUTION_RE.test(trail)) {
        continue;
      }

      const binderText = binder[0];
      if (/^both\b/i.test(binderText)) {
        if (!BOTH_FAILURE_VERB_RE.test(clause.slice(binder.index, sig.end))) continue;
        // Generic "both issues fail/have/show …" must not validate a later
        // issue-specific token (e.g. "issue 410 returns HTTP 500").
        if (ISSUE_SPECIFIC_ATTR_RE.test(between)) continue;
      } else if (/^same$/i.test(binderText)) {
        // "same adapter" is not enough; require same … error/failure/Field required/status.
        if (!/\bsame\b[\s\S]{0,80}\b(?:error|failure|status|fault|exception|signature|Field required|(?:HTTP(?:\s+status)?(?:\s+code)?|status(?:\s+code)?|returns?|got|code)\s+[1-5]\d\d|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EPIPE|EAI_AGAIN|ECONNABORTED|EHOSTUNREACH|ENETUNREACH|EADDRINUSE)\b/i
          .test(clause.slice(binder.index))) {
          continue;
        }
      } else if (/share/i.test(binderText)) {
        if (!/\b(?:share|shared)\b/i.test(between + clause.slice(sig.start, sig.end))) continue;
      }

      return true;
    }
  }
  return false;
}

/**
 * Positive evidence that two issues share a concrete failure signature.
 * The shared comparison must bind directly to the concrete token/description
 * in the same clause; component overlap alone is never enough.
 */
function hasConcreteRelatedSignature(reason) {
  const text = String(reason || "");
  if (!text) return false;
  if (hasDistinctFailureSignatures(text)) return false;

  const clauses = text.split(/[.;]+/).map((part) => part.trim()).filter(Boolean);
  return clauses.some((clause) => clauseBindsSharedToSignature(clause));
}

function sanitizeReason(raw) {
  return String(raw || "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/@/g, "\0AT\0")
    .replace(/[`*_~<>[\]()#|]/g, "")
    .replace(/\0AT\0/g, "(at)")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

function normalizeIssueNumber(entry, { currentNumber, knownNumbers }) {
  const cur = String(currentNumber);
  const known = knownNumbers instanceof Set
    ? knownNumbers
    : new Set((knownNumbers || []).map(String));
  const match = String(entry ?? "").trim().match(/^#?(\d+)$/);
  if (!match) return "";
  const number = match[1];
  if (!number || number === cur || !known.has(number)) return "";
  return number;
}

function normalizeIssueNumbers(value, { currentNumber, knownNumbers }) {
  return [...new Set(
    (Array.isArray(value) ? value : [])
      .map((entry) => normalizeIssueNumber(entry, { currentNumber, knownNumbers }))
      .filter(Boolean),
  )];
}

/**
 * Prefer per-entry {number, reason}. Bare issue-number strings are ignored
 * (shared top-level reasons are ambiguous across multiple related IDs).
 */
function normalizeRelatedEntries(value, { currentNumber, knownNumbers }) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const seen = new Set();
  for (const entry of value) {
    let number = "";
    let reason = "";
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      number = normalizeIssueNumber(entry.number ?? entry.issue ?? entry.id, {
        currentNumber,
        knownNumbers,
      });
      reason = sanitizeReason(entry.reason ?? entry.why ?? "");
    } else {
      // Legacy string / number forms have no per-entry reason — drop them.
      continue;
    }
    if (!number || seen.has(number)) continue;
    seen.add(number);
    out.push({ number, reason });
  }
  return out;
}

function parseAiJson(raw) {
  const text = String(raw || "").trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    try {
      return JSON.parse(
        text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim(),
      );
    } catch {
      return null;
    }
  }
}

/**
 * Validate each related entry independently.
 * Weak shared-client wording without a concrete shared failure is dropped.
 */
function hardenRelatedMatches({ duplicates, related }) {
  const dupes = Array.isArray(duplicates) ? duplicates : [];
  const dupeSet = new Set(dupes.map(String));
  const relatedOut = [];

  for (const entry of Array.isArray(related) ? related : []) {
    const number = String(entry?.number || "");
    if (!number || dupeSet.has(number)) continue;
    const safeReason = sanitizeReason(entry?.reason);
    if (!safeReason || safeReason.length < 24) continue;
    // WEAK_RELATED_REASON_RE alone is insufficient: concrete-signature gating
    // already rejects weak overlap, so a separate weak+!concrete branch is dead.
    if (!hasConcreteRelatedSignature(safeReason)) continue;
    relatedOut.push({ number, reason: safeReason });
    if (relatedOut.length >= 3) break;
  }

  return {
    duplicates: dupes,
    related: relatedOut,
  };
}

function parseTriageMatches(raw, { currentNumber, knownNumbers }) {
  const parsed = parseAiJson(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }

  const duplicates = normalizeIssueNumbers(parsed.duplicates ?? parsed.issues, {
    currentNumber,
    knownNumbers,
  }).slice(0, 5);

  const relatedEntries = normalizeRelatedEntries(parsed.related, {
    currentNumber,
    knownNumbers,
  }).filter((entry) => !duplicates.includes(entry.number));

  const hardened = hardenRelatedMatches({
    duplicates,
    related: relatedEntries,
  });

  const overallReason = sanitizeReason(parsed.reason);

  if (!hardened.duplicates.length && !hardened.related.length) {
    return null;
  }

  return {
    duplicates: hardened.duplicates,
    related: hardened.related,
    reason: overallReason || "Potential matches returned without a reason.",
  };
}

module.exports = {
  WEAK_RELATED_REASON_RE,
  ONE_SIDED_ATTRIBUTION_RE,
  hasDistinctFailureSignatures,
  hasConcreteRelatedSignature,
  hasConcreteFailureToken,
  clauseBindsSharedToSignature,
  findSignatureSpans,
  extractHttpStatuses,
  extractErrnoTokens,
  sanitizeReason,
  normalizeIssueNumber,
  normalizeIssueNumbers,
  normalizeRelatedEntries,
  parseAiJson,
  hardenRelatedMatches,
  parseTriageMatches,
};
