"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { validateReleaseDispatch } = require("./release-dispatch-guard.cjs");

const SOURCE_SHA = "0123456789abcdef0123456789abcdef01234567";
const WORKFLOW_SHA = "89abcdef0123456789abcdef0123456789abcdef";

function validate(overrides = {}) {
  return validateReleaseDispatch({
    eventName: "workflow_dispatch",
    ref: "refs/heads/dev",
    sourceSha: SOURCE_SHA,
    workflowSha: WORKFLOW_SHA,
    ...overrides,
  });
}

describe("release dispatch guard", () => {
  it("accepts a source distinct from the trusted workflow revision", () => {
    assert.notEqual(SOURCE_SHA, WORKFLOW_SHA);
    assert.equal(validate(), null);
  });

  it("allows an omitted source for subsequent evidence resolution", () => {
    assert.equal(validate({ sourceSha: "" }), null);
  });

  it("rejects non-dispatch events", () => {
    for (const eventName of ["push", "pull_request", "", undefined]) {
      assert.match(validate({ eventName }), /must be triggered by workflow_dispatch/);
    }
  });

  it("rejects every non-dev ref", () => {
    for (const ref of ["refs/heads/main", "refs/heads/preview", "refs/heads/feature", "refs/tags/dev", "dev", "", undefined]) {
      assert.match(validate({ ref }), /must run from dev/);
    }
  });

  it("rejects malformed nonempty source SHAs", () => {
    for (const sourceSha of ["0123456", "A".repeat(40), "g".repeat(40), "a".repeat(41), ` ${SOURCE_SHA}`]) {
      assert.match(validate({ sourceSha }), /source-sha must be a full 40-character commit SHA/);
    }
  });

  it("requires a valid full workflow SHA even when source is omitted", () => {
    for (const workflowSha of ["", undefined, "0123456", "A".repeat(40), "g".repeat(40), "a".repeat(41)]) {
      assert.match(validate({ sourceSha: "", workflowSha }), /workflow SHA must be a full 40-character commit SHA/);
    }
  });
});
