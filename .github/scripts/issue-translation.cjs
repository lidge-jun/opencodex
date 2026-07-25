"use strict";

const crypto = require("crypto");

const MARKER = "<!-- opencodex-issue-inline-translator -->";
const END_MARKER = "<!-- /opencodex-issue-inline-translator -->";
const LEGACY_STATE_RE = /<!-- opencodex-issue-inline-translator-state:([\s\S]*?) -->\s*/;
const CONTROL_MARKER = "<!-- opencodex-issue-inline-translator-control -->";
const CONTROL_STATE_V2_RE =
  /<!-- opencodex-issue-inline-translator-control-state-v2:([A-Za-z0-9_-]+) -->/;
const CONTROL_STATE_LEGACY_RE =
  /<!-- opencodex-issue-inline-translator-control-state:([\s\S]*?) -->/;
const ISSUE_BODY_MAX = 65536;
const BOT_LOGIN = "github-actions[bot]";
const SOURCE_HASH_RE = /^[a-f0-9]{16}$/;
const MAX_RECENT = 32;

const DEFAULT_RATE_LIMIT = {
  minIntervalMs: 60_000,
  maxPerHour: 10,
  minSourceChars: 20,
};

/**
 * Deterministic fingerprint of the original issue source (title + stripped body).
 */
function hashTranslationSource({ title = "", body = "" } = {}) {
  const payload = [
    "title:",
    String(title || ""),
    "\nbody:\n",
    String(body || ""),
  ].join("");
  return crypto.createHash("sha256").update(payload, "utf8").digest("hex").slice(0, 16);
}

/**
 * Locate the first generated inline translation block.
 * @returns {{ start: number, end: number } | null}
 */
function findTranslationBlockRange(text) {
  const markerIdx = String(text || "").indexOf(MARKER);
  if (markerIdx === -1) return null;

  let cursor = markerIdx + MARKER.length;
  const afterMarker = String(text).slice(cursor);
  const legacyState = afterMarker.match(/^\s*<!-- opencodex-issue-inline-translator-state:[\s\S]*? -->\s*/);
  if (legacyState) {
    cursor += legacyState.index + legacyState[0].length;
  }

  const rest = String(text).slice(cursor);
  const endRel = rest.indexOf(END_MARKER);
  if (endRel !== -1) {
    return { start: markerIdx, end: cursor + endRel + END_MARKER.length };
  }

  // Legacy blocks (pre-END_MARKER): fall back to first </details>.
  if (/^\s*<details>/i.test(rest)) {
    const closeRel = rest.search(/<\/details>/i);
    if (closeRel !== -1) {
      return { start: markerIdx, end: cursor + closeRel + "</details>".length };
    }
    return { start: markerIdx, end: cursor };
  }

  if (legacyState) {
    return { start: markerIdx, end: cursor };
  }

  return { start: markerIdx, end: markerIdx + MARKER.length };
}

/**
 * Split an issue body into user prefix/suffix and the generated translation block.
 */
function splitTranslationBlock(body) {
  const text = String(body || "");
  const range = findTranslationBlockRange(text);
  if (!range) {
    const sourceBody = text.replace(/\s+$/, "");
    return {
      found: false,
      prefix: sourceBody,
      block: "",
      suffix: "",
      sourceBody,
    };
  }

  const prefix = text.slice(0, range.start).replace(/\s+$/, "");
  const block = text.slice(range.start, range.end);
  const suffix = text.slice(range.end).replace(/^\s+/, "");
  const sourceBody = suffix
    ? (prefix ? `${prefix}\n\n${suffix}` : suffix).replace(/\s+$/, "")
    : prefix;

  return { found: true, prefix, block, suffix, sourceBody };
}

function stripTranslationBlock(body) {
  return splitTranslationBlock(body).sourceBody;
}

