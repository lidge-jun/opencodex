"use strict";

const path = require("node:path");
const {
  clean,
  isPlaceholderOnlyValue,
  hasSubstantialStructuredContent,
} = require(path.join(__dirname, "issue-quality.cjs"));

const ANCESTRY_BEHIND_THRESHOLD = 20;
/** Cap on ahead_by vs main so stale `dev` forks (many commits ahead of main) are not flagged. */
const ANCESTRY_AHEAD_MAIN_MAX = 5;
const MIN_SECTION_LEN = 40;
const MIN_RICH_SECTIONS = 2;
const UNSTRUCTURED_MIN_LEN = 120;
const UNSTRUCTURED_MIN_BLOCKS = 2;

/** HTML markers bounding the bot-managed review-readiness checklist in the PR body. */
const REVIEW_READINESS_START = "<!-- pr-quality-readiness-checklist:start -->";
const REVIEW_READINESS_END = "<!-- pr-quality-readiness-checklist:end -->";

/**
 * The four self-attestation boxes a non-maintainer author must tick before the
 * gate lifts the draft. The final box is intentionally set off by a blank line
 * so the "ready" claim reads as the closing confirmation, not a fourth task.
 */
const REVIEW_READINESS_ITEMS = [
  "All CI tests are green on my local testing.",
  "I pushed my PR to the latest dev commit.",
  "I resolved all correct Codex and CodeRabbit findings.",
  "My PR is ready for review.",
];

/**
 * Which checklist box each bot-verifiable claim maps to. The order must stay
 * in sync with REVIEW_READINESS_ITEMS: index 1 is the latest-dev claim and
 * index 2 is the Codex/CodeRabbit findings claim. Index 0 (local CI) is an
 * author attestation only — fork contributors cannot start repository CI — so
 * the gate never disproves it; head-drift still resets every box.
 */
const REVIEW_READINESS_CLAIM_INDEX = {
  latest_dev: 1,
  review_findings: 2
};

/**
 * Exact instruction / checklist lines from `.github/PULL_REQUEST_TEMPLATE.md`.
 * Untouched templates must not count as substance.
 */
const PR_TEMPLATE_BOILERPLATE_LINES = new Set([
  "explain the user-visible or maintainer-facing change.",
  "list the commands or checks you ran.",
  "if this pr changes the gui, include a screenshot of the ui change in the description.",
  "scope stays focused and avoids unrelated cleanup.",
  "docs or release notes were updated when needed.",
  "security-sensitive changes were reviewed for secrets, auth, and unsafe defaults.",
]);

/** Case-insensitive whole-word match for the GUI surface (repo convention: `gui/`). */
const GUI_CUE_RE = /\bgui\b/i;
/** HTML comments, which GitHub never renders. An unclosed comment runs through EOF. */
const HTML_COMMENT_RE = /<!--[\s\S]*?(?:-->|$)/g;
/** Fenced code blocks (``` or ~~~) whose content GitHub does not render. */
const FENCED_CODE_RE = /(?:^|\n)[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^[ \t]*\1[ \t]*(?=\n|$)/gm;
/** Embedded markdown image (`![alt](url)`), as GitHub renders for dropped images. */
const MARKDOWN_IMAGE_RE = /!\[[^\]]*\]\([^)]+\)/;
/** Reference-style markdown image (`![alt][id]`, collapsed `![alt][]`). */
const MARKDOWN_REFERENCE_IMAGE_RE = /!\[([^\]]*)\]\[([^\]]*)\]/g;
/** Link definitions (`[id]: url`) that reference-style images depend on. */
const MARKDOWN_REFERENCE_DEF_RE = /^\s*\[([^\]]+)\]:\s*\S+/gm;
/** Embedded HTML image with a renderable `src` (`<img ... src="...">`). */
const HTML_IMAGE_RE = /<img\b[^>]*\bsrc\s*=\s*(?:"[^"]+"|'[^']+'|[^\s>"']+)[^>]*>/i;

function isWrongAncestry({
  behindMain,
  behindBase,
  aheadMain = 0,
  threshold = ANCESTRY_BEHIND_THRESHOLD,
  aheadMainMax = ANCESTRY_AHEAD_MAIN_MAX,
}) {
  return (
    behindMain === 0 &&
    behindBase >= threshold &&
    aheadMain <= aheadMainMax
  );
}

