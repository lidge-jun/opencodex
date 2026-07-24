"use strict";

// ---------------------------------------------------------------------------
// Pure issue-quality validation for OpenCodex.
// CommonJS, zero runtime dependencies. No GitHub API calls.
// ---------------------------------------------------------------------------

/**
 * Strip HTML comments, "No response" placeholders, and trim whitespace.
 */
function clean(raw) {
  if (typeof raw !== "string") return "";
  let s = raw.replace(/<!--[\s\S]*?-->/g, "");
  // Treat GitHub's "No response" placeholder as empty.
  s = s.replace(/^[\s_*]*No response[\s_*]*$/gim, "");
  s = s.replace(/^[\s_*]*(na|n\/a|not applicable|not available)[\s_*]*$/gim, "");
  return s.trim();
}

/**
 * Lowercase, strip punctuation (Unicode-aware), collapse whitespace.
 */
function normalise(raw) {
  return clean(raw)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Canonical form for duplicate detection: normalise + strip common filler
 * phrases that do not add semantic content.
 */
function canonicalise(raw) {
  let s = normalise(raw);
  const fillers = [
    /^i want to\s+/,
    /^we need to\s+/,
    /^would like to\s+/,
    /^i would like to\s+/,
    /^we would like to\s+/,
    /^please\s+/,
  ];
  for (const re of fillers) s = s.replace(re, "");
  return s.trim();
}

/**
 * Extract the text content of a markdown ### section by heading name.
 * Returns null when the heading is absent.
 */
function extractSection(body, heading) {
  if (typeof body !== "string") return null;
  const lines = body.split("\n");
  const headingLower = heading.toLowerCase().trim();
  let capturing = false;
  const out = [];
  for (const line of lines) {
    const m = line.match(/^#{2,4}\s+(.*)/);
    if (m) {
      if (capturing) break; // next heading ends the section
      if (m[1].toLowerCase().trim() === headingLower) {
        capturing = true;
        continue;
      }
    }
    if (capturing) out.push(line);
  }
  if (!capturing) return null;
  return out.join("\n").trim();
}

// ---------------------------------------------------------------------------
// Issue kind detection
// ---------------------------------------------------------------------------

const FEATURE_NEW_HEADINGS = [
  "What are you trying to accomplish?",
  "What prevents this today?",
  "What should OpenCodex do?",
];
const FEATURE_LEGACY_HEADINGS = ["Problem to solve", "Proposed solution"];
const BUG_NEW_HEADINGS = ["Client or integration", "Summary", "Reproduction"];
const BUG_LEGACY_HEADINGS = ["Summary", "Reproduction"];
const PROVIDER_HEADINGS = [
  "Provider or upstream service",
  "Endpoint or capability",
  "Current behaviour",
  "Expected behaviour",
];
const DOCS_HEADINGS = [
  "Documentation problem type",
  "Documentation location",
  "What is wrong or missing?",
];

function countHeadings(body, headings) {
  let n = 0;
  for (const h of headings) {
    if (extractSection(body, h) !== null) n++;
  }
  return n;
}

/**
 * Detect the issue kind from body headings, title prefix, labels, and
 * optional stored bot kind.
 *
 * @param {{ title: string, body: string, labels: string[], storedKind?: string|null }} issue
 * @returns {"feature"|"bug"|"provider-compatibility"|"documentation"|null}
 */
function detectIssueKind(issue) {
  const { title = "", body = "", labels = [], storedKind } = issue;

  // Stored bot kind takes precedence (survives heading removal).
  if (storedKind) return storedKind;

  const titleLower = title.toLowerCase();

  // Provider compatibility: distinct headings.
  if (countHeadings(body, PROVIDER_HEADINGS) >= 3) return "provider-compatibility";

  // Documentation: distinct headings.
  if (countHeadings(body, DOCS_HEADINGS) >= 2) return "documentation";

  // New feature form: at least 2 of the 3 core headings.
  if (countHeadings(body, FEATURE_NEW_HEADINGS) >= 2) return "feature";

  // New bug form: Client or integration + Summary + Reproduction.
  if (
    extractSection(body, "Client or integration") !== null &&
    extractSection(body, "Summary") !== null &&
    extractSection(body, "Reproduction") !== null
  ) {
    return "bug";
  }

  // Legacy feature form: title prefix or old headings.
  if (titleLower.startsWith("[feature]:") || countHeadings(body, FEATURE_LEGACY_HEADINGS) >= 2) {
    return "feature";
  }

  // Legacy bug form: title prefix or old headings (Summary + Reproduction).
  if (titleLower.startsWith("[bug]:") || countHeadings(body, BUG_LEGACY_HEADINGS) >= 2) {
    // Only classify as bug when there is supporting evidence (label or prefix)
    // to avoid false positives on generic issues that happen to have those words.
    if (titleLower.startsWith("[bug]:") || labels.includes("bug")) return "bug";
  }

  return null;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function isEmpty(text) {
  return clean(text).length === 0;
}

function allSameCanonical(sections) {
  const cans = sections.map(canonicalise).filter(Boolean);
  if (cans.length < 2) return false;
  return cans.every((c) => c === cans[0]);
}

function allRepeatTitle(sections, title) {
  const titleCan = canonicalise(title);
  if (!titleCan) return false;
  const cans = sections.map(canonicalise).filter(Boolean);
  if (cans.length === 0) return false;
  return cans.every((c) => c === titleCan);
}

function isPlaceholder(text) {
  const c = clean(text);
  if (!c) return true;
  const lower = c.toLowerCase();
  return (
    lower === "no response" ||
    lower === "na" ||
    lower === "n/a" ||
    lower === "not applicable" ||
    lower === "not available" ||
    lower === "none" ||
    lower === "todo" ||
    lower === "tbd" ||
    /^_no response_$/i.test(c)
  );
}

function countWords(text) {
  const c = clean(text);
  if (!c) return 0;
  const spaced = (c.match(/\b[\p{L}\p{N}']+\b/gu) || []).length;
  if (spaced > 0) return spaced;
  return (c.match(/\p{L}/gu) || []).length;
}

function hasConcreteDetail(text) {
  const c = clean(text);
  if (!c) return false;
  return (
    /\d/.test(c) ||
    /[`{}\[\]<>/\\]/.test(c) ||
    /\b(ocx|config|api|cli|dashboard|provider|proxy|route|endpoint|workflow|command)\b/i.test(c)
  );
}

function isTooTerseFeatureSection(text) {
  if (isEmpty(text) || isPlaceholder(text)) return false;
  const words = countWords(text);
  if (words >= 8) return false;
  if (words >= 6 && hasConcreteDetail(text)) return false;
  return !hasConcreteDetail(text);
}

/**
 * Check if raw section text is a GitHub "No response" placeholder variant
 * without stripping it first. Used to distinguish intentionally blank optional
 * fields from actively cleared required fields.
 */
function isRawPlaceholder(raw) {
  if (raw === null) return false;
  const trimmed = raw.trim();
  if (!trimmed) return false;
  return /^[\s_*]*no response[\s_*]*$/i.test(trimmed);
}

/**
 * Validate an issue body for its detected kind.
 *
 * @param {{ title: string, body: string, labels: string[], storedKind?: string|null }} issue
 * @returns {{ kind: string|null, valid: boolean, reasons: string[], guidance: string[] }}
 */
function validateIssue(issue) {
  const { title = "", body = "" } = issue;
  const kind = detectIssueKind(issue);
  const reasons = [];
  const guidance = [];

  if (!kind) {
    // Not a structured form we validate.
    return { kind: null, valid: true, reasons: [], guidance: [] };
  }

  if (kind === "feature") {
    const goal = extractSection(body, "What are you trying to accomplish?") ??
      extractSection(body, "Problem to solve");
    const blocker = extractSection(body, "What prevents this today?");
    const behaviour = extractSection(body, "What should OpenCodex do?") ??
      extractSection(body, "Proposed solution");
    const example = extractSection(body, "Example usage or interface");

    const coreSections = [goal, blocker, behaviour, example];
    const emptyCore = [];
    if (isEmpty(goal)) emptyCore.push("goal / problem");
    // blocker and example are only required on the new form (heading exists).
    // On the legacy form these sections are absent (null), which is acceptable.
    if (blocker !== null && isEmpty(blocker)) emptyCore.push("current limitation");
    if (isEmpty(behaviour)) emptyCore.push("expected behaviour");
    if (example !== null && isPlaceholder(example)) {
      reasons.push("Example usage or interface contains placeholder text instead of a concrete example.");
      guidance.push("Add a real CLI command, config snippet, API exchange, or before/after workflow example.");
    } else if (example !== null && isEmpty(example)) {
      emptyCore.push("example usage");
    }

    if (emptyCore.length > 0) {
      reasons.push(`Required sections are missing or empty: ${emptyCore.join(", ")}.`);
      guidance.push("Fill in each required section with specific detail about your workflow.");
    }

    const nonEmpty = coreSections.filter((s) => !isEmpty(s));
    if (nonEmpty.length >= 2 && allSameCanonical(nonEmpty)) {
      reasons.push("All core sections contain the same content.");
      guidance.push("Each section should describe a different aspect: goal, limitation, expected behaviour, and a concrete example.");
    }

    if (nonEmpty.length >= 2 && allRepeatTitle(nonEmpty, title)) {
      reasons.push("All core sections merely repeat the issue title.");
      guidance.push("Expand each section with details beyond the title.");
    }

    if (nonEmpty.length > 0 && nonEmpty.every(isPlaceholder)) {
      reasons.push("Required sections contain only placeholder text.");
      guidance.push("Replace placeholder text with your actual proposal.");
    }

    const terseSections = [];
    if (goal !== null && isTooTerseFeatureSection(goal)) terseSections.push("goal / problem");
    if (blocker !== null && isTooTerseFeatureSection(blocker)) terseSections.push("current limitation");
    if (behaviour !== null && isTooTerseFeatureSection(behaviour)) terseSections.push("expected behaviour");
    if (terseSections.length > 0) {
      reasons.push(`Required sections are too vague to act on: ${terseSections.join(", ")}.`);
      guidance.push("Describe the workflow, limitation, and expected behaviour with enough detail for someone to implement or evaluate the request.");
    }
  }

  if (kind === "bug") {
    const summary = extractSection(body, "Summary");
    const repro = extractSection(body, "Reproduction");
    const version = extractSection(body, "Version");
    const os = extractSection(body, "Operating system") ?? extractSection(body, "OS");

    if (isEmpty(summary) && isEmpty(repro)) {
      reasons.push("Both Summary and Reproduction are empty.");
      guidance.push("Describe what happened and how to reproduce it.");
    }

    // Required environment fields removed after submission.
    // Only fire when the headings exist in the body (new form). Legacy bug
    // reports never had Version or OS fields, so null means absent, not removed.
    // Skip when the raw value is a "No response" placeholder -- the old form had
    // both fields as optional, so legacy issues legitimately contain those headings
    // with the GitHub placeholder. Only close when the field was actively cleared.
    if (version !== null && os !== null && isEmpty(version) && isEmpty(os) &&
        !isRawPlaceholder(version) && !isRawPlaceholder(os)) {
      reasons.push("Version and Operating system are both missing.");
      guidance.push("Add your OpenCodex version and OS so we can reproduce the environment.");
    }

    const nonEmpty = [summary, repro].filter((s) => !isEmpty(s));
    if (nonEmpty.length >= 2 && allSameCanonical(nonEmpty)) {
      reasons.push("Summary and Reproduction contain the same content.");
      guidance.push("Summary should describe the symptom; Reproduction should list the exact steps.");
    }

    if (nonEmpty.length >= 1 && allRepeatTitle(nonEmpty, title)) {
      reasons.push("Summary and Reproduction merely repeat the title.");
      guidance.push("Add detail beyond the title: what you observed, what you expected, and the exact steps.");
    }

    if (nonEmpty.length > 0 && nonEmpty.every(isPlaceholder)) {
      reasons.push("Required sections contain only placeholder text.");
      guidance.push("Replace placeholder text with your actual report.");
    }
  }

  if (kind === "provider-compatibility") {
    const current = extractSection(body, "Current behaviour");
    const expected = extractSection(body, "Expected behaviour");
    const repro = extractSection(body, "Minimal redacted request or reproduction");
    const response = extractSection(body, "Actual response or error");
    const docs = extractSection(body, "Upstream documentation");

    const emptyCore = [];
    if (isEmpty(current)) emptyCore.push("current behaviour");
    if (isEmpty(expected)) emptyCore.push("expected behaviour");
    // Metadata fields: provider, version, endpoint are required on the form.
    const provider = extractSection(body, "Provider or upstream service");
    const version = extractSection(body, "OpenCodex version");
    const endpoint = extractSection(body, "Endpoint or capability");
    if (provider !== null && isEmpty(provider)) emptyCore.push("provider or upstream service");
    if (version !== null && isRawPlaceholder(version) === false && isEmpty(version)) emptyCore.push("OpenCodex version");
    if (endpoint !== null && isEmpty(endpoint)) emptyCore.push("endpoint or capability");
    if (emptyCore.length > 0) {
      reasons.push(`Required sections are missing or empty: ${emptyCore.join(", ")}.`);
      guidance.push("Describe both the current and expected behaviour.");
    }

    if (!isEmpty(current) && !isEmpty(expected) && canonicalise(current) === canonicalise(expected)) {
      reasons.push("Current and expected behaviour are effectively identical.");
      guidance.push("Explain the difference between what happens now and what should happen.");
    }

    const allSections = [current, expected, repro, response].filter((s) => !isEmpty(s));
    if (allSections.length >= 2 && allRepeatTitle(allSections, title)) {
      reasons.push("All sections merely repeat the issue title.");
      guidance.push("Add specific detail in each section.");
    }

    if (isEmpty(repro) && isEmpty(response)) {
      reasons.push("Both the request/reproduction and the actual response/error are absent.");
      guidance.push("Include at least a minimal redacted request or the actual error output.");
    }

    if (isEmpty(docs)) {
      reasons.push("Upstream documentation is empty without stating that no public specification exists.");
      guidance.push("Add a URL to the provider specification, or state that no public spec exists.");
    }
  }

  if (kind === "documentation") {
    const location = extractSection(body, "Documentation location");
    const problem = extractSection(body, "What is wrong or missing?");
    const expected = extractSection(body, "What should the documentation explain instead?");

    if (isEmpty(location) && isEmpty(problem)) {
      reasons.push("Documentation location and problem description are both missing.");
      guidance.push("Point to the exact documentation page and describe what is wrong.");
    }

    const nonEmpty = [location, problem, expected].filter((s) => !isEmpty(s));
    if (nonEmpty.length >= 1 && allRepeatTitle(nonEmpty, title)) {
      reasons.push("The body merely repeats the title.");
      guidance.push("Add detail: the exact URL or path, what is wrong, and what it should say.");
    }

    if (nonEmpty.length > 0 && nonEmpty.every(isPlaceholder)) {
      reasons.push("Required sections contain only placeholder text.");
      guidance.push("Replace placeholder text with the actual documentation problem.");
    }
  }

  return {
    kind,
    valid: reasons.length === 0,
    reasons,
    guidance,
  };
}

// ---------------------------------------------------------------------------
// Closure ownership
// ---------------------------------------------------------------------------

/**
 * Decide whether the bot may reopen a closed issue.
 *
 * @param {{ active: boolean, closedAt: string|null, stateReason: string }} botState
 * @param {{ state: string, closed_at: string|null, state_reason: string|null, closed_by?: string|null }} issue
 * @param {boolean} maintainerOverride  True when a maintainer changed the issue state after the bot.
 * @returns {boolean}
 */
function shouldReopen(botState, issue, maintainerOverride) {
  if (!botState || !botState.active) return false;
  if (issue.state !== "closed") return false;
  if (maintainerOverride) return false;
  if (issue.closed_at !== botState.closedAt) return false;
  if (issue.state_reason !== botState.stateReason) return false;
  // Only reopen if the bot itself was the last actor to close the issue.
  // A human closing it (even with the same timestamp) means intentional closure.
  if (issue.closed_by && issue.closed_by !== "github-actions[bot]") return false;
  return true;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  clean,
  normalise,
  canonicalise,
  extractSection,
  detectIssueKind,
  validateIssue,
  shouldReopen,
  isRawPlaceholder,
};
