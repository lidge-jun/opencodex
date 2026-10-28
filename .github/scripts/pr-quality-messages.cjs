"use strict";

const {
  REVIEW_READINESS_ITEMS
} = require("./pr-quality.cjs");
const {
  readinessStateMarker,
  gateStateMarker,
  READINESS_LATEST_DEV_BEHIND_MAX
} = require("./pr-quality-state.cjs");

/**
 * Legacy marker for the pre-consolidation readiness comment. It is matched
 * only to migrate and delete old comments; the gate never writes it.
 */
const READINESS_MARKER = "<!-- pr-quality-readiness -->";
/** Marks the bot's consolidated PR gate message. */
const GATE_MARKER = "<!-- opencodex-pr-gate -->";
/** Marks the hygiene status block inside the consolidated gate comment. */
const HYGIENE_MARKER = "<!-- pr-hygiene -->";
/** HTML comment wrapping the hygiene block so it survives gate rebuilds. */
const HYGIENE_BLOCK_START = "<!-- pr-hygiene-block:start -->";
const HYGIENE_BLOCK_END = "<!-- pr-hygiene-block:end -->";
/**
 * Both delimiters must occupy a complete line. A contributor-controlled
 * hygiene line (for example a changed filename) can otherwise embed delimiter
 * text mid-line and corrupt the block boundary on the next rewrite.
 */
const HYGIENE_BLOCK_RE = new RegExp(
  `^[ \\t]*${HYGIENE_BLOCK_START}[ \\t]*\\n([\\s\\S]*?)\\n[ \\t]*${HYGIENE_BLOCK_END}[ \\t]*$`,
  "m"
);
/**
 * Whole-line delimiter matchers, the same shape HYGIENE_BLOCK_RE anchors on.
 * A block is only read when each delimiter occurs on exactly one line: a
 * changed filename can contain newlines, so an echoed path can add delimiter
 * lines, and an ambiguous block must never be cut at the first one.
 */
const HYGIENE_BLOCK_START_LINE_RE = new RegExp(`^[ \\t]*${HYGIENE_BLOCK_START}[ \\t]*$`, "gm");
const HYGIENE_BLOCK_END_LINE_RE = new RegExp(`^[ \\t]*${HYGIENE_BLOCK_END}[ \\t]*$`, "gm");

function countDelimiterLines(text, pattern) {
  return (text.match(pattern) ?? []).length;
}

