"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  parseState,
  stateMarker,
  parseReadinessState,
  readinessStateMarker,
  parseGateState,
  gateStateMarker,
  defaultGateState,
  migrateLegacyGateState,
  clearedEnforcerState,
  defaultEnforcerState,
  defaultReadinessState,
  completionIsStale,
  readinessClaimViolations,
  unresolvedFindingsClaim,
  coderabbitOutsideDiffFindings,
  REVIEW_FINDINGS_BOT_LOGINS,
  READINESS_LATEST_DEV_BEHIND_MAX,
  READINESS_STATE_VERSION
} = require("./pr-quality-state.cjs");

describe("enforcer state markers", () => {
  it("parses a valid enforcer state marker", () => {
    const state = { version: 1, active: true, autoDraftedByBot: true };
    assert.deepEqual(
      parseState(`<!-- pr-quality-enforcer-state:${JSON.stringify(state)} -->`),
      state,
    );
    assert.deepEqual(
      parseState(
        `<!-- wrong-branch-enforcer-state:${JSON.stringify(state)} -->`,
      ),
      state,
    );
  });

  it("returns null for markerless or unreadable state and warns", () => {
    assert.equal(parseState("plain comment"), null);
    assert.equal(parseState(null), null);
    const warnings = [];
    assert.equal(
      parseState("<!-- pr-quality-enforcer-state:{not json} -->", message =>
        warnings.push(message),
      ),
      null,
    );
    assert.match(warnings[0], /Could not parse stored workflow state/);
  });

  it("round-trips through stateMarker", () => {
    const state = { version: 1, active: false };
    assert.deepEqual(parseState(stateMarker(state)), state);
  });

  it("parses and serializes readiness state with warnings on failure", () => {
    const state = { version: 2, maintainersPinged: true };
    assert.deepEqual(
      parseReadinessState(
        `<!-- pr-quality-readiness-state:${JSON.stringify(state)} -->`,
      ),
      state,
    );
    assert.deepEqual(parseReadinessState(readinessStateMarker(state)), state);
    const warnings = [];
    assert.equal(
      parseReadinessState("<!-- pr-quality-readiness-state:{bad -->", m =>
        warnings.push(m),
      ),
      null,
    );
    assert.match(warnings[0], /Could not parse stored readiness state/);
  });
});

describe("state defaults", () => {
  it("builds the cleared enforcer state", () => {
    assert.deepEqual(clearedEnforcerState(), {
      version: 1,
      active: false,
      autoDraftedByBot: false,
      titlePrefixedByBot: false,
      ancestryFailed: false,
      descriptionFailed: false,
      screenshotFailed: false
    });
  });

  it("builds the fresh active enforcer state", () => {
    const state = defaultEnforcerState();
    assert.equal(state.active, true);
    assert.equal(state.version, 1);
  });

  it("builds the fresh readiness state at the current version", () => {
    assert.deepEqual(defaultReadinessState(), {
      version: READINESS_STATE_VERSION,
      autoDraftedByBot: false,
      maintainersPinged: false,
      completedAtHeadSha: null
    });
  });
});

describe("completionIsStale", () => {
  const base = {
    checklistRequired: true,
    readinessPresent: true,
    liveHeadSha: "2222222222222222222222222222222222222222"
  };

  it("is not stale when the recorded completion head matches the live head", () => {
    assert.equal(
      completionIsStale({
        ...base,
        checklistComplete: true,
        completionHeadSha: base.liveHeadSha,
        eventHeadSha: base.liveHeadSha
      }),
      false,
    );
  });

  it("is stale when the recorded head differs from the live head, even with an open checklist", () => {
    // Open checklist + mismatched recorded head is the partial-reset window.
    assert.equal(
      completionIsStale({
        ...base,
        checklistComplete: false,
        completionHeadSha: "1111111111111111111111111111111111111111",
        eventHeadSha: base.liveHeadSha
      }),
      true,
    );
  });

  it("is stale when ticks predate the live head on a first completion", () => {
    assert.equal(
      completionIsStale({
        ...base,
        checklistComplete: true,
        completionHeadSha: null,
        eventHeadSha: "1111111111111111111111111111111111111111"
      }),
      true,
    );
  });

  it("is not stale when ticks predate the live head but nothing is ticked", () => {
    assert.equal(
      completionIsStale({
        ...base,
        checklistComplete: false,
        completionHeadSha: null,
        eventHeadSha: "1111111111111111111111111111111111111111"
      }),
      false,
    );
  });
  it("is stale when a complete checklist has no recorded head on synchronize", () => {
    assert.equal(
      completionIsStale({
        ...base,
        checklistComplete: true,
        completionHeadSha: null,
        eventHeadSha: base.liveHeadSha,
        eventAction: "synchronize"
      }),
      true,
    );
  });

  it("is not stale for an unrecorded complete checklist on a non-synchronize event", () => {
    assert.equal(
      completionIsStale({
        ...base,
        checklistComplete: true,
        completionHeadSha: null,
        eventHeadSha: base.liveHeadSha,
        eventAction: "edited"
      }),
      false,
    );
  });

  it("is stale when the event delivered no head SHA at all (issue_comment rerun)", () => {
    // `issue_comment` events carry no `pull_request.head.sha`. The gate passes
    // an empty eventHeadSha so a completed checklist with no recorded head
    // cannot be accepted as attesting the live head on a comment-triggered
    // rerun — the contributor could have pushed since ticking the boxes.
    assert.equal(
      completionIsStale({
        ...base,
        checklistComplete: true,
        completionHeadSha: null,
        eventHeadSha: "",
        eventAction: "created"
      }),
      true,
    );
  });


  it("is not stale for maintainers or absent checklists", () => {
    assert.equal(
      completionIsStale({
        ...base,
        checklistRequired: false,
        checklistComplete: true,
        completionHeadSha: "1111111111111111111111111111111111111111",
        eventHeadSha: base.liveHeadSha
      }),
      false,
    );
    assert.equal(
      completionIsStale({
        ...base,
        readinessPresent: false,
        checklistComplete: true,
        completionHeadSha: "1111111111111111111111111111111111111111",
        eventHeadSha: base.liveHeadSha
      }),
      false,
    );
  });
});

