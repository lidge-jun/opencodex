"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { validateReleaseDispatch } = require("./release-dispatch-guard.cjs");

const SHA = "0123456789abcdef0123456789abcdef01234567";
const OTHER_SHA = "89abcdef0123456789abcdef0123456789abcdef";

function validate(overrides = {}) {
  return validateReleaseDispatch({
    eventName: "workflow_dispatch",
    ref: "refs/heads/main",
    expectedSha: SHA,
    actualSha: SHA,
    ...overrides,
  });
}

describe("release dispatch guard", () => {
  it("accepts an exact audited SHA on main", () => {
    assert.equal(validate(), null);
  });

  it("accepts an exact audited SHA on preview", () => {
    assert.equal(
      validate({ ref: "refs/heads/preview" }),
      null,
    );
  });

  it("rejects non-workflow_dispatch events", () => {
    assert.match(
      validate({ eventName: "push" }),
      /must be triggered by workflow_dispatch/,
    );
  });

  it("rejects release dispatches from unapproved refs", () => {
    assert.match(
      validate({ ref: "refs/heads/dev" }),
      /must run from main or preview/,
    );
  });

  it("requires expected-sha", () => {
    assert.match(
      validate({ expectedSha: "" }),
      /expected-sha is required/,
    );
  });

  it("requires a full 40-character commit SHA", () => {
    assert.match(
      validate({ expectedSha: "0123456" }),
      /full 40-character commit SHA/,
    );
  });

  it("rejects when the selected ref moved after audit", () => {
    assert.match(
      validate({ actualSha: OTHER_SHA }),
      /branch moved after the release audit/,
    );
  });
});
