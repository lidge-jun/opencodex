"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  coderabbitOutsideDiffFindingIds,
  latestCodeRabbitReviewForHead,
  unresolvedFindingsClaim,
} = require("./pr-quality-state.cjs");

const HEAD = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OUTSIDE_A = "cr-comment:v1:1d258eb2f6791036acf724b1";
const OUTSIDE_B = "cr-comment:v1:7a8b9c001122334455667788";

function review(overrides = {}) {
  return {
    id: 9001,
    commit_id: HEAD,
    submitted_at: "2026-08-07T06:00:00Z",
    user: { login: "coderabbitai[bot]" },
    body: `**Actionable comments posted: 4**\n\n> [!CAUTION]\n> Some comments are outside the diff and can’t be posted inline due to platform limitations.\n> <details>\n> <summary>⚠️ Outside diff range comments (2)</summary>\n> <!-- ${OUTSIDE_A} -->\n> <!-- ${OUTSIDE_B} -->\n> </details>`,
    ...overrides,
  };
}

describe("durable CodeRabbit outside-diff findings", () => {
  it("uses CodeRabbit's stable cr-comment markers as finding identities", () => {
    assert.deepEqual(
      coderabbitOutsideDiffFindingIds({ reviews: [review()], liveHeadSha: HEAD }),
      [OUTSIDE_A, OUTSIDE_B],
    );
  });

  it("keeps standalone outside-diff findings active without an inline thread", () => {
    assert.deepEqual(
      unresolvedFindingsClaim({
        threads: [],
        reviews: [review()],
        liveHeadSha: HEAD,
      }),
      {
        code: "review_findings",
        unresolved: 2,
        byBot: { "coderabbitai[bot]": 2 },
      },
    );
  });

  it("adds outside-diff markers without double-counting the review actionable total", () => {
    assert.deepEqual(
      unresolvedFindingsClaim({
        threads: [
          { isResolved: false, author: { login: "coderabbitai[bot]" } },
        ],
        reviews: [review()],
        liveHeadSha: HEAD,
      }),
      {
        code: "review_findings",
        unresolved: 3,
        byBot: { "coderabbitai[bot]": 3 },
      },
    );
  });

  it("a later clean CodeRabbit review on the same head clears older markers", () => {
    assert.deepEqual(
      unresolvedFindingsClaim({
        threads: [],
        reviews: [
          review({ id: 9000, submitted_at: "2026-08-07T05:00:00Z" }),
          review({
            id: 9002,
            submitted_at: "2026-08-07T07:00:00Z",
            body: "**Actionable comments posted: 0**",
          }),
        ],
        liveHeadSha: HEAD,
      }),
      { code: null, unresolved: 0, byBot: {} },
    );
  });

  it("uses review id as a deterministic tie-breaker when timestamps are missing", () => {
    const latest = latestCodeRabbitReviewForHead({
      reviews: [
        review({ id: 9001, submitted_at: undefined, body: `Outside diff range comments (1)\n<!-- ${OUTSIDE_A} -->` }),
        review({ id: 9002, submitted_at: undefined, body: "**Actionable comments posted: 0**" }),
      ],
      liveHeadSha: HEAD,
    });

    assert.equal(latest?.id, 9002);
    assert.deepEqual(
      coderabbitOutsideDiffFindingIds({
        reviews: [
          review({ id: 9001, submitted_at: undefined, body: `Outside diff range comments (1)\n<!-- ${OUTSIDE_A} -->` }),
          review({ id: 9002, submitted_at: undefined, body: "**Actionable comments posted: 0**" }),
        ],
        liveHeadSha: HEAD,
      }),
      [],
    );
  });

  it("ignores CodeRabbit markers from an older head and from human reviews", () => {
    assert.deepEqual(
      coderabbitOutsideDiffFindingIds({
        reviews: [
          review({ commit_id: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }),
          review({
            id: 9002,
            user: { login: "maintainer" },
            submitted_at: "2026-08-07T07:00:00Z",
          }),
        ],
        liveHeadSha: HEAD,
      }),
      [],
    );
  });

  it("deduplicates repeated markers in the review body", () => {
    assert.deepEqual(
      coderabbitOutsideDiffFindingIds({
        reviews: [
          review({
            body: `Outside diff range comments (1)\n<!-- ${OUTSIDE_A} -->\n<!-- ${OUTSIDE_A} -->`,
          }),
        ],
        liveHeadSha: HEAD,
      }),
      [OUTSIDE_A],
    );
  });
});
