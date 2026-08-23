"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { decideForkAutoRelease } = require("./fork-auto-release.cjs");

const SHA = "0123456789abcdef0123456789abcdef01234567";
const OTHER_SHA = "89abcdef0123456789abcdef0123456789abcdef";

function candidate(overrides = {}) {
  return {
    eventName: "workflow_run",
    workflowName: "Cross-platform CI",
    conclusion: "success",
    headBranch: "main",
    headSha: SHA,
    liveMainSha: SHA,
    packageName: "@yansigit/opencodex",
    packageVersion: "2.32.0",
    ...overrides,
  };
}

describe("fork auto-release decision", () => {
  it("dispatches an unused stable package version from green main CI", () => {
    assert.deepEqual(decideForkAutoRelease(candidate()), { action: "dispatch" });
  });

  for (const [name, overrides, reason] of [
    ["skips non-workflow_run events", { eventName: "push" }, "workflow_run"],
    ["skips another triggering workflow", { workflowName: "Release" }, "Cross-platform CI"],
    ["skips unsuccessful CI", { conclusion: "failure" }, "success"],
    ["skips non-main branches", { headBranch: "dev" }, "main"],
    ["skips a moved main branch", { liveMainSha: OTHER_SHA }, "live main"],
    ["skips another package", { packageName: "opencodex" }, "@yansigit/opencodex"],
    ["skips prerelease versions", { packageVersion: "2.32.0-preview.1" }, "stable semver"],
    ["skips versions already on npm", { versionOnNpm: "2.32.0" }, "already published"],
  ]) {
    it(name, () => {
      const result = decideForkAutoRelease(candidate(overrides));
      assert.equal(result.action, "skip");
      assert.match(result.reason, new RegExp(reason.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    });
  }

  it("rejects an empty SHA as malformed input", () => {
    assert.throws(
      () => decideForkAutoRelease(candidate({ headSha: "" })),
      /headSha must be a non-empty string/,
    );
  });

  it("rejects a missing package name as malformed input", () => {
    assert.throws(
      () => decideForkAutoRelease(candidate({ packageName: undefined })),
      /packageName must be a non-empty string/,
    );
  });
});