function authorHasPushPermission(permission) {
  return permission === "admin" || permission === "maintain" || permission === "write";
}

/**
 * True when the body uses literal backslash-n as the dominant line break
 * (agent bug seen on #644) rather than real newlines.
 */
function hasEscapedNewlines(text) {
  const escaped = (text.match(/\\n/g) || []).length;
  if (escaped < 2) return false;
  const real = (text.match(/\n/g) || []).length;
  return escaped > real;
}

function countContentBlocks(text) {
  const blocks = text
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter(Boolean);
  if (blocks.length >= 2) return blocks.length;
  const bullets = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^[-*+]\s+\S/.test(l));
  return Math.max(blocks.length, bullets.length);
}

function normalizeTemplateLine(line) {
  return line
    .replace(/^\s*[-*+]\s+/, "")
    .replace(/^\s*\[[ xX]\]\s+/, "")
    .replace(/^\s*#{1,6}\s+/, "")
    .trim()
    .toLowerCase();
}

/** Drop stock PR template headings, instructions, and checklist lines. */
function stripPrTemplateBoilerplate(text) {
  return text
    .split("\n")
    .filter((line) => {
      const normalized = normalizeTemplateLine(line);
      if (!normalized) return true;
      if (PR_TEMPLATE_BOILERPLATE_LINES.has(normalized)) return false;
      if (/^(summary|verification|checklist)$/.test(normalized)) return false;
      return true;
    })
    .join("\n");
}

function assessPrDescription(body) {
  const withoutReadiness = stripReviewReadinessSection(body);
  if (typeof withoutReadiness !== "string" || !withoutReadiness.trim()) {
    return { ok: false, reason: "empty" };
  }
  if (hasEscapedNewlines(withoutReadiness)) {
    return { ok: false, reason: "escaped_newlines" };
  }
  const withoutTemplate = stripPrTemplateBoilerplate(withoutReadiness);
  const cleaned = clean(withoutTemplate);
  if (!cleaned) {
    const strippedComments = withoutTemplate.replace(HTML_COMMENT_RE, "").trim();
    if (!strippedComments) return { ok: false, reason: "empty" };
    if (isPlaceholderOnlyValue(strippedComments)) {
      return { ok: false, reason: "placeholder" };
    }
    return { ok: false, reason: "empty" };
  }
  if (isPlaceholderOnlyValue(cleaned)) {
    return { ok: false, reason: "placeholder" };
  }
  if (hasSubstantialStructuredContent(cleaned, MIN_SECTION_LEN, MIN_RICH_SECTIONS)) {
    return { ok: true };
  }
  if (
    cleaned.length >= UNSTRUCTURED_MIN_LEN &&
    countContentBlocks(cleaned) >= UNSTRUCTURED_MIN_BLOCKS
  ) {
    return { ok: true };
  }
  return { ok: false, reason: "thin" };
}

/**
 * True when any changed path is the gui directory or inside it (slash-guarded).
 * Mirrors `guiPathsChanged` in `scripts/doctor-gui-if-changed.ts`.
 */
function guiPathsChanged(files) {
  return files.some(
    (file) => file === "gui" || file.startsWith("gui/")
  );
}

/**
 * True when the changed-file list from `pulls.listFiles` cannot be trusted to
 * be complete for screenshot gating. Missing or non-integer counts, a head
 * mismatch between the count snapshot and the paginated list, or a count above
 * the returned list length all fail closed.
 */
function isChangedFileListTruncated(changedFilesCount, listedLength, headMatches = true) {
  if (!headMatches) return true;
  if (!Number.isInteger(changedFilesCount) || changedFilesCount < 0) return true;
  return changedFilesCount > listedLength;
}

/**
 * True when the PR title or description names the GUI surface as a whole word.
 * The description is template-stripped first so the template's own screenshot
 * instruction cannot arm the gate on its own. Negated phrases such as "no gui
 * changes" are not treated as cues (see `segmentHasAffirmativeGuiCue`).
 */
function segmentHasAffirmativeGuiCue(text) {
  if (typeof text !== "string" || !text.trim()) return false;
  const segments = text.split(/(?<=[.!?\n])/);
  return segments.some((segment) => {
    if (!GUI_CUE_RE.test(segment)) return false;
    const withoutNegated = segment.replace(GUI_OVERRIDE_RE, "");
    return GUI_CUE_RE.test(withoutNegated);
  });
}

function hasGuiCue(title, body) {
  return segmentHasAffirmativeGuiCue(title) || segmentHasAffirmativeGuiCue(body);
}

/**
 * Phrases in a maintainer comment that waive the GUI-screenshot gate. A
 * comment saying the change does not touch the GUI means the `gui` cue in the
 * title/description is a false positive and a screenshot is not required. The
 * negation word must appear within a short window before `gui`, so a comment
 * like "this touches gui but only the config" (no negation) keeps the gate.
 * The window cannot cross a sentence or line boundary: "This does not change
 * the API. Please add a gui screenshot." must not waive the gate.
 */
const GUI_OVERRIDE_RE =
  /\b(?:no|not|doesn'?t|does not|never|without)\b[^.!?\n]{0,40}?\bgui\b/i;

/**
 * True when a maintainer (OWNER / COLLABORATOR / MEMBER) issue comment waives
 * the GUI-screenshot requirement. Only the comment author's association
 * counts: the PR author (`CONTRIBUTOR`/`NONE`) cannot override their own
 * screenshot requirement.
 */
function hasGuiOverride({ comments = [] }) {
  return comments.some(
    comment =>
      (comment?.author_association === "OWNER" ||
        comment?.author_association === "COLLABORATOR" ||
        comment?.author_association === "MEMBER") &&
      typeof comment?.body === "string" &&
      GUI_OVERRIDE_RE.test(comment.body)
  );
}

/**
 * Drop the regions GitHub does not render as Markdown: HTML comments and
 * fenced code blocks. Image syntax there is literal text, not evidence.
 */
function stripNonRenderedRegions(body) {
  // Fenced code MUST be removed first. GFM treats fence contents as literal
  // text, so a `<!--` inside a fence never opens an HTML comment. Stripping
  // comments first let an unclosed comment-like literal in a code sample run
  // through EOF and swallow the real body after it, which rejected valid
  // descriptions: a GUI PR whose screenshot followed such an example lost its
  // evidence, and an issue lost the sections it was validated on.
  return body.replace(FENCED_CODE_RE, "").replace(HTML_COMMENT_RE, "");
}

/**
 * True when the description contains a reference-style image (`![alt][id]` or
 * collapsed `![alt][]`) backed by a matching `[id]: url` definition — GitHub
 * renders only those reference images, so a bare token is not evidence.
 */
function hasRenderableReferenceImage(visible) {
  const definitions = new Set();
  for (const match of visible.matchAll(MARKDOWN_REFERENCE_DEF_RE)) {
    definitions.add(match[1].trim().toLowerCase());
  }
  if (definitions.size === 0) return false;
  for (const match of visible.matchAll(MARKDOWN_REFERENCE_IMAGE_RE)) {
    const id = (match[2] || match[1]).trim().toLowerCase();
    if (id && definitions.has(id)) return true;
  }
  return false;
}

/**
 * True when the rendered description embeds a screenshot image: an inline
 * markdown image, a reference-style image with a definition, or an `<img>` tag
 * with a non-empty `src`. A plain link to an image is not visual evidence.
 */
function hasScreenshotEvidence(body) {
  if (typeof body !== "string") return false;
  const visible = stripNonRenderedRegions(body);
  if (MARKDOWN_IMAGE_RE.test(visible)) return true;
  if (HTML_IMAGE_RE.test(visible)) return true;
  return hasRenderableReferenceImage(visible);
}

/**
 * The tickable checklist section injected into the PR description. It lives in
 * the body (the author can tick it) and is bounded by HTML markers so the gate
 * can find exactly this section and ignore any other task list in the body.
 */
function buildReviewReadinessSection() {
  const items = REVIEW_READINESS_ITEMS.flatMap((item, index) =>
    index === REVIEW_READINESS_ITEMS.length - 1
      ? ["", `- [ ] ${item}`]
      : [`- [ ] ${item}`],
  );
  return [
    REVIEW_READINESS_START,
    "## Review readiness checklist",
    "",
    "This PR stays in draft until every box below is ticked. Tick all four boxes once the requirements are met:",
    "",
    ...items,
    REVIEW_READINESS_END,
  ].join("\n");
}

/**
 * Read the checklist section the bot manages. `present` means the marker pair
 * exists; `complete` means the section contains exactly the four boxes and all
 * of them are checked. Anything else (missing markers, fewer or extra boxes,
 * unchecked boxes) keeps the gate closed. The author can reword an item, but
 * the box count and the checked state are the contract.
 */
function extractReviewReadiness(body) {
  if (typeof body !== "string") {
    return {
      present: false,
      complete: false,
      checked: 0,
      total: 0,
      items: [],
    };
  }
  const start = body.indexOf(REVIEW_READINESS_START);
  const end = body.indexOf(REVIEW_READINESS_END);
  const startCount = body.split(REVIEW_READINESS_START).length - 1;
  const endCount = body.split(REVIEW_READINESS_END).length - 1;
  // Any marker presence counts as present: an author-edited section that is
  // inverted or partial must never trigger another append, or every `edited`
  // event would stack a second checklist (and a second body write). Exactly
  // one marker pair is required: duplicates are malformed, not complete.
  if (
    start === -1 ||
    end === -1 ||
    end <= start ||
    startCount !== 1 ||
    endCount !== 1
  ) {
    return {
      present: start !== -1 || end !== -1,
      complete: false,
      checked: 0,
      total: 0,
      items: [],
    };
  }
  const section = body.slice(start + REVIEW_READINESS_START.length, end);
  const boxes = [...section.matchAll(/^\s*[-*]\s+\[([ xX])\]\s+/gm)];
  const total = boxes.length;
  const items = boxes.map((match) => ({ checked: match[1] !== " " }));
  const checked = items.filter((item) => item.checked).length;
  return {
    present: true,
    complete:
      total === REVIEW_READINESS_ITEMS.length && checked === total,
    checked,
    total,
    items,
  };
}

/**
 * Append the checklist section to a PR body. Idempotent: a body that already
 * carries the marker pair is returned unchanged, so a re-run can never stack a
 * second checklist (or feed the `edited` event endless body churn).
 */
function appendReviewReadinessSection(body) {
  if (extractReviewReadiness(body).present) return body;
  const section = buildReviewReadinessSection();
  if (typeof body !== "string" || !body.trim()) return `${section}\n`;
  return `${body.trimEnd()}\n\n${section}\n`;
}

/**
 * Remove the bot-managed readiness section from a body. Used so the bot's own
 * checklist never counts as author-written description substance, and so a
 * confirmed maintainer's body can retire the injected section.
 */
function stripReviewReadinessSection(body) {
  if (typeof body !== "string") return body;
  const start = body.indexOf(REVIEW_READINESS_START);
  const end = body.indexOf(REVIEW_READINESS_END);
  if (start === -1 || end === -1 || end <= start) return body;
  // Malformed marker sets (duplicates, extra pairs) stay untouched: removing
  // only one section would leave the body half-cleaned and still marked.
  if (
    body.split(REVIEW_READINESS_START).length - 1 !== 1 ||
    body.split(REVIEW_READINESS_END).length - 1 !== 1
  ) {
    return body;
  }
  const stripped =
    body.slice(0, start) + body.slice(end + REVIEW_READINESS_END.length);
  return stripped.replace(/\n{3,}/g, "\n\n").trimEnd();
}

/**
 * Replace the bot-managed readiness section with a fresh unticked copy.
 * Used when new commits land after the checklist was completed: the old
 * attestation covered a different head, so every box resets and the author
 * must re-tick against the latest code. Malformed marker sets (duplicates,
 * extra pairs) stay untouched, matching `stripReviewReadinessSection`.
 */

/**
 * Untick only the given 0-based checklist boxes inside the bot-managed
 * section, leaving every other box and the surrounding body byte-for-byte
 * unchanged. Used when the gate's own claim check disproves a ticked box
 * (CI not green, head too far behind dev): the false claim is removed while
 * the still-true boxes survive. Malformed marker sets stay untouched.
 */
function uncheckReviewReadinessBoxes(body, indexes) {
  if (typeof body !== "string") return body;
  const start = body.indexOf(REVIEW_READINESS_START);
  const end = body.indexOf(REVIEW_READINESS_END);
  if (start === -1 || end === -1 || end <= start) return body;
  if (
    body.split(REVIEW_READINESS_START).length - 1 !== 1 ||
    body.split(REVIEW_READINESS_END).length - 1 !== 1
  ) {
    return body;
  }
  const wanted = new Set(indexes);
  let boxIndex = 0;
  const section = body.slice(
    start + REVIEW_READINESS_START.length,
    end
  );
  const updatedSection = section.replace(
    /^([ \t]*[-*]\s+)\[([ xX])\](?=\s)/gm,
    (match, lead, mark) => {
      const current = boxIndex;
      boxIndex += 1;
      if (wanted.has(current) && mark !== " ") {
        return lead + "[ ]";
      }
      return match;
    }
  );
  if (updatedSection === section) return body;
  return (
    body.slice(0, start + REVIEW_READINESS_START.length) +
    updatedSection +
    body.slice(end)
  );
}

function resetReviewReadinessSection(body) {
  if (typeof body !== "string") return body;
  const start = body.indexOf(REVIEW_READINESS_START);
  const end = body.indexOf(REVIEW_READINESS_END);
  if (start === -1 || end === -1 || end <= start) return body;
  if (
    body.split(REVIEW_READINESS_START).length - 1 !== 1 ||
    body.split(REVIEW_READINESS_END).length - 1 !== 1
  ) {
    return body;
  }
  const section = buildReviewReadinessSection();
  // Splice only the bounded section: the author's surrounding content —
  // including deliberate blank lines and trailing markdown — stays byte for
  // byte identical to what they wrote.
  return (
    body.slice(0, start) +
    section +
    body.slice(end + REVIEW_READINESS_END.length)
  );
}

function collectPrQualityFailures({
  baseRef,
  allowedBases,
  title = "",
  body,
  behindMain,
  behindBase,
  aheadMain = 0,
  authorPermission,
  permissionLookupFailed = false,
  ancestryLookupFailed = false,
  /** True when baseRef is another open PR's head (stacked child). */
  stackedBase = false,
  /** Issue comments; a maintainer comment waives the GUI-screenshot gate. */
  guiOverrideComments = [],
  /** Changed file paths from `pulls.listFiles` (repo-relative). */
  changedFilePaths = [],
  /**
   * True when `pulls.listFiles` returned fewer paths than `pulls.get`
   * `changed_files` (GitHub caps the file list at 3,000 entries).
   */
  filesTruncated = false
}) {
  const failures = [];
  const wrongBase = !allowedBases.includes(baseRef) && !stackedBase;
  if (wrongBase) {
    failures.push({ code: "wrong_base" });
  } else {
    // Permission lookup fails closed (still evaluate ancestry). Compare API
    // failures skip ancestry — zeros would falsely pass the #644 heuristic.
    // Stacked children skip ancestry against the integration base; their parent
    // PR is the temporary target.
    const skipAncestry =
      stackedBase ||
      ancestryLookupFailed ||
      (!permissionLookupFailed && authorHasPushPermission(authorPermission));
    if (
      !skipAncestry &&
      isWrongAncestry({ behindMain, behindBase, aheadMain })
    ) {
      failures.push({ code: "wrong_ancestry" });
    }
  }

  const desc = assessPrDescription(body);
  if (!desc.ok) {
    failures.push({ code: "bad_description", reason: desc.reason });
  }

  // PRs that change gui/ must prove the UI change visually. Text cues in the
  // title or description are not enough — "no gui changes" in the body must
  // not arm the gate when the diff is backend-only. A maintainer comment saying
  // the change does not touch the GUI still waives a gui/ diff false positive.
  if (
    (guiPathsChanged(changedFilePaths) || filesTruncated) &&
    !hasScreenshotEvidence(body) &&
    !hasGuiOverride({ comments: guiOverrideComments })
  ) {
    failures.push({ code: "missing_ui_screenshot" });
  }
  return failures;
}

module.exports = {
  ANCESTRY_BEHIND_THRESHOLD,
  ANCESTRY_AHEAD_MAIN_MAX,
  REVIEW_READINESS_ITEMS,
  REVIEW_READINESS_START,
  REVIEW_READINESS_END,
  isWrongAncestry,
  authorHasPushPermission,
  assessPrDescription,
  guiPathsChanged,
  isChangedFileListTruncated,
  hasGuiCue,
  hasGuiOverride,
  hasScreenshotEvidence,
  buildReviewReadinessSection,
  extractReviewReadiness,
  appendReviewReadinessSection,
  stripReviewReadinessSection,
  REVIEW_READINESS_CLAIM_INDEX,
  uncheckReviewReadinessBoxes,
  resetReviewReadinessSection,
  collectPrQualityFailures,
  hasEscapedNewlines,
  stripPrTemplateBoilerplate,
};
