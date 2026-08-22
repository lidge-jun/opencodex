"use strict";

/**
 * Deterministic second gate for duplicate auto-close.
 *
 * AI may nominate duplicate candidates, but it is never sufficient authority
 * to close an issue. Automatic closure requires an exact shared technical
 * failure signature that is long and specific enough to avoid generic overlap.
 */

const KNOWN_ERRNO =
  "ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EPIPE|EAI_AGAIN|ECONNABORTED|EHOSTUNREACH|ENETUNREACH|EADDRINUSE";

const STRONG_FAILURE_RE = new RegExp([
  "\\bdid not complete\\b",
  "\\bfail(?:s|ed)?\\b",
  "\\bfailure\\b",
  "\\berror\\b",
  "\\bexception\\b",
  "\\bpanic\\b",
  "\\bcrash(?:ed|es|ing)?\\b",
  "\\bsegfault\\b",
  "\\bSIGSEGV\\b",
  "\\btimeout\\b",
  "\\btimed out\\b",
  "\\brefused\\b",
  "\\bdenied\\b",
  "\\bnot supported\\b",
  "\\binvalid\\b",
  `\\b(?:${KNOWN_ERRNO})\\b`,
  "\\b(?:HTTP(?: status(?: code)?)?|status(?: code)?|returns?|returned)\\s*[:=]?\\s*[45]\\d\\d\\b",
].join("|"), "i");

// Generic final summaries are not duplicate proof. Require at least one
// concrete discriminator that normally comes from the underlying failure:
// errno/status, endpoint/path, file name, structured field path, or named
// Error/Exception class.
const SPECIFIC_FAILURE_EVIDENCE_RE = new RegExp([
  `\\b(?:${KNOWN_ERRNO})\\b`,
  "\\b(?:HTTP(?: status(?: code)?)?|status(?: code)?|returns?|returned)\\s*[:=]?\\s*[45]\\d\\d\\b",
  "(?:^|\\s)(?:GET|POST|PUT|PATCH|DELETE|HEAD)\\s+/[^\\s]+",
  "(?:^|[\\s(`])(?:~?/|[A-Za-z]:\\\\)[^\\s)`]+",
  "\\b[\\w.-]+\\.(?:json|toml|yaml|yml|log|conf|env|sqlite|db)\\b",
  // Structured field path (`config.providers.baseUrl`). The negative lookahead
  // excludes SEMANTIC VERSIONS specifically, in both bare and v-prefixed form
  // (`2.19.0`, `v2.19.0`, `2.19.0-preview.1`): naming the same release is not a
  // discriminator, so two unrelated reports sharing only a version would
  // otherwise qualify as an exact shared signature and be auto-closed.
  //
  // It is deliberately narrower than "any numeric dotted token": an IPv4
  // address IS a real discriminator, and is matched by its own alternative
  // below so this exclusion cannot swallow it.
  // The leading `(?<![\w.-])` anchor matters: without it the scan could start
  // mid-version and match the tail of a prerelease (`19.0-preview.1` inside
  // `2.19.0-preview.1`), re-admitting the very token being excluded.
  "(?<![\\w.-])(?!v?\\d+\\.\\d+\\.\\d+(?:[-+][0-9A-Za-z.-]+)?(?![\\w.-]))[\\w-]+(?:\\.[\\w-]+){2,}(?![\\w.-])",
  // Exact IPv4 literal: a specific host/endpoint is legitimate shared evidence.
  "\\b\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\b",
  "\\b[A-Za-z][A-Za-z0-9_.-]*(?:Error|Exception)\\b",
].join("|"), "i");

function normalizeSignatureLine(raw) {
  // Case is PRESERVED. Lowercasing collapsed `Config.toml` and `config.toml`
  // into one signature, so two reports about different files compared equal.
  // Filenames, paths, identifiers, and Error class names are all
  // case-bearing discriminators; the "exact signature" promise is only true
  // if the comparison keeps them distinct.
  return String(raw || "")
    // An UNCLOSED comment hides everything after it through EOF, exactly as the
    // quality parser treats it. Matching only `<!-- ... -->` let hidden text
    // become the "exact shared signature" that closes an issue: two reports
    // whose visible bodies differ could match on text GitHub never renders.
    .replace(/<!--[\s\S]*?(?:-->|$)/g, " ")
    .replace(/^\s*(?:>|[-*+]\s+|\d+[.)]\s+)/, "")
    .replace(/^[`~]{3,}[^\n]*$/, "")
    // Backticks are unambiguous Markdown code delimiters. Preserve `_`, `~`,
    // and `*` because they are also meaningful technical punctuation.
    .replace(/`/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function wordCount(text) {
  return (String(text || "").match(/[\p{L}\p{N}']+/gu) || []).length;
}

function isStrongFailureSignature(line) {
  if (line.length < 36 || line.length > 240) return false;
  if (wordCount(line) < 7) return false;
  if (!STRONG_FAILURE_RE.test(line)) return false;
  return SPECIFIC_FAILURE_EVIDENCE_RE.test(line);
}

function extractStrongFailureSignatures(issue) {
  const text = [issue?.title, issue?.body]
    .filter((value) => typeof value === "string" && value.trim())
    .join("\n");
  const found = new Set();

  for (const rawLine of text.split(/\r?\n/)) {
    const line = normalizeSignatureLine(rawLine);
    if (!isStrongFailureSignature(line)) continue;
    found.add(line);
  }

  return [...found];
}

function compareCodeUnits(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/**
 * Return one auto-close candidate only when:
 * 1. AI nominated the issue as a duplicate; and
 * 2. both live issue bodies contain an exact strong failure signature.
 *
 * Exact line equality is deliberate. Semantic similarity remains advisory.
 * When several nominated issues qualify, prefer the strongest exact evidence
 * globally, not whichever candidate the AI happened to list first.
 */
function selectStrongDuplicateMatch({ currentIssue, candidateIssues, duplicateNumbers }) {
  const nominated = Array.isArray(duplicateNumbers) ? duplicateNumbers.map(String) : [];
  const allowed = new Set(nominated);
  if (!allowed.size) return null;

  const currentIssueNumber = String(currentIssue?.number ?? "");
  const currentSignatures = new Set(extractStrongFailureSignatures(currentIssue));
  if (!currentSignatures.size) return null;

  const candidatesByNumber = new Map(
    (Array.isArray(candidateIssues) ? candidateIssues : [])
      .map((issue) => [String(issue?.number ?? ""), issue])
      .filter(([number]) => /^\d+$/.test(number)),
  );

  const matches = [];
  for (const number of allowed) {
    if (number === currentIssueNumber) continue;
    const candidate = candidatesByNumber.get(number);
    if (!candidate) continue;

    for (const signature of extractStrongFailureSignatures(candidate)) {
      if (!currentSignatures.has(signature)) continue;
      matches.push({ number, signature });
    }
  }

  matches.sort((a, b) =>
    b.signature.length - a.signature.length ||
    compareCodeUnits(a.signature, b.signature) ||
    Number(a.number) - Number(b.number),
  );

  return matches[0] || null;
}

module.exports = {
  STRONG_FAILURE_RE,
  SPECIFIC_FAILURE_EVIDENCE_RE,
  normalizeSignatureLine,
  isStrongFailureSignature,
  extractStrongFailureSignatures,
  selectStrongDuplicateMatch,
};
