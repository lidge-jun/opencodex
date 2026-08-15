"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  extractStrongFailureSignatures,
  selectStrongDuplicateMatch,
} = require("./issue-triage-autoclose.cjs");

describe("deterministic duplicate auto-close", () => {
  it("selects the #1453-style source for the exact #1672 sync failure signature", () => {
    const signature =
      "Codex sync did not complete. Fix the reported Codex config issue and retry.";
    const currentIssue = {
      number: 1672,
      title: signature,
      body: [
        "### Summary",
        "ocx sync",
        signature,
        "### Reproduction",
        signature,
      ].join("\n"),
    };
    const sourceIssue = {
      number: 1453,
      title: "ocx sync and restore back fail permanently with an unnamed config issue",
      body: [
        "### Summary",
        "`ocx sync` fails with:",
        "```",
        signature,
        "Plain `codex` was not switched back to opencodex.",
        "```",
      ].join("\n"),
    };

    const match = selectStrongDuplicateMatch({
      currentIssue,
      candidateIssues: [sourceIssue],
      duplicateNumbers: ["1453"],
    });

    assert.deepEqual(match, {
      number: "1453",
      signature: signature.toLowerCase(),
    });
  });

  it("does not auto-close an AI duplicate without an exact strong failure signature", () => {
    const match = selectStrongDuplicateMatch({
      currentIssue: {
        number: 2000,
        title: "Codex sync fails",
        body: "The Codex sync command fails after editing config.toml.",
      },
      candidateIssues: [{
        number: 1453,
        title: "Codex sync failure",
        body: "ocx sync fails because the catalog is rewritten before injection.",
      }],
      duplicateNumbers: ["1453"],
    });

    assert.equal(match, null);
  });

  it("ignores exact matches that the AI did not nominate as duplicates", () => {
    const signature =
      "Codex sync did not complete. Fix the reported Codex config issue and retry.";
    const match = selectStrongDuplicateMatch({
      currentIssue: { number: 1672, title: signature, body: signature },
      candidateIssues: [{ number: 1453, title: "old report", body: signature }],
      duplicateNumbers: [],
    });

    assert.equal(match, null);
  });

  it("does not promote short generic HTTP failures to auto-close signatures", () => {
    assert.deepEqual(
      extractStrongFailureSignatures({
        title: "Proxy error",
        body: "Proxy returns HTTP 500.",
      }),
      [],
    );
  });

  it("workflow searches open and closed issues and closes only through duplicate state reason", () => {
    const workflow = fs.readFileSync(
      path.join(__dirname, "..", "workflows", "issue-triage.yml"),
      "utf8",
    );

    assert.match(workflow, /gh issue list[^\n]*--state open/);
    assert.match(workflow, /gh issue list[^\n]*--state closed/);
    assert.match(workflow, /issue-triage-autoclose\.cjs/);
    assert.match(workflow, /state_reason:\s*["']duplicate["']/);
  });
});
