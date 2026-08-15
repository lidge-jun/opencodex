"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  validateIssue,
  stripOrderedListPrefixes,
  independentReproductionText,
  reproductionOnlyEchoesSummary,
} = require("./issue-quality.cjs");

function bugBody({ summary, reproduction }) {
  return [
    "### Client or integration",
    "Codex CLI",
    "",
    "### Area",
    "CLI",
    "",
    "### Summary",
    summary,
    "",
    "### Reproduction",
    reproduction,
    "",
    "### Version",
    "v2.15.0",
    "",
    "### Operating system",
    "Windows 11",
    "",
    "### Provider and model",
    "_No response_",
    "",
    "### Logs or error output",
    "```shell",
    "",
    "```",
  ].join("\n");
}

describe("issue #1672 regression", () => {
  it("rejects a reproduction that only echoes the generic final sync failure from Summary", () => {
    const genericFailure =
      "Codex sync did not complete. Fix the reported Codex config issue and retry.";
    const body = bugBody({
      summary: `ocx sync\n${genericFailure}`,
      reproduction: genericFailure,
    });

    const result = validateIssue({
      title: genericFailure,
      body,
      labels: ["bug"],
    });

    assert.equal(result.kind, "bug");
    assert.equal(result.valid, false);
    assert.ok(
      result.reasons.some((reason) => /reproduction.*repeat|echo/i.test(reason)),
      `Expected summary-echo rejection, got: ${result.reasons.join("; ")}`,
    );
  });

  it("rejects ordered-list formatting when it only repeats Summary evidence", () => {
    const genericFailure =
      "Codex sync did not complete. Fix the reported Codex config issue and retry.";
    const body = bugBody({
      summary: ["Run `ocx sync`.", genericFailure].join("\n"),
      reproduction: ["1. Run `ocx sync`.", `2. ${genericFailure}`].join("\n"),
    });

    const result = validateIssue({
      title: genericFailure,
      body,
      labels: ["bug"],
    });

    assert.equal(result.kind, "bug");
    assert.equal(result.valid, false);
    assert.ok(
      result.reasons.some((reason) => /reproduction.*repeat|echo/i.test(reason)),
      `Expected ordered summary-echo rejection, got: ${result.reasons.join("; ")}`,
    );
  });

  it("normalizes identical multi-line ordered lists on both sides", () => {
    const genericFailure =
      "Codex sync did not complete. Fix the reported Codex config issue and retry.";
    const repeated = ["1. Run `ocx sync`.", `2. ${genericFailure}`].join("\n");
    const body = bugBody({
      summary: repeated,
      reproduction: repeated,
    });

    assert.equal(reproductionOnlyEchoesSummary(repeated, repeated), true);

    const result = validateIssue({
      title: genericFailure,
      body,
      labels: ["bug"],
    });

    assert.equal(result.kind, "bug");
    assert.equal(result.valid, false);
  });

  it("preserves numeric failure evidence inside fenced and indented code blocks", () => {
    const fenced = ["```text", "404. Not Found", "```"].join("\n");
    const indented = "    404. Not Found";

    assert.equal(stripOrderedListPrefixes(fenced), fenced);
    assert.equal(stripOrderedListPrefixes(indented), indented);
    assert.match(independentReproductionText("Not Found", fenced), /404\. Not Found/);
  });

  it("keeps the same failure text valid when Reproduction adds an actionable command", () => {
    const genericFailure =
      "Codex sync did not complete. Fix the reported Codex config issue and retry.";
    const body = bugBody({
      summary: genericFailure,
      reproduction: [
        "1. Run `ocx sync`.",
        `2. Observe: ${genericFailure}`,
      ].join("\n"),
    });

    const result = validateIssue({
      title: "ocx sync fails after configuration injection",
      body,
      labels: ["bug"],
    });

    assert.equal(
      result.valid,
      true,
      `Expected actionable reproduction to remain valid, got: ${result.reasons.join("; ")}`,
    );
  });
});