/** Legacy body-embedded state (ignored for rate limits). */
function extractTranslationState(body) {
  const match = String(body || "").match(LEGACY_STATE_RE);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

function scrubDetectedLanguage(value) {
  return (
    String(value || "")
      .replace(/[^\p{L}\p{N}\s\-()]/gu, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 64) || "non-English"
  );
}

function encodeControlState(state) {
  return Buffer.from(JSON.stringify(state), "utf8").toString("base64url");
}

function validateControlState(parsed) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  if (parsed.v !== 2) return null;
  if (typeof parsed.sourceHash !== "string" || !SOURCE_HASH_RE.test(parsed.sourceHash)) {
    return null;
  }
  if (typeof parsed.attemptedAt !== "number" || !Number.isFinite(parsed.attemptedAt)) {
    return null;
  }
  if (!Array.isArray(parsed.recent)) return null;
  const recent = parsed.recent
    .filter((ts) => typeof ts === "number" && Number.isFinite(ts))
    .slice(-MAX_RECENT);
  if (typeof parsed.requiresTranslation !== "boolean") return null;

  let detectedLanguage = null;
  if (parsed.detectedLanguage != null) {
    if (typeof parsed.detectedLanguage !== "string") return null;
    detectedLanguage = scrubDetectedLanguage(parsed.detectedLanguage);
  }

  return {
    v: 2,
    sourceHash: parsed.sourceHash,
    attemptedAt: parsed.attemptedAt,
    recent,
    requiresTranslation: parsed.requiresTranslation,
    detectedLanguage,
  };
}

function decodeControlState(encoded) {
  try {
    const json = Buffer.from(String(encoded || ""), "base64url").toString("utf8");
    return validateControlState(JSON.parse(json));
  } catch {
    return null;
  }
}

/** Legacy JSON-in-HTML-comment state (read-only migration). */
function parseLegacyControlState(raw) {
  try {
    return validateControlState(JSON.parse(raw));
  } catch {
    return null;
  }
}

/**
 * Return the newest github-actions control comment, if any.
 */
function findControlComment(comments) {
  const botComments = (Array.isArray(comments) ? comments : []).filter(
    (comment) => comment?.user?.login === BOT_LOGIN && comment?.body?.includes(CONTROL_MARKER),
  );
  if (!botComments.length) return null;
  return botComments[botComments.length - 1];
}

function extractTranslationControlState(comments) {
  const newest = findControlComment(comments);
  if (!newest) return null;
  const body = String(newest.body || "");
  const v2 = body.match(CONTROL_STATE_V2_RE);
  if (v2) return decodeControlState(v2[1]);
  const legacy = body.match(CONTROL_STATE_LEGACY_RE);
  if (legacy) return parseLegacyControlState(legacy[1]);
  return null;
}

function buildTranslationControlComment(state) {
  const safe = validateControlState(state) || {
    v: 2,
    sourceHash: "0000000000000000",
    attemptedAt: Date.now(),
    recent: [],
    requiresTranslation: false,
    detectedLanguage: null,
  };
  const encoded = encodeControlState(safe);
  const lang = scrubDetectedLanguage(safe.detectedLanguage);
  return [
    CONTROL_MARKER,
    `<!-- opencodex-issue-inline-translator-control-state-v2:${encoded} -->`,
    "",
    `<sub>Automated translation bookkeeping — detected language: ${lang}.</sub>`,
  ].join("\n");
}

function pruneRecent(recent, now, windowMs = 3_600_000) {
  const cutoff = now - windowMs;
  return (Array.isArray(recent) ? recent : []).filter(
    (ts) => typeof ts === "number" && ts > cutoff,
  );
}

function countRecentAttempts(recent, now, windowMs = 3_600_000) {
  return pruneRecent(recent, now, windowMs).length;
}

function mergeTranslationAttemptState({ priorState = null, attempt, now = Date.now() }) {
  if (priorState?.attemptedAt && priorState.attemptedAt > now) {
    return {
      ...priorState,
      recent: pruneRecent(
        [...pruneRecent(priorState.recent, priorState.attemptedAt), now],
        priorState.attemptedAt,
      ),
    };
  }

  const priorRecent = pruneRecent(priorState?.recent, now);
  const recent = pruneRecent([...priorRecent, now], now);

  return {
    v: 2,
    sourceHash: attempt.sourceHash,
    attemptedAt: now,
    recent,
    requiresTranslation: Boolean(attempt.requiresTranslation),
    detectedLanguage: attempt.detectedLanguage == null
      ? null
      : scrubDetectedLanguage(attempt.detectedLanguage),
  };
}

/**
 * Upsert the bot-owned control comment using a single shared selector.
 */
async function upsertTranslationControlComment({
  github,
  owner,
  repo,
  issue_number,
  comments,
  priorState = null,
  attempt,
  now = Date.now(),
}) {
  const body = buildTranslationControlComment(
    mergeTranslationAttemptState({ priorState, attempt, now }),
  );
  const existing = findControlComment(comments);
  if (existing) {
    if (existing.body !== body) {
      await github.rest.issues.updateComment({
        owner,
        repo,
        comment_id: existing.id,
        body,
      });
    }
    return existing;
  }
  const created = await github.rest.issues.createComment({
    owner,
    repo,
    issue_number,
    body,
  });
  return created.data;
}

