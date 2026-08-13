"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  buildReviewReadinessSection
} = require("./pr-quality.cjs");
const {
  GATE_MARKER,
  HYGIENE_MARKER,
  HYGIENE_BLOCK_START,
  HYGIENE_BLOCK_END,
  inlineCode,
  readinessChecklistLines,
  buildGateCommentBody,
  extractHygieneSection,
  withHygieneSection,
  descriptionFailureLines,
  buildFailureSections,
  failureSummary,
  buildStaleNotice,
  buildClaimCheckNotice,
  buildFindingsClaimNotice
} = require("./pr-quality-messages.cjs");

const PR = {
  base: { ref: "main" },
  user: { login: "contributor" }
};
const ALLOWED_BASES = ["dev"];
const DEFAULT_BASE = "dev";

describe("inlineCode", () => {
  it("wraps values with a delimiter longer than any backtick run", () => {
    assert.equal(inlineCode("dev"), "`dev`");
    assert.equal(inlineCode("a`b"), "``a`b``");
    assert.equal(inlineCode("a``b"), "```a``b```");
    assert.equal(inlineCode(42), "`42`");
  });
});

describe("readinessChecklistLines", () => {
  it("mirrors per-item checked state", () => {
    const readiness = {
      items: [{ checked: true }, { checked: false }, { checked: true }, { checked: false }]
    };
    const lines = readinessChecklistLines(readiness);
    assert.equal(lines.length, 4);
    assert.match(lines[0], /^\- ✅ /);
    assert.match(lines[1], /^\- ⬜ /);
  });
});

describe("buildGateCommentBody", () => {
  const readiness = {
    present: true,
    complete: false,
    checked: 1,
    total: 4,
    items: [{ checked: true }, { checked: false }, { checked: false }, { checked: false }]
  };

  it("carries the marker, serialized state, status, mirror, and tick count", () => {
    const state = { version: 1, maintainersPinged: false };
    const body = buildGateCommentBody(state, {
      status: "DRAFT",
      statusReason: "review readiness checklist open (1/4 boxes ticked).",
      actions: ["Tick all four boxes in the PR description once you're done."],
      readiness,
      checklistRequired: true,
      notices: ["extra line"]
    }).join("\n");
    assert.ok(body.startsWith(GATE_MARKER));
    assert.ok(body.includes('<!-- opencodex-pr-gate-state:{"version":1'));
    assert.ok(body.includes("## ⏳ DRAFT"));
    assert.ok(body.includes("## What to do"));
    assert.ok(body.includes("Tick all four boxes"));
    assert.ok(body.includes("## Review readiness checklist"));
    assert.ok(body.includes("**1/4** boxes ticked."));
    assert.ok(body.includes("extra line"));
  });

  it("renders a ready status without a checklist when not required", () => {
    const body = buildGateCommentBody(
      { version: 1 },
      {
        status: "READY",
        statusReason: "this PR is ready for review.",
        actions: [],
        readiness: { present: false, complete: false, checked: 0, total: 0, items: [] },
        checklistRequired: false,
        notices: ["⚠️ **Wrong target branch**"]
      },
    ).join("\n");
    assert.ok(body.includes("## ✅ READY"));
    assert.ok(!body.includes("## Review readiness checklist"));
    assert.ok(!body.includes("boxes ticked"));
    assert.ok(body.includes("⚠️ **Wrong target branch**"));
  });

  it("does not claim ready when the PR is kept in draft", () => {
    const body = buildGateCommentBody(
      { version: 1 },
      {
        status: "DRAFT",
        statusReason: "PR is kept in draft.",
        actions: [],
        readiness,
        checklistRequired: true,
        notices: []
      },
    ).join("\n");
    assert.ok(!body.includes("READY"));
  });
});

describe("descriptionFailureLines", () => {
  it("covers every reason", () => {
    assert.match(descriptionFailureLines("empty").join(" "), /body is empty/);
    assert.match(descriptionFailureLines("placeholder").join(" "), /placeholder/);
    assert.match(
      descriptionFailureLines("escaped_newlines").join(" "),
      /literal `\\n` escape sequences/,
    );
    assert.match(descriptionFailureLines("thin").join(" "), /too thin/);
    assert.match(descriptionFailureLines("unknown").join(" "), /too thin/);
  });
});

