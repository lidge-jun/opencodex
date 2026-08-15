"use strict";

// Keep the strict canonical validator intact and normalize equivalent structured
// bug evidence before delegating to it. This lets detailed reports survive
// harmless heading changes without weakening the underlying quality checks.
const core = require("./issue-quality-core.cjs");

const REPRODUCTION_ALIASES = [
  "Steps to reproduce",
  "How to reproduce",
  "What fails / what passes",
  "Debug evidence (ocx debug provider)",
  "Debug evidence",
  "Logs or error output",
  "Error output",
  "Stack trace",
];

function extractEnvironmentField(environment, names) {
  if (environment == null) return null;
  const wanted = new Set(names.map((name) => name.toLowerCase()));

  for (const rawLine of String(environment).split(/\r?\n/)) {
    const line = rawLine.replace(/^\s*[-*+]\s+/, "").trim();
    const match = line.match(/^([^:]+):\s*(.+)$/);
    if (!match) continue;
    const key = match[1].replace(/[*_`~]/g, "").trim().toLowerCase();
    if (wanted.has(key)) return match[2].trim();
  }

  return null;
}

function appendSection(body, heading, value) {
  if (value == null || String(value).trim() === "") return body;
  return `${String(body || "").trimEnd()}\n\n### ${heading}\n${String(value).trim()}\n`;
}

function normalizeEquivalentBugEvidence(issue) {
  if (!issue || typeof issue !== "object") return issue;

  const body = String(issue.body || "");
  // Limit alias normalization to the current bug form. Legacy/freeform reports
  // retain the existing enforcement behavior.
  if (core.extractSection(body, "Client or integration") === null) return issue;

  let normalized = body;

  if (core.extractSection(normalized, "Reproduction") === null) {
    const evidence = REPRODUCTION_ALIASES
      .map((heading) => core.extractSection(body, heading))
      .filter((section) => section != null && String(section).trim() !== "")
      .join("\n\n");

    // Alias headings only count when they contain the same concrete signals the
    // canonical Reproduction field already requires (commands/errors/paths/etc.).
    if (evidence && core.hasActionableReproductionDetail(evidence)) {
      normalized = appendSection(normalized, "Reproduction", evidence);
    }
  }

  const environment = core.extractSection(body, "Environment");

  if (core.extractSection(normalized, "Version") === null) {
    // Do not accept a generic dependency "Version" from Environment: the gate
    // specifically needs the OpenCodex install version.
    const version = extractEnvironmentField(environment, ["OpenCodex", "OpenCodex version"]);
    if (version) normalized = appendSection(normalized, "Version", version);
  }

  if (
    core.extractSection(normalized, "Operating system") === null &&
    core.extractSection(normalized, "OS") === null
  ) {
    const os = extractEnvironmentField(environment, ["OS", "Operating system"]);
    if (os) normalized = appendSection(normalized, "Operating system", os);
  }

  return normalized === body ? issue : { ...issue, body: normalized };
}

function detectIssueKind(issue) {
  return core.detectIssueKind(normalizeEquivalentBugEvidence(issue));
}

/**
 * The core validator deliberately accepts longer prose even when it lacks one
 * of its compact command/error/path signals. That is useful for narrative
 * reproduction steps, but it let #1672 pass by copying the generic final sync
 * error from Summary into Reproduction. Only reject the narrow case where the
 * reproduction is wholly contained in the summary (or vice versa) and adds no
 * independent actionable step.
 */
function reproductionOnlyEchoesSummary(summary, reproduction) {
  const summaryCan = core.canonicalise(summary);
  const reproductionCan = core.canonicalise(reproduction);
  if (!summaryCan || !reproductionCan) return false;

  const hasIndependentAction =
    core.hasActionableReproductionDetail(reproduction) ||
    /\b(?:run|execute|invoke|retry)\s+[`'"*_~]*ocx\s+(?:sync|restore|update|doctor|start|stop|restart)\b/i.test(
      String(reproduction || ""),
    );
  if (hasIndependentAction) return false;

  return summaryCan.includes(reproductionCan) || reproductionCan.includes(summaryCan);
}

function validateIssue(issue) {
  const normalizedIssue = normalizeEquivalentBugEvidence(issue);
  const result = core.validateIssue(normalizedIssue);

  if (result.kind !== "bug" || result.softPass || !result.valid) return result;

  const body = String(normalizedIssue?.body || "");
  const summary = core.extractSection(body, "Summary");
  const reproduction = core.extractSection(body, "Reproduction");
  if (!reproductionOnlyEchoesSummary(summary, reproduction)) return result;

  return {
    ...result,
    valid: false,
    reasons: [
      ...result.reasons,
      "Reproduction only echoes the Summary and does not add actionable steps or failure evidence.",
    ],
    guidance: [
      ...result.guidance,
      "List the exact command or steps that trigger the problem and include the underlying error or observed output, not only the final summary message.",
    ],
  };
}

module.exports = {
  ...core,
  detectIssueKind,
  validateIssue,
  normalizeEquivalentBugEvidence,
  reproductionOnlyEchoesSummary,
};