describe("readinessClaimViolations", () => {
  it("passes when the head is current enough", () => {
    assert.deepEqual(readinessClaimViolations({ behindBase: 0 }), []);
    assert.deepEqual(readinessClaimViolations({ behindBase: 10 }), []);
  });

  it("never treats local CI as a bot-verifiable claim", () => {
    // Fork contributors attest local green; repository CI is maintainer-started.
    assert.deepEqual(
      readinessClaimViolations({ behindBase: 0, ciGreen: false }),
      [],
    );
  });

  it("flags a head more than the threshold behind the base", () => {
    assert.deepEqual(
      readinessClaimViolations({
        behindBase: READINESS_LATEST_DEV_BEHIND_MAX + 1,
      }),
      ["latest_dev"],
    );
  });

  it("fails closed when the behind count is unknown", () => {
    assert.deepEqual(
      readinessClaimViolations({
        behindBase: 0,
        behindUnknown: true,
      }),
      ["latest_dev"],
    );
  });

  it("honours a custom threshold", () => {
    assert.deepEqual(
      readinessClaimViolations({ behindBase: 5, behindMax: 4 }),
      ["latest_dev"],
    );
  });
});

describe("unresolvedFindingsClaim", () => {
  it("passes when there are no review threads at all", () => {
    assert.deepEqual(unresolvedFindingsClaim({ threads: [] }), {
      code: null,
      unresolved: 0,
      byBot: {},
    });
  });

  it("passes when every bot thread is resolved", () => {
    assert.deepEqual(
      unresolvedFindingsClaim({
        threads: [
          { isResolved: true, author: { login: "chatgpt-codex-connector[bot]" } },
          { isResolved: true, author: { login: "coderabbitai[bot]" } },
        ],
      }),
      { code: null, unresolved: 0, byBot: {} },
    );
  });

  it("flags one unresolved Codex thread and counts it per bot", () => {
    assert.deepEqual(
      unresolvedFindingsClaim({
        threads: [
          { isResolved: false, author: { login: "chatgpt-codex-connector[bot]" } },
          { isResolved: true, author: { login: "coderabbitai[bot]" } },
        ],
      }),
      {
        code: "review_findings",
        unresolved: 1,
        byBot: { "chatgpt-codex-connector[bot]": 1 },
      },
    );
  });

  it("flags unresolved threads from both bots and counts each", () => {
    assert.deepEqual(
      unresolvedFindingsClaim({
        threads: [
          { isResolved: false, author: { login: "chatgpt-codex-connector[bot]" } },
          { isResolved: false, author: { login: "chatgpt-codex-connector[bot]" } },
          { isResolved: false, author: { login: "coderabbitai[bot]" } },
        ],
      }),
      {
        code: "review_findings",
        unresolved: 3,
        byBot: {
          "chatgpt-codex-connector[bot]": 2,
          "coderabbitai[bot]": 1,
        },
      },
    );
  });

  it("ignores unresolved threads from humans", () => {
    assert.deepEqual(
      unresolvedFindingsClaim({
        threads: [
          { isResolved: false, author: { login: "wibias" } },
          { isResolved: false, author: null },
        ],
      }),
      { code: null, unresolved: 0, byBot: {} },
    );
  });

  it("fails closed on a thread with no resolution state", () => {
    // A thread whose isResolved is missing cannot be claimed resolved.
    assert.deepEqual(
      unresolvedFindingsClaim({
        threads: [{ isResolved: null, author: { login: "coderabbitai[bot]" } }],
      }),
      {
        code: "review_findings",
        unresolved: 1,
        byBot: { "coderabbitai[bot]": 1 },
      },
    );
  });

  it("exposes the bot allowlist", () => {
    assert.deepEqual(REVIEW_FINDINGS_BOT_LOGINS, [
      "chatgpt-codex-connector[bot]",
      "coderabbitai[bot]",
    ]);
  });
});