function inlineCode(value) {
  const text = String(value);
  const longestBacktickRun = Math.max(
    0,
    ...(text.match(/`+/g) ?? []).map(run => run.length)
  );
  const delimiter = "`".repeat(longestBacktickRun + 1);
  return `${delimiter}${text}${delimiter}`;
}

/**
 * Render contributor-supplied text (a changed path) on one line: control
 * characters, including newlines, become `\uXXXX` escapes. Without this an
 * echoed path could add whole lines, such as delimiter or record lines, to a
 * bot comment.
 */
function escapeControlCharacters(value) {
  return String(value).replace(
    /[\u0000-\u001f\u007f\u2028\u2029]/g,
    character => "\\u" + character.charCodeAt(0).toString(16).padStart(4, "0")
  );
}

/** The consolidated gate comment: written by the workflow bot, marker first. */
function isGateComment(comment) {
  return (
    comment?.user?.login === "github-actions[bot]" &&
    typeof comment.body === "string" &&
    comment.body.startsWith(GATE_MARKER)
  );
}

/** The standalone hygiene comment posted before a gate comment exists. */
function isStandaloneHygieneComment(comment) {
  return (
    comment?.user?.login === "github-actions[bot]" &&
    typeof comment.body === "string" &&
    comment.body.startsWith(HYGIENE_MARKER)
  );
}

function readinessChecklistLines(readiness) {
  return REVIEW_READINESS_ITEMS.map(
    (item, index) =>
      `- ${readiness.items?.[index]?.checked ? "✅" : "⬜"} ${item}`
  );
}

/**
 * The consolidated PR-gate comment body. It is the single always-present bot
 * message on a contributor PR and carries everything the author needs: current
 * status, actionable next steps, the readiness-checklist mirror, and the draft
 * reason. The whole body is rebuilt every run and written exactly once, so it
 * always reflects the current state and can never be double-edited.
 *
 * @param {object} state  serialized gate state (for the embedded marker).
 * @param {object} opts
 * @param {string} opts.status  "DRAFT" or "READY".
 * @param {string} opts.statusReason  one-line why.
 * @param {string[]} opts.actions  actionable "What to do" lines (rendered as bullets).
 * @param {object} opts.readiness  extractReviewReadiness result (mirror + tick count).
 * @param {boolean} opts.checklistRequired
 * @param {string[]} opts.notices  extra lines (claim/stale/review-requested).
 */
function buildGateCommentBody(state, opts) {
  const {
    status,
    statusReason,
    actions = [],
    readiness,
    checklistRequired = true,
    notices = [],
    hygiene
  } = opts;
  const complete = readiness?.present && readiness?.complete;
  const statusEmoji = status === "READY" ? "✅" : "⏳";

  return [
    GATE_MARKER,
    gateStateMarker(state),
    "",
    `## ${statusEmoji} ${status}`,
    statusReason ? `- ${statusReason}` : "",
    "",
    ...(actions.length > 0
      ? ["## What to do", "", ...actions.map(line => `- ${line}`), ""]
      : []),
    ...(checklistRequired && readiness?.present
      ? [
          "## Review readiness checklist",
          "",
          ...readinessChecklistLines(readiness),
          "",
          complete
            ? "✅ **4/4** boxes ticked."
            : `**${readiness.checked}/${readiness.total}** boxes ticked.`,
          ""
        ]
      : []),
    ...(hygiene && hygiene.length > 0
      ? [
          "## Hygiene",
          "",
          HYGIENE_BLOCK_START,
          HYGIENE_MARKER,
          "",
          ...hygiene,
          "",
          HYGIENE_BLOCK_END,
          ""
        ]
      : []),
    ...notices
  ].filter(line => line !== null && line !== undefined);
}

/**
 * The hygiene status block as stored inside the consolidated gate comment, or
 * `null` when the comment has none. The gate rebuilds its body from scratch
 * every run, so without this round-trip a hygiene update from the separate
 * hygiene workflow would be silently dropped on the next gate write.
 * An ambiguous block (a delimiter on more than one line) reads as `null`, so
 * the gate drops it on rebuild instead of re-wrapping a truncated section.
 */
function extractHygieneSection(body) {
  if (typeof body !== "string") return null;
  if (
    countDelimiterLines(body, HYGIENE_BLOCK_START_LINE_RE) !== 1 ||
    countDelimiterLines(body, HYGIENE_BLOCK_END_LINE_RE) !== 1
  ) {
    return null;
  }
  const match = body.match(HYGIENE_BLOCK_RE);
  if (!match) return null;
  return match[1]
    .split("\n")
    .map(line => line.trim())
    .filter(line => line !== "" && line !== HYGIENE_MARKER)
    .join("\n");
}

/**
 * Insert (or replace) a hygiene block in a gate-comment body. Used by the
 * hygiene workflow to write its status into the single consolidated comment
 * instead of posting a second bot message.
 */
function withHygieneSection(body, hygieneLines) {
  const base = typeof body === "string" ? body : "";
  const block = [
    HYGIENE_BLOCK_START,
    HYGIENE_MARKER,
    "",
    ...hygieneLines,
    "",
    HYGIENE_BLOCK_END
  ].join("\n");

  if (HYGIENE_BLOCK_RE.test(base)) {
    // A callback, not a replacement string: echoed paths can contain $&, $1
    // and similar tokens that a template would expand into extra lines.
    return base.replace(HYGIENE_BLOCK_RE, () => block);
  }

  // No existing block: append one at the end.
  return `${base.replace(/\s+$/, "")}\n\n## Hygiene\n\n${block}\n`;
}

/**
 * The text the hygiene workflow last wrote for this pull request: the hygiene
 * block of the first bot comment that starts with GATE_MARKER, or the first
 * bot comment that starts with HYGIENE_MARKER while that gate comment has no
 * block yet (the gate never absorbs it). A marker elsewhere in a comment does
 * not classify it. An ambiguous gate block yields `null`; later comments are
 * never searched for a more convenient candidate.
 */
function authoritativeHygieneSection(comments) {
  const list = comments ?? [];
  const gate = list.find(isGateComment);
  if (gate) {
    const section = extractHygieneSection(gate.body);
    if (section !== null) return section;
    if (
      countDelimiterLines(gate.body, HYGIENE_BLOCK_START_LINE_RE) > 0 ||
      countDelimiterLines(gate.body, HYGIENE_BLOCK_END_LINE_RE) > 0
    ) {
      return null;
    }
  }
  const standalone = list.find(isStandaloneHygieneComment);
  return standalone ? standalone.body : null;
}

function descriptionFailureLines(reason) {
  switch (reason) {
    case "empty":
      return [
        "The pull request body is empty after stripping HTML comments.",
        "",
        "Include a real description: a **Summary** of what changed and why, plus a **Test plan** (or equivalent substance)."
      ];
    case "placeholder":
      return [
        "The pull request body contains only placeholder text (for example `N/A`, `TODO`, or `No response`).",
        "",
        "Replace placeholders with a **Summary** and **Test plan**, or another description with at least two substantive sections or paragraphs."
      ];
    case "escaped_newlines":
      return [
        "The pull request body uses literal `\\n` escape sequences instead of real line breaks.",
        "",
        "Fix the formatting so the body uses normal markdown line breaks, then add a **Summary** and **Test plan**."
      ];
    case "thin":
    default:
      return [
        "The pull request description is too thin to review.",
        "",
        "Add a **Summary** and **Test plan** (two sections with at least 40 characters each), or an unstructured body of at least 120 characters with two paragraphs or bullet groups."
      ];
  }
}

function buildFailureSections(failures, { pr, allowedBases, defaultBase }) {
  const sections = [];

  if (failures.some(failure => failure.code === "wrong_base")) {
    sections.push(
      "⚠️ **Wrong target branch**",
      "",
      `This pull request currently targets ${inlineCode(pr.base.ref)}, but pull requests must target one of ${allowedBases.map(inlineCode).join(" or ")}.`,
      "",
      `@${pr.user.login} Please retarget this PR to ${inlineCode(defaultBase)}. All contributions go to ${inlineCode(defaultBase)}; \`main\` receives only release promotions. See our [Contributing guide](https://lidge-jun.github.io/opencodex/contributing/) for details. Thanks! 🙏`
    );
  }

  if (failures.some(failure => failure.code === "wrong_ancestry")) {
    sections.push(
      "⚠️ **Wrong branch ancestry**",
      "",
      `This pull request targets ${inlineCode(pr.base.ref)}, but its head appears to sit on the current ${inlineCode("main")} tip while being far behind ${inlineCode(pr.base.ref)}.`,
      "",
      `@${pr.user.login} Rebase onto the current ${inlineCode(pr.base.ref)} branch instead of opening from ${inlineCode("main")}. That keeps already-released commits out of the integration branch.`
    );
  }

  const badDescription = failures.find(
    failure => failure.code === "bad_description"
  );
  if (badDescription) {
    sections.push(
      "⚠️ **Pull request description**",
      "",
      ...descriptionFailureLines(badDescription.reason)
    );
  }

  if (
    failures.some(
      failure => failure.code === "missing_ui_screenshot"
    )
  ) {
    sections.push(
      "⚠️ **UI screenshot required**",
      "",
      `This pull request changes files under ${inlineCode("gui/")}, or GitHub returned an incomplete changed-file list for a large diff, so it is treated as a GUI change.`,
      "",
      `@${pr.user.login} Please add a screenshot of the UI change to the description — drag and drop the image into the description editor, or paste a markdown image such as ${inlineCode("![Screenshot](https://example.com/after.png)")}. The check re-runs automatically once the description is edited.`
    );
  }

  return sections;
}

function failureSummary(failures, { pr }) {
  return failures
    .map(failure => {
      if (failure.code === "wrong_base") {
        return `wrong base (${pr.base.ref})`;
      }
      if (failure.code === "wrong_ancestry") {
        return "wrong ancestry";
      }
      if (failure.code === "bad_description") {
        return `bad description (${failure.reason})`;
      }
      if (failure.code === "missing_ui_screenshot") {
        return "missing UI screenshot";
      }
      return failure.code;
    })
    .join("; ");
}

/** The notice shown when the gate's own claim check disproves a ticked box. */
function buildClaimCheckNotice(violations, _liveHeadSha) {
  const lines = [];
  for (const code of violations) {
    if (code === "latest_dev") {
      lines.push(
        `The PR is more than ${READINESS_LATEST_DEV_BEHIND_MAX} commits behind ${inlineCode("dev")}; the **latest dev** box has been unticked.`
      );
    }
  }
  lines.push(
    "The checklist has been reset: re-test against the latest code and tick the boxes again."
  );
  return lines;
}

/**
 * The notice shown when the gate's own findings check disproves the
 * Codex/CodeRabbit findings box. `byBot` maps each review-bot login to its
 * unresolved finding count (inline threads plus, for CodeRabbit, findings it
 * posted only in its review body because they fell outside the diff range).
 * The box is unticked and the PR stays a draft until every finding is
 * resolved.
 */
function buildFindingsClaimNotice(byBot) {
  const names = {
    "chatgpt-codex-connector[bot]": "Codex",
    "coderabbitai[bot]": "CodeRabbit"
  };
  const lines = [];
  for (const [login, count] of Object.entries(byBot)) {
    const label = names[login] ?? login;
    lines.push(
      `${label} has ${count} unresolved finding${count === 1 ? "" : "s"}; the **Codex/CodeRabbit findings** box has been unticked.`
    );
  }
  lines.push(
    "Resolve every open review conversation on this pull request, then re-tick the box."
  );
  return lines;
}

/** The reset notice shown when a completion no longer covers the live head. */
function buildStaleNotice({ completionHeadSha, liveHeadSha, eventAction }) {
  let lead;
  if (completionHeadSha !== null) {
    lead = `New commits were pushed after the checklist was completed on ${inlineCode(String(completionHeadSha).slice(0, 7))}; the current head is ${inlineCode(liveHeadSha.slice(0, 7))}.`;
  } else if (eventAction === "synchronize") {
    lead = `A complete checklist was found on a synchronize event with no recorded completion head; the current head is ${inlineCode(liveHeadSha.slice(0, 7))}.`;
  } else {
    lead = `The checklist was ticked before the current head ${inlineCode(liveHeadSha.slice(0, 7))} was pushed.`;
  }
  return [
    lead,
    "The checklist has been reset: re-test against the latest code and tick all four boxes again."
  ];
}

module.exports = {
  READINESS_MARKER,
  GATE_MARKER,
  HYGIENE_MARKER,
  HYGIENE_BLOCK_START,
  HYGIENE_BLOCK_END,
  inlineCode,
  escapeControlCharacters,
  isGateComment,
  isStandaloneHygieneComment,
  readinessChecklistLines,
  buildGateCommentBody,
  extractHygieneSection,
  withHygieneSection,
  authoritativeHygieneSection,
  descriptionFailureLines,
  buildFailureSections,
  failureSummary,
  buildStaleNotice,
  buildClaimCheckNotice,
  buildFindingsClaimNotice
};
