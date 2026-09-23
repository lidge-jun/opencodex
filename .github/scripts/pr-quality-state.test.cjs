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
const {
  advanceReattestation,
  bodyDigest,
  parsePendingReattestation,
} = require("./pr-readiness-reattest.cjs");

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

  it("round-trips the pending re-attestation field through the gate marker", () => {
    const pendingReattestation = {
      version: 1,
      headSha: "a".repeat(40),
      baseRef: "dev",
      generation: 2,
      phase: "await-check",
      checkpointAt: "2026-09-22T01:00:00.000Z",
    };
    const state = { ...defaultGateState(), pendingReattestation };
    const parsed = parseGateState(gateStateMarker(state));
    assert.deepEqual(parsed, state);
    assert.deepEqual(parsePendingReattestation(parsed.pendingReattestation), {
      kind: "valid",
      value: pendingReattestation,
    });
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
      pendingReattestation: null,
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

describe("durable readiness re-attestation", () => {
  const HEAD_A = "a".repeat(40);
  const HEAD_B = "b".repeat(40);
  const CHECKPOINT = "2026-09-22T01:00:00.000Z";
  const LIVE_TIME = "2026-09-22T01:00:01.000Z";
  const body0 = "current checklist: 0/4";
  const body4 = "current checklist: 4/4";

  const readiness = checked => ({
    present: true,
    total: 4,
    checked,
    complete: checked === 4,
  });
  const live = (body, overrides = {}) => ({
    headSha: HEAD_A,
    baseRef: "dev",
    body,
    updatedAt: LIVE_TIME,
    authorId: 42,
    ...overrides,
  });
  const authorEdit = (body, previousBody, overrides = {}) => ({
    name: "pull_request_target",
    action: "edited",
    senderId: 42,
    senderType: "User",
    headSha: HEAD_A,
    body,
    previousBody,
    updatedAt: LIVE_TIME,
    ...overrides,
  });
  const finalize = (pending, checkpointAt) => ({ ...pending, checkpointAt });

  it("requires clear then recheck after a legacy 4/4 synchronize", () => {
    const seeded = advanceReattestation({
      pending: null,
      legacy: true,
      current: false,
      readiness: readiness(4),
      live: live("legacy checklist: 4/4"),
      event: { name: "pull_request_target", action: "synchronize", headSha: HEAD_A },
      checkpointAt: CHECKPOINT,
    });
    assert.deepEqual(seeded.pending, {
      version: 1,
      headSha: HEAD_A,
      baseRef: "dev",
      generation: 1,
      phase: "await-clear",
      checkpointAt: null,
    });
    assert.equal(seeded.canComplete, false);

    const wordingOnly = advanceReattestation({
      pending: finalize(seeded.pending, CHECKPOINT),
      legacy: false,
      current: true,
      readiness: readiness(4),
      live: live(body4),
      event: authorEdit(body4, "legacy checklist: 4/4"),
      checkpointAt: CHECKPOINT,
    });
    assert.equal(wordingOnly.pending.phase, "await-clear");
    assert.equal(wordingOnly.canComplete, false);
    assert.equal(wordingOnly.changed, false);

    const cleared = advanceReattestation({
      pending: finalize(wordingOnly.pending, CHECKPOINT),
      legacy: false,
      current: true,
      readiness: readiness(0),
      live: live(body0),
      event: authorEdit(body0, body4),
      checkpointAt: CHECKPOINT,
    });
    assert.equal(cleared.pending.phase, "await-check");
    assert.equal(cleared.pending.checkpointAt, null);
    assert.equal(cleared.canComplete, false);

    const attested = advanceReattestation({
      pending: finalize(cleared.pending, "2026-09-22T01:00:02.000Z"),
      legacy: false,
      current: true,
      readiness: readiness(4),
      live: live(body4, { updatedAt: "2026-09-22T01:00:03.000Z" }),
      event: authorEdit(body4, body0, { updatedAt: "2026-09-22T01:00:03.000Z" }),
      checkpointAt: "2026-09-22T01:00:02.000Z",
    });
    assert.equal(attested.pending.phase, "attested");
    assert.equal(attested.pending.attestedBodySha256, bodyDigest(body4));
    assert.equal(attested.pending.checkpointAt, null);
    assert.equal(attested.canComplete, false);
    const replay = advanceReattestation({
      pending: finalize(attested.pending, "2026-09-22T01:00:04.000Z"),
      legacy: false,
      current: true,
      readiness: readiness(4),
      live: live(body4, { updatedAt: "2026-09-22T01:00:03.000Z" }),
      event: {},
    });
    assert.equal(replay.canComplete, true);
  });

  it("parses only the discriminated persisted schema", () => {
    assert.deepEqual(parsePendingReattestation(null), { kind: "absent" });
    const awaiting = { version: 1, headSha: HEAD_A, baseRef: "dev", generation: 1, phase: "await-clear", checkpointAt: CHECKPOINT };
    assert.deepEqual(parsePendingReattestation(awaiting), { kind: "valid", value: awaiting });
    const githubTimestamp = { ...awaiting, checkpointAt: "2026-09-22T01:00:00Z" };
    assert.deepEqual(parsePendingReattestation(githubTimestamp), { kind: "valid", value: githubTimestamp });
    const attested = { ...awaiting, phase: "attested", attestedBodySha256: bodyDigest(body4) };
    assert.deepEqual(parsePendingReattestation(attested), { kind: "valid", value: attested });
    for (const malformed of [
      false,
      {},
      { ...awaiting, version: 2 },
      { ...awaiting, headSha: "abc" },
      { ...awaiting, baseRef: "" },
      { ...awaiting, generation: 0 },
      { ...awaiting, generation: 1.5 },
      { version: 1, headSha: HEAD_A, baseRef: "dev", generation: 1, phase: "await-clear" },
      { ...awaiting, checkpointAt: "2026-9-22T01:00:00Z" },
      { ...awaiting, checkpointAt: "not-a-time" },
      { ...awaiting, phase: "unknown" },
      { ...awaiting, attestedBodySha256: bodyDigest(body4) },
      { ...awaiting, phase: "attested" },
      { ...awaiting, phase: "attested", attestedBodySha256: "f".repeat(63) },
      { ...awaiting, futureField: true },
      { ...attested, futureField: true },
    ]) assert.equal(parsePendingReattestation(malformed).kind, "invalid");
  });

  it("seeds malformed stored state without consuming the current author event", () => {
    const result = advanceReattestation({
      pending: { version: 1, phase: "attested" },
      legacy: false,
      current: true,
      readiness: readiness(0),
      live: live(body0),
      event: authorEdit(body0, body4),
      checkpointAt: CHECKPOINT,
    });
    assert.equal(result.pending.phase, "await-clear");
    assert.equal(result.pending.checkpointAt, null);
    assert.equal(result.pending.generation, 1);
    assert.equal(result.canComplete, false);
  });

  it("does not advance or complete any provisional phase", () => {
    for (const pending of [
      { version: 1, headSha: HEAD_A, baseRef: "dev", generation: 1, phase: "await-clear", checkpointAt: null },
      { version: 1, headSha: HEAD_A, baseRef: "dev", generation: 1, phase: "await-check", checkpointAt: null },
      {
        version: 1,
        headSha: HEAD_A,
        baseRef: "dev",
        generation: 1,
        phase: "attested",
        attestedBodySha256: bodyDigest(body4),
        checkpointAt: null,
      },
    ]) {
      const checked = pending.phase === "await-clear" ? 0 : 4;
      const body = checked === 0 ? body0 : body4;
      const result = advanceReattestation({
        pending,
        legacy: false,
        current: true,
        readiness: readiness(checked),
        live: live(body),
        event: authorEdit(body, checked === 0 ? body4 : body0),
      });
      assert.deepEqual(result.pending, pending);
      assert.equal(result.canComplete, false);
      assert.equal(result.changed, false);
    }
  });

  it("uses the pending checkpoint and ignores an outer hygiene-comment timestamp", () => {
    const pending = {
      version: 1,
      headSha: HEAD_A,
      baseRef: "dev",
      generation: 2,
      phase: "await-clear",
      checkpointAt: CHECKPOINT,
    };
    const result = advanceReattestation({
      pending,
      legacy: false,
      current: true,
      readiness: readiness(0),
      live: live(body0),
      event: authorEdit(body0, body4),
      checkpointAt: "2099-01-01T00:00:00.000Z",
    });
    assert.equal(result.pending.phase, "await-check");
    assert.equal(result.pending.checkpointAt, null);
  });

  it("accepts a delayed author event when the live head and body remain unchanged", () => {
    const pending = { version: 1, headSha: HEAD_A, baseRef: "dev", generation: 2, phase: "await-clear", checkpointAt: CHECKPOINT };
    const result = advanceReattestation({
      pending,
      legacy: false,
      current: true,
      readiness: readiness(0),
      live: live(body0, { updatedAt: "2026-09-22T09:00:01.000Z" }),
      event: authorEdit(body0, body4),
    });
    assert.equal(result.pending.phase, "await-check");
    assert.equal(result.pending.checkpointAt, null);
  });

  it("rejects equal timestamps, title-only edits, and stale or reordered payloads", () => {
    const pending = { version: 1, headSha: HEAD_A, baseRef: "dev", generation: 2, phase: "await-clear", checkpointAt: CHECKPOINT };
    const cases = [
      authorEdit(body0, body4, { updatedAt: CHECKPOINT }),
      authorEdit(body0, undefined),
      authorEdit(body0, body4, { body: "stale event body" }),
      authorEdit(body0, body4, { headSha: HEAD_B }),
      authorEdit(body0, body4, { senderId: 7 }),
      authorEdit(body0, body4, { senderType: "Bot" }),
      authorEdit(body0, body4, { name: "status" }),
      authorEdit(body0, body4, { updatedAt: "2026-09-22T01:00:02.000Z" }),
    ];
    for (const event of cases) {
      const result = advanceReattestation({
        pending,
        legacy: false,
        current: true,
        readiness: readiness(0),
        live: live(body0, { updatedAt: event.updatedAt === CHECKPOINT ? CHECKPOINT : LIVE_TIME }),
        event,
        checkpointAt: CHECKPOINT,
      });
      assert.equal(result.pending.phase, "await-clear");
      assert.equal(result.changed, false);
      assert.equal(result.canComplete, false);
    }
  });

  it("rotates generation on head/base drift and meaningful invalidation without replay churn", () => {
    const pending = { version: 1, headSha: HEAD_A, baseRef: "dev", generation: 3, phase: "await-check", checkpointAt: CHECKPOINT };
    const moved = advanceReattestation({
      pending,
      legacy: false,
      current: true,
      readiness: readiness(0),
      live: live(body0, { headSha: HEAD_B }),
      event: {},
      checkpointAt: CHECKPOINT,
    });
    assert.equal(moved.pending.generation, 4);
    assert.equal(moved.pending.phase, "await-clear");
    assert.equal(moved.pending.checkpointAt, null);

    const retargeted = advanceReattestation({
      pending,
      legacy: false,
      current: true,
      readiness: readiness(0),
      live: live(body0, { baseRef: "feature-parent" }),
      event: {},
      checkpointAt: CHECKPOINT,
    });
    assert.equal(retargeted.pending.generation, 4);
    assert.equal(retargeted.pending.baseRef, "feature-parent");

    const invalidated = advanceReattestation({
      pending,
      legacy: false,
      current: true,
      readiness: readiness(0),
      live: live(body0),
      event: {},
      checkpointAt: CHECKPOINT,
      invalidate: true,
    });
    assert.equal(invalidated.pending.generation, 4);
    assert.equal(invalidated.pending.checkpointAt, null);
    const duplicate = advanceReattestation({
      pending: invalidated.pending,
      legacy: false,
      current: true,
      readiness: readiness(0),
      live: live(body0),
      event: {},
      checkpointAt: CHECKPOINT,
      invalidate: true,
    });
    assert.equal(duplicate.pending.generation, 4);
    assert.equal(duplicate.changed, false);
  });

  it("starts a conservative generation-one episode when the safe integer counter is exhausted", () => {
    const pending = {
      version: 1,
      headSha: HEAD_A,
      baseRef: "dev",
      generation: Number.MAX_SAFE_INTEGER,
      phase: "await-check",
      checkpointAt: CHECKPOINT,
    };
    const result = advanceReattestation({
      pending,
      legacy: false,
      current: true,
      readiness: readiness(0),
      live: live(body0, { headSha: HEAD_B }),
      event: {},
      checkpointAt: CHECKPOINT,
    });
    assert.equal(result.pending.phase, "await-clear");
    assert.equal(result.pending.generation, 1);
    assert.equal(result.pending.checkpointAt, null);
    assert.equal(parsePendingReattestation(result.pending).kind, "valid");
  });

  it("leaves partial current checklists waiting in both author phases", () => {
    for (const phase of ["await-clear", "await-check"]) {
      const pending = { version: 1, headSha: HEAD_A, baseRef: "dev", generation: 2, phase, checkpointAt: CHECKPOINT };
      const result = advanceReattestation({
        pending,
        legacy: false,
        current: true,
        readiness: readiness(2),
        live: live("current checklist: 2/4"),
        event: authorEdit("current checklist: 2/4", body0),
        checkpointAt: CHECKPOINT,
      });
      assert.equal(result.pending.phase, phase);
      assert.equal(result.canComplete, false);
      assert.equal(result.changed, false);
    }
  });

  it("invalidates an await-check proof when the managed body becomes malformed", () => {
    const pending = { version: 1, headSha: HEAD_A, baseRef: "dev", generation: 2, phase: "await-check", checkpointAt: CHECKPOINT };
    const result = advanceReattestation({
      pending,
      legacy: false,
      current: false,
      readiness: { present: true, total: 3, checked: 0, complete: false },
      live: live("malformed managed checklist"),
      event: authorEdit("malformed managed checklist", body0),
      checkpointAt: CHECKPOINT,
    });
    assert.equal(result.pending.phase, "await-clear");
    assert.equal(result.pending.generation, 3);
    assert.equal(result.canComplete, false);
  });

  it("accepts an attestation only for the exact current body and identity", () => {
    const attested = {
      version: 1,
      headSha: HEAD_A,
      baseRef: "dev",
      generation: 5,
      phase: "attested",
      attestedBodySha256: bodyDigest(body4),
      checkpointAt: CHECKPOINT,
    };
    const accepted = advanceReattestation({
      pending: attested,
      legacy: false,
      current: true,
      readiness: readiness(4),
      live: live(body4),
      event: {},
      checkpointAt: CHECKPOINT,
    });
    assert.equal(accepted.canComplete, true);
    assert.equal(accepted.changed, false);

    const changed = advanceReattestation({
      pending: attested,
      legacy: false,
      current: true,
      readiness: readiness(4),
      live: live(body4 + " edited"),
      event: {},
      checkpointAt: CHECKPOINT,
    });
    assert.equal(changed.canComplete, false);
    assert.equal(changed.pending.phase, "await-clear");
    assert.equal(changed.pending.generation, 6);
  });

  it("fails closed for invalid live identity and hashes UTF-8 bodies deterministically", () => {
    assert.equal(bodyDigest("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    const result = advanceReattestation({
      pending: null,
      legacy: true,
      current: false,
      readiness: readiness(4),
      live: live("legacy", { headSha: "not-a-real-head" }),
      event: {},
      checkpointAt: CHECKPOINT,
    });
    assert.deepEqual(result, {
      pending: null,
      canComplete: false,
      changed: false,
      invalidIdentity: true,
    });
  });
});