describe("buildFailureSections", () => {
  it("builds a wrong-base section naming every allowed base", () => {
    const sections = buildFailureSections(
      [{ code: "wrong_base" }],
      { pr: PR, allowedBases: ALLOWED_BASES, defaultBase: DEFAULT_BASE },
    ).join("\n");
    assert.match(sections, /Wrong target branch/);
    assert.match(sections, /targets `main`/);
    assert.match(sections, /target one of `dev`/);
    assert.match(sections, /@contributor Please retarget this PR to `dev`/);
  });

  it("builds ancestry, description, and screenshot sections", () => {
    const sections = buildFailureSections(
      [
        { code: "wrong_ancestry" },
        { code: "bad_description", reason: "empty" },
        { code: "missing_ui_screenshot" }
      ],
      { pr: PR, allowedBases: ALLOWED_BASES, defaultBase: DEFAULT_BASE },
    ).join("\n");
    assert.match(sections, /Wrong branch ancestry/);
    assert.match(sections, /Pull request description/);
    assert.match(sections, /UI screenshot required/);
    assert.match(sections, /Rebase onto the current `main`/);
  });
});

describe("failureSummary", () => {
  it("names every failure kind", () => {
    assert.equal(
      failureSummary(
        [
          { code: "wrong_base" },
          { code: "wrong_ancestry" },
          { code: "bad_description", reason: "empty" },
          { code: "missing_ui_screenshot" },
          { code: "mystery" }
        ],
        { pr: PR },
      ),
      "wrong base (main); wrong ancestry; bad description (empty); missing UI screenshot; mystery",
    );
  });
});

describe("buildStaleNotice", () => {
  it("names the recorded and current heads when a completion drifted", () => {
    const notice = buildStaleNotice({
      completionHeadSha: "1111111111111111111111111111111111111111",
      liveHeadSha: "2222222222222222222222222222222222222222"
    });
    assert.match(notice[0], /completed on `1111111`; the current head is `2222222`/);
    assert.match(notice[1], /has been reset: re-test against the latest code/);
  });

  it("covers the never-recorded predate case", () => {
    const notice = buildStaleNotice({
      completionHeadSha: null,
      liveHeadSha: "2222222222222222222222222222222222222222"
    });
    assert.ok(notice[0].includes("ticked before the current head `2222222` was pushed"));
  });

  it("covers an unrecorded complete checklist on synchronize", () => {
    const notice = buildStaleNotice({
      completionHeadSha: null,
      liveHeadSha: "2222222222222222222222222222222222222222",
      eventAction: "synchronize"
    });
    assert.match(
      notice[0],
      /synchronize event with no recorded completion head/,
    );
    assert.ok(notice[0].includes("current head is `2222222`"));
  });

  it("matches the injected section text it resets", () => {
    // The notice must describe the exact state the reset produces: a fresh
    // unticked section from pr-quality.cjs.
    const section = buildReviewReadinessSection();
    assert.match(section, /\[ \] All CI tests are green on my local testing\./);
  });
});

describe("buildClaimCheckNotice", () => {
  it("names the latest-dev violation and the reset action", () => {
    const notice = buildClaimCheckNotice(
      ["latest_dev"],
      "3f1c0de0a6a4d0a3f9a1b2c3d4e5f60718293a4b",
    );
    assert.match(notice[0], /more than 10 commits behind `dev`/);
    assert.match(notice[0], /\*\*latest dev\*\* box has been unticked/);
    assert.match(notice[1], /reset: re-test against the latest code/);
  });

  it("ignores a stale ci_green code without inventing GitHub-CI copy", () => {
    const notice = buildClaimCheckNotice(["ci_green"], "a".repeat(40));
    assert.equal(notice.length, 1);
    assert.match(notice[0], /has been reset/);
    assert.doesNotMatch(notice[0], /CI is not green/);
  });

  it("returns only the reset line for an empty violation list", () => {
    const notice = buildClaimCheckNotice([], "a".repeat(40));
    assert.deepEqual(notice, [
      "The checklist has been reset: re-test against the latest code and tick the boxes again.",
    ]);
  });
});