describe("coderabbitOutsideDiffFindings", () => {
  const HEAD = "3f1c0de0a6a4d0a3f9a1b2c3d4e5f60718293a4b";

  it("flags a CodeRabbit review of the live head with actionable comments", () => {
    const claim = coderabbitOutsideDiffFindings({
      reviews: [
        {
          body: "**Actionable comments posted: 3**\n\nSome walkthrough.",
          commit_id: HEAD,
          submitted_at: "2026-08-04T06:24:02Z",
          user: { login: "coderabbitai[bot]" },
        },
      ],
      liveHeadSha: HEAD,
    });
    assert.deepEqual(claim, {
      code: "review_findings",
      unresolved: 3,
      byBot: { "coderabbitai[bot]": 3 },
    });
  });

  it("ignores a review of a different head", () => {
    const claim = coderabbitOutsideDiffFindings({
      reviews: [
        {
          body: "**Actionable comments posted: 3**",
          commit_id: "1111111111111111111111111111111111111111",
          submitted_at: "2026-08-04T06:24:02Z",
          user: { login: "coderabbitai[bot]" },
        },
      ],
      liveHeadSha: HEAD,
    });
    assert.deepEqual(claim, { code: null, unresolved: 0, byBot: {} });
  });

  it("ignores a review reporting zero actionable comments", () => {
    const claim = coderabbitOutsideDiffFindings({
      reviews: [{ body: "**Actionable comments posted: 0**", commit_id: HEAD, user: { login: "coderabbitai[bot]" } }],
      liveHeadSha: HEAD,
    });
    assert.deepEqual(claim, { code: null, unresolved: 0, byBot: {} });
  });

  it("uses the most recent review of the live head", () => {
    const claim = coderabbitOutsideDiffFindings({
      reviews: [
        { body: "**Actionable comments posted: 2**", commit_id: HEAD, submitted_at: "2026-08-04T06:00:00Z", user: { login: "coderabbitai[bot]" } },
        { body: "**Actionable comments posted: 5**", commit_id: HEAD, submitted_at: "2026-08-04T07:00:00Z", user: { login: "coderabbitai[bot]" } },
      ],
      liveHeadSha: HEAD,
    });
    assert.equal(claim.unresolved, 5);
  });

  it("returns clean for no reviews or no live head", () => {
    assert.deepEqual(coderabbitOutsideDiffFindings({ reviews: [], liveHeadSha: HEAD }), {
      code: null,
      unresolved: 0,
      byBot: {},
    });
    assert.deepEqual(coderabbitOutsideDiffFindings({ reviews: [{ body: "**Actionable comments posted: 1**", commit_id: HEAD, user: { login: "coderabbitai[bot]" } }] }), {
      code: null,
      unresolved: 0,
      byBot: {},
    });
  });

  it("ignores a human review that quotes the actionable-comments line", () => {
    const claim = coderabbitOutsideDiffFindings({
      reviews: [
        {
          body: "CodeRabbit said **Actionable comments posted: 2** — let's discuss.",
          commit_id: HEAD,
          submitted_at: "2026-08-04T06:24:02Z",
          user: { login: "wibias" },
        },
      ],
      liveHeadSha: HEAD,
    });
    assert.deepEqual(claim, { code: null, unresolved: 0, byBot: {} });
  });

  it("sorts undated reviews last deterministically", () => {
    const claim = coderabbitOutsideDiffFindings({
      reviews: [
        { body: "**Actionable comments posted: 2**", commit_id: HEAD, user: { login: "coderabbitai[bot]" } },
        { body: "**Actionable comments posted: 5**", commit_id: HEAD, submitted_at: "2026-08-04T07:00:00Z", user: { login: "coderabbitai[bot]" } },
      ],
      liveHeadSha: HEAD,
    });
    // The dated review wins over the undated one, so 5 is the count.
    assert.equal(claim.unresolved, 5);
  });
});

