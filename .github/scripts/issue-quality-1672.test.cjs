"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { validateIssue } = require("./issue-quality.cjs");

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
