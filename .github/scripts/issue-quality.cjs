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
 * Ordered-list numbers are presentation, not evidence, but numeric output in a
 * fenced or indented code block may be the failure itself (for example
 * `404. Not Found`). Strip list prefixes only from prose lines.
 */
function stripOrderedListPrefixes(text) {
  let fence = null;

  return String(text || "")
    .split(/\r?\n/)
    .map((line) => {
      if (fence) {
        const closing = line.match(/^\s{0,3}(`{3,}|~{3,})\s*$/);
        if (
          closing &&
          closing[1][0] === fence.char &&
          closing[1].length >= fence.length
        ) {
          fence = null;
        }
        return line;
      }

      const opening = line.match(/^\s{0,3}(`{3,}|~{3,})/);
      if (opening) {
        fence = { char: opening[1][0], length: opening[1].length };
        return line;
      }

      if (/^(?: {4,}|\t)/.test(line)) return line;
      return line.replace(/^\s{0,3}\d+[.)]\s+/, "");
    })
    .join("\n");
}

function independentReproductionText(summary, reproduction) {
  const summaryCan = core.canonicalise(stripOrderedListPrefixes(summary));
  return stripOrderedListPrefixes(reproduction)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => {
      const lineCan = core.canonicalise(line);
      return lineCan && !summaryCan.includes(lineCan);
    })
    .join("\n");
}

/**
 * Reject the narrow #1672 class: Reproduction is only text already present in
 * Summary and contributes no independent actionable evidence. Compute the
 * actionable check only over reproduction-only lines so phrases like
 * "Codex config" inside the shared generic error cannot be misread by the
 * legacy command heuristic as a `codex config` invocation.
 */
function reproductionOnlyEchoesSummary(summary, reproduction) {
  // Ordered step numbers are presentation, not evidence. Normalize both sides
  // consistently while preserving numeric output inside code blocks.
  const summaryCan = core.canonicalise(stripOrderedListPrefixes(summary));
  const reproductionCan = core.canonicalise(stripOrderedListPrefixes(reproduction));
  if (!summaryCan || !reproductionCan) return false;

  if (summaryCan === reproductionCan || summaryCan.includes(reproductionCan)) {
    return true;
  }
  if (!reproductionCan.includes(summaryCan)) return false;

  const independent = independentReproductionText(summary, reproduction);
  if (!independent) return true;

  const explicitOcxAction =
    /\b(?:run|execute|invoke|retry)\s+[`'"*_~]*ocx\s+(?:sync|restore|update|doctor|start|stop|restart)\b/i.test(
      independent,
    );
  return !(explicitOcxAction || core.hasActionableReproductionDetail(independent));
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
  stripOrderedListPrefixes,
  independentReproductionText,
  reproductionOnlyEchoesSummary,
};