function isPreparedSourceStillCurrent({ preparedHash, liveTitle, liveBody }) {
  const liveHash = hashTranslationSource({
    title: liveTitle || "",
    body: liveBody || "",
  });
  return liveHash === preparedHash;
}

function shouldTranslate({
  sourceTitle = "",
  sourceBody,
  priorState = null,
  now = Date.now(),
  rateLimit = DEFAULT_RATE_LIMIT,
}) {
  const title = String(sourceTitle || "").trim();
  const body = String(sourceBody || "").trim();
  const combined = `${title}\n${body}`.trim();
  const minChars = rateLimit.minSourceChars ?? DEFAULT_RATE_LIMIT.minSourceChars;

  if (combined.length < minChars) {
    return { ok: false, reason: "source_too_short" };
  }

  const sourceHash = hashTranslationSource({ title, body });
  if (priorState?.sourceHash === sourceHash) {
    return { ok: false, reason: "unchanged_source" };
  }

  const minInterval = rateLimit.minIntervalMs ?? DEFAULT_RATE_LIMIT.minIntervalMs;
  const maxPerHour = rateLimit.maxPerHour ?? DEFAULT_RATE_LIMIT.maxPerHour;
  const attemptedAt = typeof priorState?.attemptedAt === "number" ? priorState.attemptedAt : 0;
  const recent = pruneRecent(priorState?.recent, now);

  if (attemptedAt && now - attemptedAt < minInterval) {
    return { ok: false, reason: "rate_limited_interval" };
  }

  if (countRecentAttempts(recent, now) >= maxPerHour) {
    return { ok: false, reason: "rate_limited_hourly" };
  }

  return { ok: true, sourceHash, recent };
}

function sanitizeTranslationBody(raw, maxChars = 60000) {
  return String(raw || "")
    .split(MARKER).join("")
    .split(END_MARKER).join("")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    // Defuse pings only: @login / @org/team — not emails, scopes, or decorators.
    .replace(
      /(^|[\s(])@([A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\/[A-Za-z0-9._-]+)?)/g,
      "$1@\u200b$2",
    )
    .trim()
    .slice(0, maxChars);
}

function buildTranslationBlock(translatedBody) {
  const safeBody = sanitizeTranslationBody(translatedBody);
  return [
    "",
    MARKER,
    "",
    "<details>",
    "",
    "<summary>Translated Message</summary>",
    "",
    safeBody,
    "",
    "</details>",
    END_MARKER,
    "",
  ].join("\n");
}

function maxTranslationChars(sourceBody) {
  const base = stripTranslationBlock(sourceBody);
  const emptyBlock = buildTranslationBlock("");
  return Math.max(0, ISSUE_BODY_MAX - base.length - emptyBlock.length - 64);
}

function fitTranslationBody(sourceBody, translatedBody) {
  let safe = sanitizeTranslationBody(translatedBody);
  const maxChars = maxTranslationChars(sourceBody);
  if (safe.length <= maxChars) return safe;
  const note = "\n\n_(Translation truncated to fit GitHub issue body limit.)_";
  const budget = Math.max(0, maxChars - note.length);
  return safe.slice(0, budget).trimEnd() + note;
}

function appendTranslationBlock(sourceBody, translatedBody) {
  const base = stripTranslationBlock(sourceBody);
  const fitted = fitTranslationBody(base, translatedBody);
  const next = base + buildTranslationBlock(fitted);
  if (next.length > ISSUE_BODY_MAX) {
    throw new Error("Translated issue body exceeds GitHub limit after truncation.");
  }
  return next;
}

module.exports = {
  MARKER,
  END_MARKER,
  CONTROL_MARKER,
  BOT_LOGIN,
  ISSUE_BODY_MAX,
  DEFAULT_RATE_LIMIT,
  hashTranslationSource,
  findTranslationBlockRange,
  splitTranslationBlock,
  stripTranslationBlock,
  extractTranslationState,
  findControlComment,
  extractTranslationControlState,
  encodeControlState,
  decodeControlState,
  validateControlState,
  buildTranslationControlComment,
  mergeTranslationAttemptState,
  upsertTranslationControlComment,
  isPreparedSourceStillCurrent,
  shouldTranslate,
  sanitizeTranslationBody,
  scrubDetectedLanguage,
  buildTranslationBlock,
  maxTranslationChars,
  fitTranslationBody,
  appendTranslationBlock,
  pruneRecent,
  countRecentAttempts,
};