describe("unresolvedFindingsClaim with outside-diff supplement", () => {
  const HEAD = "3f1c0de0a6a4d0a3f9a1b2c3d4e5f60718293a4b";

  it("does not count outside-diff when no unresolved bot thread exists", () => {
    // The review body is immutable; once the author resolves every thread the
    // supplement must not keep the box unticked forever (no empty commit).
    const claim = unresolvedFindingsClaim({
      threads: [],
      reviews: [{ body: "**Actionable comments posted: 2**", commit_id: HEAD, submitted_at: "2026-08-04T06:24:02Z", user: { login: "coderabbitai[bot]" } }],
      liveHeadSha: HEAD,
    });
    assert.deepEqual(claim, { code: null, unresolved: 0, byBot: {} });
  });

  it("adds the outside-diff count to an unresolved thread count", () => {
    const claim = unresolvedFindingsClaim({
      threads: [
        { isResolved: false, author: { login: "coderabbitai[bot]" } },
      ],
      reviews: [{ body: "**Actionable comments posted: 2**", commit_id: HEAD, submitted_at: "2026-08-04T06:24:02Z", user: { login: "coderabbitai[bot]" } }],
      liveHeadSha: HEAD,
    });
    assert.deepEqual(claim, {
      code: "review_findings",
      unresolved: 3,
      byBot: { "coderabbitai[bot]": 3 },
    });
  });

  it("keeps a resolved thread set clean even with a stale review", () => {
    const claim = unresolvedFindingsClaim({
      threads: [
        { isResolved: true, author: { login: "coderabbitai[bot]" } },
      ],
      reviews: [{ body: "**Actionable comments posted: 2**", commit_id: "1111111111111111111111111111111111111111", submitted_at: "2026-08-04T06:24:02Z", user: { login: "coderabbitai[bot]" } }],
      liveHeadSha: HEAD,
    });
    assert.deepEqual(claim, { code: null, unresolved: 0, byBot: {} });
  });
});

describe("gate state", () => {
  it("round-trips through gateStateMarker and parseGateState", () => {
    const state = defaultGateState();
    assert.deepEqual(parseGateState(gateStateMarker(state)), state);
  });

  it("returns null for markerless or unreadable gate state and warns", () => {
    assert.equal(parseGateState("plain comment"), null);
    assert.equal(parseGateState(null), null);
    const warnings = [];
    assert.equal(
      parseGateState("<!-- opencodex-pr-gate-state:{bad -->", m =>
        warnings.push(m),
      ),
      null,
    );
    assert.match(warnings[0], /Could not parse stored gate state/);
  });

  it("builds a fresh gate state", () => {
    assert.deepEqual(defaultGateState(), {
      version: 1,
      active: false,
      autoDraftedByBot: false,
      titlePrefixedByBot: false,
      maintainersPinged: false,
      completedAtHeadSha: null,
      reviewReadyLabeled: false,
    });
  });

  it("merges legacy enforcer + readiness states", () => {
    const merged = migrateLegacyGateState(
      { version: 1, active: true, autoDraftedByBot: true, titlePrefixedByBot: true },
      { version: 2, autoDraftedByBot: true, maintainersPinged: true, completedAtHeadSha: "abc123" },
    );
    assert.equal(merged.active, true);
    assert.equal(merged.autoDraftedByBot, true);
    assert.equal(merged.titlePrefixedByBot, true);
    assert.equal(merged.maintainersPinged, true);
    assert.equal(merged.completedAtHeadSha, "abc123");
    assert.equal(merged.reviewReadyLabeled, false);
  });

  it("keeps enforcer-owned auto-draft when the readiness record says false", () => {
    const merged = migrateLegacyGateState(
      { version: 1, active: true, autoDraftedByBot: true },
      { version: 2, autoDraftedByBot: false, maintainersPinged: true },
    );
    // Ownership is a union: the enforcer converted the PR to draft for a
    // quality failure, so the readiness record must not drop the restore path.
    assert.equal(merged.autoDraftedByBot, true);
  });

  it("migrates with either legacy state absent", () => {
    const onlyEnforcer = migrateLegacyGateState(
      { version: 1, active: true, titlePrefixedByBot: true },
      null,
    );
    assert.equal(onlyEnforcer.active, true);
    assert.equal(onlyEnforcer.titlePrefixedByBot, true);
    assert.equal(onlyEnforcer.completedAtHeadSha, null);

    const onlyReadiness = migrateLegacyGateState(
      null,
      { version: 2, maintainersPinged: true },
    );
    assert.equal(onlyReadiness.active, false);
    assert.equal(onlyReadiness.maintainersPinged, true);
  });
});
