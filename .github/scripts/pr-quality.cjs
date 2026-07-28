"use strict";

const path = require("node:path");
const {
  clean,
  isPlaceholderOnlyValue,
  hasSubstantialStructuredContent,
} = require(path.join(__dirname, "issue-quality.cjs"));

const ANCESTRY_BEHIND_THRESHOLD = 20;
const MIN_SECTION_LEN = 40;
const MIN_RICH_SECTIONS = 2;
const UNSTRUCTURED_MIN_LEN = 120;
const UNSTRUCTURED_MIN_BLOCKS = 2;

function isWrongAncestry({ behindMain, behindBase, threshold = ANCESTRY_BEHIND_THRESHOLD }) {
  return behindMain === 0 && behindBase >= threshold;
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

function assessPrDescription(body) {
  if (typeof body !== "string" || !body.trim()) {
    return { ok: false, reason: "empty" };
  }
  if (hasEscapedNewlines(body)) {
    return { ok: false, reason: "escaped_newlines" };
  }
  const cleaned = clean(body);
  if (!cleaned) {
    const strippedComments = body.replace(/<!--[\s\S]*?-->/g, "").trim();
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

function collectPrQualityFailures({
  baseRef,
  allowedBases,
  body,
  behindMain,
  behindBase,
  authorPermission,
  permissionLookupFailed = false,
}) {
  const failures = [];
  const wrongBase = !allowedBases.includes(baseRef);
  if (wrongBase) {
    failures.push({ code: "wrong_base" });
  } else {
    const skipAncestry =
      !permissionLookupFailed && authorHasPushPermission(authorPermission);
    if (!skipAncestry && isWrongAncestry({ behindMain, behindBase })) {
      failures.push({ code: "wrong_ancestry" });
    }
  }

  const desc = assessPrDescription(body);
  if (!desc.ok) {
    failures.push({ code: "bad_description", reason: desc.reason });
  }
  return failures;
}

module.exports = {
  ANCESTRY_BEHIND_THRESHOLD,
  isWrongAncestry,
  authorHasPushPermission,
  assessPrDescription,
  collectPrQualityFailures,
  hasEscapedNewlines,
};