describe("buildFindingsClaimNotice", () => {
  it("names each bot with unresolved threads and the untick", () => {
    const notice = buildFindingsClaimNotice({
      "chatgpt-codex-connector[bot]": 2,
      "coderabbitai[bot]": 1,
    });
    assert.match(notice[0], /Codex has 2 unresolved findings/);
    assert.match(notice[0], /\*\*Codex\/CodeRabbit findings\*\* box has been unticked/);
    assert.match(notice[1], /CodeRabbit has 1 unresolved finding/);
    assert.match(notice[2], /Resolve every open review conversation/);
  });

  it("handles a single bot with one thread", () => {
    const notice = buildFindingsClaimNotice({ "coderabbitai[bot]": 1 });
    assert.equal(notice.length, 2);
    assert.match(notice[0], /CodeRabbit has 1 unresolved finding/);
    assert.match(notice[1], /Resolve every open review conversation/);
  });
});

describe("hygiene section round-trip", () => {
  const GATE = [
    GATE_MARKER,
    '<!-- opencodex-pr-gate-state:{"version":1,"active":false} -->',
    "",
    "## ✅ READY",
    "- all PR quality gates passed.",
  ].join("\n");

  it("renders a hygiene block in the gate comment when requested", () => {
    const body = buildGateCommentBody(
      { version: 1, active: false },
      {
        status: "READY",
        statusReason: "all PR quality gates passed.",
        checklistRequired: false,
        hygiene: ["✅ **Deterministic PR hygiene checks passed.**"],
      },
    ).join("\n");
    assert.ok(body.includes(HYGIENE_BLOCK_START));
    assert.ok(body.includes(HYGIENE_BLOCK_END));
    assert.ok(body.includes(HYGIENE_MARKER));
    assert.ok(body.includes("✅ **Deterministic PR hygiene checks passed.**"));
  });

  it("extracts the hygiene content from a gate comment", () => {
    const withBlock = `${GATE}\n\n## Hygiene\n\n${HYGIENE_BLOCK_START}\n${HYGIENE_MARKER}\n\n✅ **Deterministic PR hygiene checks passed.**\n\n${HYGIENE_BLOCK_END}\n`;
    const extracted = extractHygieneSection(withBlock);
    assert.equal(extracted, "✅ **Deterministic PR hygiene checks passed.**");
    assert.equal(extractHygieneSection(GATE), null);
  });

  it("replaces an existing hygiene block without duplicating it", () => {
    const withBlock = `${GATE}\n\n## Hygiene\n\n${HYGIENE_BLOCK_START}\n${HYGIENE_MARKER}\n\n✅ **Deterministic PR hygiene checks passed.**\n\n${HYGIENE_BLOCK_END}\n`;
    const updated = withHygieneSection(withBlock, [
      "⚠️ **Deterministic hygiene checks failed.**",
      "- `missing_regression_test` — Behavior changed under `src/` without a test change.",
    ]);
    assert.ok(updated.includes("⚠️ **Deterministic hygiene checks failed.**"));
    assert.ok(!updated.includes("✅ **Deterministic PR hygiene checks passed.**"));
    assert.equal(updated.split(HYGIENE_BLOCK_START).length - 1, 1);
  });

  it("appends a hygiene block when the gate comment has none", () => {
    const updated = withHygieneSection(GATE, [
      "✅ **Deterministic PR hygiene checks passed.**",
    ]);
    assert.ok(updated.includes(HYGIENE_BLOCK_START));
    assert.ok(updated.includes("✅ **Deterministic PR hygiene checks passed.**"));
    assert.ok(updated.includes(GATE_MARKER));
  });

  it("ignores delimiter text embedded inside a hygiene content line", () => {
    // A contributor-controlled changed filename can contain delimiter text
    // mid-line (e.g. `src/<!-- pr-hygiene-block:end -->/x.ts`). The block
    // regex must anchor delimiters to complete lines so such a line neither
    // ends the block early nor corrupts the next rewrite.
    const malicious = [
      GATE_MARKER,
      '<!-- opencodex-pr-gate-state:{"version":1,"active":false} -->',
      "",
      "## ✅ READY",
      "- all PR quality gates passed.",
      "",
      "## Hygiene",
      "",
      HYGIENE_BLOCK_START,
      "<!-- pr-hygiene -->",
      "",
      "✅ **Deterministic PR hygiene checks passed.**",
      `- Paths: \`src/${HYGIENE_BLOCK_END}/x.ts\`.`,
      "",
      HYGIENE_BLOCK_END,
    ].join("\n");

    const extracted = extractHygieneSection(malicious);
    assert.ok(extracted);
    assert.ok(extracted.includes("✅ **Deterministic PR hygiene checks passed.**"));
    assert.ok(extracted.includes("Paths"));

    // Replacing must preserve the malicious line inside the block, not split
    // the block at the embedded delimiter.
    const updated = withHygieneSection(malicious, [
      "⚠️ **Deterministic hygiene checks failed.**",
    ]);
    assert.ok(updated.includes(HYGIENE_BLOCK_START));
    assert.ok(updated.includes(HYGIENE_BLOCK_END));
    assert.ok(updated.includes("⚠️ **Deterministic hygiene checks failed.**"));
    assert.equal(updated.split(HYGIENE_BLOCK_START).length - 1, 1);
    assert.equal(updated.split(HYGIENE_BLOCK_END).length - 1, 1);
  });

  it("preserves both sections across an interleaved gate rebuild and hygiene update", () => {
    // The gate and hygiene workflows share one concurrency group, but the
    // merge helpers must also be order-independent: whichever write lands
    // second must preserve the other's section. Start with a gate comment
    // carrying a hygiene block, apply a gate rebuild, then a hygiene update,
    // and assert both the gate status and the hygiene status survive.
    const withBlock = [
      GATE_MARKER,
      '<!-- opencodex-pr-gate-state:{"version":1,"active":false} -->',
      "",
      "## ✅ READY",
      "- all PR quality gates passed.",
      "",
      "## Hygiene",
      "",
      HYGIENE_BLOCK_START,
      "<!-- pr-hygiene -->",
      "",
      "✅ **Deterministic PR hygiene checks passed.**",
      "",
      HYGIENE_BLOCK_END,
    ].join("\n");

    // Gate rebuild (the gate rewrites its own section, preserving hygiene).
    const afterGate = buildGateCommentBody(
      { version: 1, active: false },
      {
        status: "READY",
        statusReason: "all PR quality gates passed.",
        checklistRequired: false,
        hygiene: ["✅ **Deterministic PR hygiene checks passed.**"],
      },
    ).join("\n");

    // Hygiene update (the hygiene workflow rewrites its block, preserving gate).
    const afterHygiene = withHygieneSection(afterGate, [
      "✅ **Deterministic PR hygiene checks passed.**",
    ]);

    assert.ok(afterHygiene.includes(GATE_MARKER));
    assert.ok(afterHygiene.includes("## ✅ READY"));
    assert.ok(afterHygiene.includes("✅ **Deterministic PR hygiene checks passed.**"));
    assert.equal(afterHygiene.split(HYGIENE_BLOCK_START).length - 1, 1);
    assert.equal(afterHygiene.split(HYGIENE_BLOCK_END).length - 1, 1);

    // Reverse order: hygiene first, then gate rebuild — same invariant.
    const afterHygieneFirst = withHygieneSection(withBlock, [
      "⚠️ **Deterministic hygiene checks failed.**",
      "- `missing_regression_test` — Behavior changed under `src/` without a test change.",
    ]);
    // The gate rebuild must consume the hygiene content the hygiene update
    // wrote, not a hard-coded copy — otherwise the test passes even if the
    // rebuild discards the prior update.
    const extractedHygiene = extractHygieneSection(afterHygieneFirst);
    assert.ok(extractedHygiene, "hygiene block must survive the hygiene update");
    const afterGateSecond = buildGateCommentBody(
      { version: 1, active: false },
      {
        status: "READY",
        statusReason: "all PR quality gates passed.",
        checklistRequired: false,
        hygiene: extractedHygiene.split("\n"),
      },
    ).join("\n");
    assert.ok(afterGateSecond.includes(GATE_MARKER));
    assert.ok(afterGateSecond.includes("## ✅ READY"));
    assert.ok(afterGateSecond.includes("⚠️ **Deterministic hygiene checks failed.**"));
    assert.equal(afterGateSecond.split(HYGIENE_BLOCK_START).length - 1, 1);
    assert.equal(afterGateSecond.split(HYGIENE_BLOCK_END).length - 1, 1);
  });
});
