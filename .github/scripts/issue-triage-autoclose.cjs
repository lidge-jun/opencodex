"use strict";

/**
 * Deterministic second gate for duplicate auto-close.
 *
 * AI may nominate duplicate candidates, but it is never sufficient authority
 * to close an issue. Automatic closure requires an exact shared technical
 * failure signature that is long and specific enough to avoid generic overlap.
 */

const STRONG_FAILURE_RE = new RegExp([
  "\\bdid not complete\\b",
  "\\bfailed?\\b",
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
  "\\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EPIPE|EAI_AGAIN|ECONNABORTED|EHOSTUNREACH|ENETUNREACH|EADDRINUSE)\\b",
  "\\b(?:HTTP(?: status(?: code)?)?|status(?: code)?|returns?|returned)\\s*[:=]?\\s*[45]\\d\\d\\b",
].join("|"), "i");

function normalizeSignatureLine(raw) {
  return String(raw || "")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/^\s*(?:>|[-*+]\s+|\d+[.)]\s+)/, "")
    .replace(/^[`~]{3,}[^\n]*$/, "")
    .replace(/[`*_~]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function wordCount(text) {
  return (String(text || "").match(/[\p{L}\p{N}']+/gu) || []).length;
}

function isStrongFailureSignature(line) {
  if (line.length < 36 || line.length > 240) return false;
  if (wordCount(line) < 7) return false;
  return STRONG_FAILURE_RE.test(line);
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

/**
 * Return one auto-close candidate only when:
 * 1. AI nominated the issue as a duplicate; and
 * 2. both live issue bodies contain an exact strong failure signature.
 *
 * Exact line equality is deliberate. Semantic similarity remains advisory.
 */
function selectStrongDuplicateMatch({ currentIssue, candidateIssues, duplicateNumbers }) {
  const allowed = new Set((Array.isArray(duplicateNumbers) ? duplicateNumbers : []).map(String));
  if (!allowed.size) return null;

  const currentSignatures = new Set(extractStrongFailureSignatures(currentIssue));
  if (!currentSignatures.size) return null;

  const candidatesByNumber = new Map(
    (Array.isArray(candidateIssues) ? candidateIssues : [])
      .map((issue) => [String(issue?.number ?? ""), issue])
      .filter(([number]) => /^\d+$/.test(number)),
  );

  for (const rawNumber of duplicateNumbers) {
    const number = String(rawNumber);
    if (!allowed.has(number)) continue;
    const candidate = candidatesByNumber.get(number);
    if (!candidate) continue;

    const shared = extractStrongFailureSignatures(candidate)
      .filter((signature) => currentSignatures.has(signature))
      .sort((a, b) => b.length - a.length || a.localeCompare(b));
    if (!shared.length) continue;

    return { number, signature: shared[0] };
  }

  return null;
}

module.exports = {
  STRONG_FAILURE_RE,
  normalizeSignatureLine,
  isStrongFailureSignature,
  extractStrongFailureSignatures,
  selectStrongDuplicateMatch,
};
