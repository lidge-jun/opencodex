"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

describe("enforce-pr-target workflow", () => {
  const workflowPath = path.join(__dirname, "../workflows/enforce-pr-target.yml");
  const workflow = fs.readFileSync(workflowPath, "utf8");

  it("uses pull_request_target without checking out PR head code", () => {
    assert.match(workflow, /pull_request_target:/);
    assert.doesNotMatch(
      workflow,
      /actions\/checkout@/,
      "wrong-branch enforcer must not check out untrusted PR code",
    );
  });

  it("grants contents:write so draft GraphQL mutations work with GITHUB_TOKEN", () => {
    // convertPullRequestToDraft / markPullRequestReadyForReview fail with
    // "Resource not accessible by integration" when contents stays unset/read
    // (seen on #626). Assert the real permissions block, not comment text
    // that also mentions these scopes.
    const permissionsBlock = workflow.match(/^permissions:\n((?:[ \t]+.+\n)+)/m);
    assert.ok(permissionsBlock, "workflow must declare a top-level permissions block");
    const lines = permissionsBlock[1]
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .sort();
    assert.deepEqual(lines, ["contents: write", "pull-requests: write"]);
  });

  it("fails the required check on a wrong base even if draft conversion fails", () => {
    assert.match(workflow, /core\.setFailed\(/);
    assert.match(workflow, /draftConversionFailed/);
    assert.match(workflow, /Could not convert pull request to draft/);
  });

  it("soft-fails ready-for-review restoration the same way", () => {
    assert.match(workflow, /readyConversionFailed/);
    assert.match(workflow, /Could not mark pull request ready for review/);
  });
});
