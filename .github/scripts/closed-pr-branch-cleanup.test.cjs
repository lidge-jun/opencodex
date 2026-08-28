"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  DEFAULT_GRACE_DAYS,
  DISPOSABLE_BRANCH_PREFIXES,
  KEEP_REASONS,
  isProtectedBranch,
  planClosedPrBranchDeletions,
} = require("./closed-pr-branch-cleanup.cjs");

const NOW = Date.parse("2026-08-26T00:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const HEAD_OID = "a".repeat(40);
const OTHER_OID = "b".repeat(40);
const NBSP = "\u00a0";
const longAgo = new Date(NOW - 60 * DAY).toISOString();

function closedPr(overrides) {
  return {
    number: 1,
    state: "CLOSED",
    merged: false,
    isCrossRepository: false,
    headRefName: "codex/example",
    headRefOid: HEAD_OID,
    baseRefName: "dev",
    closedAt: longAgo,
    ...overrides,
  };
}

function keepReason(result, branch) {
  const hit = result.keeps.find((entry) => entry.branch === branch);
  return hit ? hit.reason : null;
}

function deletedBranches(result) {
  return result.deletions.map((entry) => entry.branch);
}

describe("isProtectedBranch", () => {
  it("protects the integration, release, and prerelease lines", () => {
    for (const name of ["main", "dev", "preview", "gh-pages"]) {
      assert.equal(isProtectedBranch(name), true, name);
    }
    assert.equal(isProtectedBranch("codex/dev"), false);
  });

  it("declares the disposable pull-request branch namespaces", () => {
    assert.deepEqual(DISPOSABLE_BRANCH_PREFIXES, ["codex/", "ingw/"]);
  });
});

describe("planClosedPrBranchDeletions", () => {
  it("deletes a branch whose only pull request closed unmerged past the grace period", () => {
    const result = planClosedPrBranchDeletions({
      pullRequests: [closedPr({ number: 42, headRefName: "codex/stale" })],
      branches: [{ name: "codex/stale", oid: HEAD_OID }, "dev"],
      now: NOW,
    });
    assert.deepEqual(deletedBranches(result), ["codex/stale"]);
    assert.deepEqual(result.deletions[0].pullRequests, [42]);
  });

  it("keeps a branch that any merged pull request used as a head", () => {
    const result = planClosedPrBranchDeletions({
      pullRequests: [
        closedPr({ number: 10, headRefName: "codex/reused" }),
        closedPr({ number: 11, headRefName: "codex/reused", state: "MERGED", merged: true }),
      ],
      branches: ["codex/reused"],
      now: NOW,
    });
    assert.deepEqual(deletedBranches(result), []);
    assert.equal(keepReason(result, "codex/reused"), KEEP_REASONS.MERGED);
  });

  it("keeps a branch that still has an open pull request", () => {
    const result = planClosedPrBranchDeletions({
      pullRequests: [
        closedPr({ number: 20, headRefName: "codex/active" }),
        closedPr({ number: 21, headRefName: "codex/active", state: "OPEN", closedAt: null }),
      ],
      branches: ["codex/active"],
      now: NOW,
    });
    assert.deepEqual(deletedBranches(result), []);
    assert.equal(keepReason(result, "codex/active"), KEEP_REASONS.OPEN);
  });

  it("keeps a closed stack parent while an open child still targets it", () => {
    const result = planClosedPrBranchDeletions({
      pullRequests: [
        closedPr({ number: 30, headRefName: "codex/stack-1" }),
        closedPr({
          number: 31,
          state: "OPEN",
          closedAt: null,
          headRefName: "codex/stack-2",
          baseRefName: "codex/stack-1",
        }),
      ],
      branches: ["codex/stack-1", "codex/stack-2"],
      now: NOW,
    });
    assert.deepEqual(deletedBranches(result), []);
    assert.equal(keepReason(result, "codex/stack-1"), KEEP_REASONS.BASE_OF_OPEN);
  });

  it("never touches a fork head branch", () => {
    const result = planClosedPrBranchDeletions({
      pullRequests: [
        closedPr({ number: 40, headRefName: "patch-1", isCrossRepository: true }),
      ],
      branches: ["patch-1"],
      now: NOW,
    });
    assert.deepEqual(deletedBranches(result), []);
    assert.equal(keepReason(result, "patch-1"), KEEP_REASONS.CROSS_REPOSITORY);
  });

  it("waits out the grace period so a mistaken close can be reopened", () => {
    const recent = new Date(NOW - 3 * DAY).toISOString();
    const result = planClosedPrBranchDeletions({
      pullRequests: [closedPr({ number: 50, headRefName: "codex/recent", closedAt: recent })],
      branches: ["codex/recent"],
      now: NOW,
      graceDays: DEFAULT_GRACE_DAYS,
    });
    assert.deepEqual(deletedBranches(result), []);
    assert.equal(keepReason(result, "codex/recent"), KEEP_REASONS.WITHIN_GRACE);
  });

  it("keeps a branch when a closed pull request has no closed_at timestamp", () => {
    const result = planClosedPrBranchDeletions({
      pullRequests: [closedPr({ number: 60, headRefName: "codex/unknown", closedAt: null })],
      branches: ["codex/unknown"],
      now: NOW,
    });
    assert.deepEqual(deletedBranches(result), []);
    assert.equal(keepReason(result, "codex/unknown"), KEEP_REASONS.MISSING_CLOSED_AT);
  });

  it("refuses to delete a protected branch even if a closed pull request used it", () => {
    const result = planClosedPrBranchDeletions({
      pullRequests: [closedPr({ number: 70, headRefName: "dev" })],
      branches: ["dev", "main", "preview"],
      now: NOW,
    });
    assert.deepEqual(deletedBranches(result), []);
    assert.equal(keepReason(result, "dev"), KEEP_REASONS.PROTECTED);
  });

  it("ignores branches that no pull request ever used", () => {
    const result = planClosedPrBranchDeletions({
      pullRequests: [closedPr({ number: 80, headRefName: "codex/known" })],
      branches: [
        { name: "codex/known", oid: HEAD_OID },
        { name: "codex/never-a-pr", oid: HEAD_OID },
      ],
      now: NOW,
    });
    assert.deepEqual(deletedBranches(result), ["codex/known"]);
    assert.equal(keepReason(result, "codex/never-a-pr"), null);
  });

  it("keeps a persistent branch even when a closed pull request still matches its tip", () => {
    const branch = "release/maintenance";
    const result = planClosedPrBranchDeletions({
      pullRequests: [closedPr({ number: 85, headRefName: branch })],
      branches: [{ name: branch, oid: HEAD_OID }],
      now: NOW,
    });
    assert.deepEqual(deletedBranches(result), []);
    assert.equal(
      keepReason(result, branch),
      KEEP_REASONS.OUTSIDE_DISPOSABLE_NAMESPACE,
    );
  });

  it("preserves Unicode whitespace so distinct valid refs never collapse", () => {
    const disposable = `codex/live${NBSP}`;
    const result = planClosedPrBranchDeletions({
      pullRequests: [closedPr({ number: 86, headRefName: disposable })],
      branches: [
        { name: "codex/live", oid: OTHER_OID },
        { name: disposable, oid: HEAD_OID },
      ],
      now: NOW,
    });
    assert.deepEqual(result.deletions, [{ branch: disposable, pullRequests: [86] }]);
    assert.equal(keepReason(result, "codex/live"), null);
  });

  it("does not trim leading Unicode whitespace into a disposable namespace", () => {
    const branch = `${NBSP}codex/persistent`;
    const result = planClosedPrBranchDeletions({
      pullRequests: [closedPr({ number: 87, headRefName: branch })],
      branches: [{ name: branch, oid: HEAD_OID }],
      now: NOW,
    });
    assert.deepEqual(deletedBranches(result), []);
    assert.equal(
      keepReason(result, branch),
      KEEP_REASONS.OUTSIDE_DISPOSABLE_NAMESPACE,
    );
  });

  it("only plans deletions for branches that still exist", () => {
    const result = planClosedPrBranchDeletions({
      pullRequests: [closedPr({ number: 90, headRefName: "codex/already-gone" })],
      branches: [],
      now: NOW,
    });
    assert.deepEqual(deletedBranches(result), []);
  });
});
