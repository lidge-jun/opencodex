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
      /ref:\s*\$\{\{\s*github\.event\.pull_request\.head/,
      "enforcer must not check out untrusted PR head code",
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

  it("listens for synchronize so rebase can clear ancestry failures", () => {
    assert.match(workflow, /synchronize/);
  });

  it("checks out trusted default-branch scripts only (never PR head)", () => {
    assert.match(workflow, /actions\/checkout@[0-9a-f]{40}/);
    assert.match(workflow, /ref:\s*\$\{\{\s*github\.event\.repository\.default_branch\s*\}\}/);
    assert.match(workflow, /sparse-checkout:\s*\.github\/scripts/);
    assert.match(workflow, /persist-credentials:\s*false/);
    assert.doesNotMatch(workflow, /ref:\s*\$\{\{\s*github\.event\.pull_request\.head/);
  });

  it("loads pr-quality via require from the checked-out scripts", () => {
    assert.match(workflow, /pr-quality\.cjs/);
    assert.match(workflow, /collectPrQualityFailures/);
  });

  it("checks stacked bases via open PR heads before wrong_base enforcement", () => {
    assert.match(workflow, /stackedBase/);
    assert.match(workflow, /github\.rest\.pulls\.list/);
    assert.match(workflow, /treating as stacked/);
    const qualityCall = workflow.match(
      /collectPrQualityFailures\(\{([\s\S]*?)\}\);/,
    );
    assert.ok(qualityCall, "must call collectPrQualityFailures");
    assert.match(qualityCall[1], /stackedBase/);
  });

  it("strips stale WRONG BRANCH prefix on failure when base is corrected", () => {
    const failureBlock = workflow.match(
      /if \(failures\.length > 0\) \{([\s\S]*?)core\.setFailed\(/,
    );
    assert.ok(failureBlock, "workflow must have a failure path");
    const failurePath = failureBlock[1];
    assert.match(failurePath, /shouldStripTitlePrefix/);
    assert.match(failurePath, /!hasWrongBase/);
    assert.match(failurePath, /titlePrefixedByBot = false/);
    assert.match(failurePath, /pr\.title\.slice\(TITLE_PREFIX\.length\)/);
  });
});
