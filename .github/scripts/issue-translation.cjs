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
/** Trailing standalone marker (+ optional final whitespace). Never mid-body. */
const TRAILING_ORPHAN_BODY_STATE_RE =
  /<!-- opencodex-issue-inline-translator-control-state-v2:[A-Za-z0-9_-]+ -->[ \t]*(?:\r?\n)?[ \t]*$/;
const ISSUE_BODY_MAX = 65536;
const BOT_LOGIN = "github-actions[bot]";
const SOURCE_HASH_RE = /^[a-f0-9]{16}$/;
const ISSUE_SOURCE_KEY = "issue";
const MAX_SOURCE_HASHES = 64;
const MAX_RECENT = 32;
/** Allow small clock skew; far-future timestamps are rejected. */
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

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

/**
 * True when the model (or caller) reported English / no translation needed.
 */
function isEnglishDetectedLanguage(value) {
  const lang = scrubDetectedLanguage(value).toLowerCase();
  return lang === "english" || lang === "en" || lang === "eng";
}

/**
 * Language written into control-state on the no-translation persist path.
 *
 * Confirmed English only when `sourceComplete` is true (valid parsed
 * `requires_translation: false`). Incomplete AI/parse/action failures always
 * record `unknown` — never retain a language label that could look confirmed.
 */
function detectedLanguageForControlPersist({ detectedLanguage, sourceComplete } = {}) {
  if (sourceComplete !== true) return "unknown";
  return scrubDetectedLanguage(detectedLanguage || "English");
}

/**
 * Visible bookkeeping language label for the sticky control comment.
 * Always non-empty so the bot bubble never renders as a blank ghost comment.
 * Missing language is `unknown` — never invent a confirmed English label.
 */
function bookkeepingLanguageLabel(state) {
  if (state?.detectedLanguage) return scrubDetectedLanguage(state.detectedLanguage);
  return "unknown";
}

/**
 * Strip obsolete bot-owned body control markers from the legacy trailing
 * storage position only. Markers inside fenced code, quotes, or prose are
 * left untouched. Surrounding author whitespace is preserved byte-for-byte.
 */
function stripOrphanBodyControlState(body) {
  let text = String(body || "");
  // Only remove exact trailing tokens (legacy bot storage). Repeat in case
  // multiple obsolete markers were appended at EOF.
  while (TRAILING_ORPHAN_BODY_STATE_RE.test(text)) {
    text = text.replace(TRAILING_ORPHAN_BODY_STATE_RE, "");
  }
  return text;
}

function isValidControlTimestamp(ts, now = Date.now()) {
  return typeof ts === "number"
    && Number.isFinite(ts)
    && ts <= now + MAX_CLOCK_SKEW_MS;
}

function findAllControlComments(comments) {
  return (Array.isArray(comments) ? comments : []).filter(
    (comment) => comment?.user?.login === BOT_LOGIN && comment?.body?.includes(CONTROL_MARKER),
  );
}

function encodeControlState(state) {
  return Buffer.from(JSON.stringify(state), "utf8").toString("base64url");
}

function isValidSourceKey(key) {
  return key === ISSUE_SOURCE_KEY || /^comment:[1-9][0-9]*$/.test(String(key || ""));
}

/**
 * Per-source completed hashes. Legacy flat `sourceHash` maps only to the issue key.
 */
function migrateSourceHashes(state) {
  if (!state || typeof state !== "object") return {};
  const out = {};
  if (state.sourceHashes && typeof state.sourceHashes === "object" && !Array.isArray(state.sourceHashes)) {
    for (const [key, value] of Object.entries(state.sourceHashes)) {
      if (isValidSourceKey(key) && typeof value === "string" && SOURCE_HASH_RE.test(value)) {
        out[key] = value;
      }
    }
    return out;
  }
  if (
    typeof state.sourceHash === "string"
    && SOURCE_HASH_RE.test(state.sourceHash)
    && state.sourceHash !== "0000000000000000"
  ) {
    out[ISSUE_SOURCE_KEY] = state.sourceHash;
  }
  return out;
}

function completedHashFor(state, sourceKey) {
  const key = isValidSourceKey(sourceKey) ? sourceKey : ISSUE_SOURCE_KEY;
  const hashes = migrateSourceHashes(state);
  return hashes[key] || null;
}

function withCompletedSourceHash(hashes, sourceKey, sourceHash) {
  const next = { ...hashes };
  if (isValidSourceKey(sourceKey) && typeof sourceHash === "string" && SOURCE_HASH_RE.test(sourceHash)) {
    next[sourceKey] = sourceHash;
  }
  const keys = Object.keys(next);
  if (keys.length <= MAX_SOURCE_HASHES) return next;
  // Prefer keeping the issue key; drop oldest-inserted comment keys first.
  const commentKeys = keys.filter((k) => k !== ISSUE_SOURCE_KEY);
  while (Object.keys(next).length > MAX_SOURCE_HASHES && commentKeys.length) {
    delete next[commentKeys.shift()];
  }
  return next;
}

function validateControlState(parsed, now = Date.now()) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  if (parsed.v !== 2) return null;
  if (typeof parsed.sourceHash !== "string" || !SOURCE_HASH_RE.test(parsed.sourceHash)) {
    return null;
  }
  if (!isValidControlTimestamp(parsed.attemptedAt, now)) {
    return null;
  }
  if (!Array.isArray(parsed.recent)) return null;
  const recent = parsed.recent
    .filter((ts) => isValidControlTimestamp(ts, now))
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
    sourceHashes: migrateSourceHashes(parsed),
    attemptedAt: parsed.attemptedAt,
    recent,
    requiresTranslation: parsed.requiresTranslation,
    detectedLanguage,
  };
}

function decodeControlState(encoded, now = Date.now()) {
  try {
    const json = Buffer.from(String(encoded || ""), "base64url").toString("utf8");
    return validateControlState(JSON.parse(json), now);
  } catch {
    return null;
  }
}

/** Legacy JSON-in-HTML-comment state (read-only migration). */
function parseLegacyControlState(raw, now = Date.now()) {
  try {
    return validateControlState(JSON.parse(raw), now);
  } catch {
    return null;
  }
}

function parseControlStateFromCommentBody(body, now = Date.now()) {
  const text = String(body || "");
  const v2 = text.match(CONTROL_STATE_V2_RE);
  if (v2) return decodeControlState(v2[1], now);
  const legacy = text.match(CONTROL_STATE_LEGACY_RE);
  if (legacy) return parseLegacyControlState(legacy[1], now);
  return null;
}

/**
 * Newest github-actions control comment with a valid decoded state.
 * Author-forged comments and far-future poisoned payloads are ignored.
 * Used for *reading* authoritative rate-limit state.
 */
function findControlComment(comments, now = Date.now()) {
  let best = null;
  let bestState = null;
  for (const comment of findAllControlComments(comments)) {
    const state = parseControlStateFromCommentBody(comment.body, now);
    if (!state) continue;
    if (!bestState || state.attemptedAt >= bestState.attemptedAt) {
      best = comment;
      bestState = state;
    }
  }
  return best;
}

/**
 * Sticky upsert target: the oldest bot-owned control comment (by id).
 * Prefer updating this in place so the bubble stays near the top of the
 * thread instead of creating a new comment at the bottom after every
 * English classification. Corrupt/unparseable bodies still qualify — we
 * overwrite them — so a bad decode never forces a duplicate create.
 */
function findStickyControlComment(comments) {
  let sticky = null;
  for (const comment of findAllControlComments(comments)) {
    if (!Number.isSafeInteger(comment?.id) || comment.id <= 0) continue;
    if (!sticky || comment.id < sticky.id) sticky = comment;
  }
  return sticky;
}

function extractTranslationControlState(comments, now = Date.now()) {
  const newest = findControlComment(comments, now);
  if (!newest) return null;
  return parseControlStateFromCommentBody(newest.body, now);
}

/**
 * Authoritative control state comes only from verified bot-owned comments.
 * Issue body markers and author comments are never consulted.
 * The optional second argument is ignored (kept for call-site compatibility).
 */
function resolveControlState(comments, _issueNumber, now = Date.now()) {
  return extractTranslationControlState(comments, now);
}

/**
 * Always false: control comments always include a visible bookkeeping line
 * so GitHub never renders an HTML-comment-only ghost bubble.
 * Kept as an exported predicate for workflow/tests that assert the contract.
 */
function shouldOmitVisibleBookkeeping(_state) {
  return false;
}

function buildTranslationControlComment(state) {
  const safe = validateControlState(state) || {
    v: 2,
    sourceHash: "0000000000000000",
    sourceHashes: {},
    attemptedAt: Date.now(),
    recent: [],
    requiresTranslation: false,
    detectedLanguage: null,
  };
  const encoded = encodeControlState(safe);
  const lang = bookkeepingLanguageLabel(safe);
  return [
    CONTROL_MARKER,
    `<!-- opencodex-issue-inline-translator-control-state-v2:${encoded} -->`,
    "",
    `<sub>Automated translation bookkeeping — detected language: ${lang}.</sub>`,
  ].join("\n");
}

function pruneRecent(recent, now, windowMs = 3_600_000) {
  const cutoff = now - windowMs;
  const maxTs = now + MAX_CLOCK_SKEW_MS;
  return (Array.isArray(recent) ? recent : []).filter(
    (ts) => typeof ts === "number" && Number.isFinite(ts) && ts > cutoff && ts <= maxTs,
  );
}

function countRecentAttempts(recent, now, windowMs = 3_600_000) {
  return pruneRecent(recent, now, windowMs).length;
}

/**
 * Merge bounded recent-attempt histories from every valid bot control comment
 * so canonicalisation does not drop hourly-limit evidence.
 */
function collectMergedRecentFromComments(comments, priorState = null, now = Date.now()) {
  const collected = [];
  if (Array.isArray(priorState?.recent)) collected.push(...priorState.recent);
  for (const comment of findAllControlComments(comments)) {
    const state = parseControlStateFromCommentBody(comment.body, now);
    if (state?.recent) collected.push(...state.recent);
  }
  return [...new Set(pruneRecent(collected, now))].sort((a, b) => a - b).slice(-MAX_RECENT);
}

/**
 * Record a new attempt. Far-future poisoned prior state is ignored/healed.
 * New attemptedAt always uses wall-clock `now` so skew cannot stick forever.
 *
 * Completed hashes are stored per `sourceKey` (`issue` vs `comment:<id>`) so
 * issue and comment paths do not clobber each other's unchanged_source checks.
 * Rate-limit fields (`attemptedAt`, `recent`) stay shared across the issue.
 * Pass `sourceComplete: true` only after a valid no-translation decision or a
 * successful issue/comment translation apply — never for invalid/empty model
 * output or GitHub update failures (those must remain retryable after cooldown).
 */
function mergeTranslationAttemptState({ priorState = null, attempt, now = Date.now() }) {
  let prior = null;
  if (priorState && isValidControlTimestamp(priorState.attemptedAt, now)) {
    prior = {
      ...priorState,
      recent: (priorState.recent || []).filter((ts) => isValidControlTimestamp(ts, now)),
      sourceHashes: migrateSourceHashes(priorState),
    };
  }

  const priorRecent = pruneRecent(prior?.recent, now);
  const recent = pruneRecent([...priorRecent, now], now);
  const sourceComplete = attempt?.sourceComplete === true;
  const sourceKey = isValidSourceKey(attempt?.sourceKey) ? attempt.sourceKey : ISSUE_SOURCE_KEY;
  let sourceHashes = migrateSourceHashes(prior);
  let completedHash = prior?.sourceHash && SOURCE_HASH_RE.test(prior.sourceHash)
    ? prior.sourceHash
    : "0000000000000000";

  if (
    sourceComplete
    && typeof attempt.sourceHash === "string"
    && SOURCE_HASH_RE.test(attempt.sourceHash)
  ) {
    sourceHashes = withCompletedSourceHash(sourceHashes, sourceKey, attempt.sourceHash);
    completedHash = attempt.sourceHash;
  }

  return {
    v: 2,
    sourceHash: completedHash,
    sourceHashes,
    attemptedAt: now,
    recent,
    requiresTranslation: Boolean(attempt.requiresTranslation),
    detectedLanguage: attempt.detectedLanguage == null
      ? null
      : scrubDetectedLanguage(attempt.detectedLanguage),
  };
}

/**
 * Delete verified bot control comments by ID.
 * Re-checks bot authorship + CONTROL_MARKER before each delete.
 * Deletion failures are reported, not thrown.
 */
async function deleteVerifiedControlComments({
  github,
  owner,
  repo,
  issue_number,
  commentIds,
  comments = null,
  keepCommentId = null,
}) {
  const keepId = Number.isSafeInteger(keepCommentId) && keepCommentId > 0
    ? keepCommentId
    : null;
  const ids = [...new Set(
    (Array.isArray(commentIds) ? commentIds : [])
      .map((id) => Number(id))
      .filter((id) => Number.isSafeInteger(id) && id > 0 && id !== keepId),
  )];
  if (!ids.length) {
    return { deleted: [], skipped: [], failed: [] };
  }

  let liveComments = comments;
  if (!Array.isArray(liveComments)) {
    liveComments = await github.paginate(github.rest.issues.listComments, {
      owner,
      repo,
      issue_number,
      per_page: 100,
    });
  }
  const byId = new Map(
    (Array.isArray(liveComments) ? liveComments : [])
      .filter((c) => Number.isSafeInteger(c?.id))
      .map((c) => [c.id, c]),
  );

  const deleted = [];
  const skipped = [];
  const failed = [];
  for (const id of ids) {
    const comment = byId.get(id);
    if (
      !comment
      || comment.user?.login !== BOT_LOGIN
      || !String(comment.body || "").includes(CONTROL_MARKER)
    ) {
      skipped.push(id);
      continue;
    }
    try {
      await github.rest.issues.deleteComment({
        owner,
        repo,
        comment_id: id,
      });
      deleted.push(id);
    } catch (err) {
      failed.push({
        id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { deleted, skipped, failed };
}

/**
 * Upsert the canonical bot-owned control comment.
 * Always includes a visible detected-language bookkeeping line (English too).
 * Updates the oldest sticky bot control comment in place when one exists —
 * including corrupt bodies — so classification never spams a new bottom bubble.
 * Never mutates the issue title or body.
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
  const merged = mergeTranslationAttemptState({ priorState, attempt, now });
  const body = buildTranslationControlComment(merged);
  // Sticky target ≠ newest valid state: prefer oldest marker comment so the
  // thread position stays stable even when state on that comment is corrupt.
  const existing = findStickyControlComment(comments);

  if (existing) {
    if (existing.body !== body) {
      await github.rest.issues.updateComment({
        owner,
        repo,
        comment_id: existing.id,
        body,
      });
    }
    return { comment: { ...existing, body }, state: merged, created: false };
  }

  const created = await github.rest.issues.createComment({
    owner,
    repo,
    issue_number,
    body,
  });
  return { comment: created.data, state: merged, created: true };
}

/**
 * Persist rate-limit / cooldown state in a bot-owned issue comment.
 * Writes/updates the canonical comment first; only then deletes redundant
 * older bot control comments. Create/update failure preserves prior comments.
 * Never uses the issue body/title or author-created comments as storage.
 */
async function persistTranslationControlState({
  github,
  owner,
  repo,
  issue_number,
  comments,
  priorState = null,
  attempt,
  now = Date.now(),
}) {
  const mergedRecent = collectMergedRecentFromComments(comments, priorState, now);
  const effectivePrior = priorState && isValidControlTimestamp(priorState.attemptedAt, now)
    ? { ...priorState, recent: mergedRecent }
    : (mergedRecent.length
      ? {
        v: 2,
        // Incomplete synthetic prior: do not treat the current attempt hash as completed.
        sourceHash: "0000000000000000",
        sourceHashes: {},
        attemptedAt: Math.min(...mergedRecent),
        recent: mergedRecent,
        requiresTranslation: false,
        detectedLanguage: null,
      }
      : null);

  let upserted;
  try {
    upserted = await upsertTranslationControlComment({
      github,
      owner,
      repo,
      issue_number,
      comments,
      priorState: effectivePrior,
      attempt,
      now,
    });
  } catch (err) {
    const error = new Error(
      `translation control comment persistence failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    error.cause = err;
    throw error;
  }

  const canonicalId = upserted.comment?.id;
  const redundantIds = findAllControlComments(comments)
    .map((comment) => comment.id)
    .filter((id) => Number.isSafeInteger(id) && id > 0 && id !== canonicalId);

  let cleanup = { deleted: [], skipped: [], failed: [] };
  if (redundantIds.length) {
    cleanup = await deleteVerifiedControlComments({
      github,
      owner,
      repo,
      issue_number,
      commentIds: redundantIds,
      comments,
      keepCommentId: canonicalId,
    });
  }

  return {
    storage: "comment",
    state: upserted.state,
    comment: upserted.comment,
    // Always false: bookkeeping line is always visible (no ghost HTML-only bubble).
    markerOnly: false,
    cleanup,
  };
}

function isPreparedSourceStillCurrent({ preparedHash, liveTitle, liveBody }) {
  const liveHash = hashTranslationSource({
    title: liveTitle || "",
    body: liveBody || "",
  });
  return liveHash === preparedHash;
}

/** Stable title key so comment hashes never collide with issue title+body hashes. */
function commentSourceTitle(commentId) {
  return `comment:${commentId}`;
}

/**
 * Hard skips before rate-limit / hash checks.
 * @returns {string | null} skip reason, or null when eligible for shouldTranslate
 */
function shouldSkipCommentTranslation(comment, issue = null) {
  if (issue?.pull_request) return "pull_request";
  const login = String(comment?.user?.login || "");
  const userType = String(comment?.user?.type || "");
  if (userType === "Bot" || /\[bot\]$/i.test(login) || login === BOT_LOGIN) {
    return "bot_author";
  }
  const body = String(comment?.body || "");
  if (body.includes(CONTROL_MARKER)) return "control_comment";
  return null;
}

/**
 * Decide whether a user issue comment should be sent to the translator.
 * Reuses issue rate limits via the shared per-issue control comment.
 * `comment:<id>` is only a hash namespace — minSourceChars applies to the
 * stripped comment body alone so short comments cannot burn model quota.
 */
function shouldTranslateComment({
  comment,
  issue = null,
  priorState = null,
  now = Date.now(),
  rateLimit = DEFAULT_RATE_LIMIT,
}) {
  const skip = shouldSkipCommentTranslation(comment, issue);
  if (skip) return { ok: false, reason: skip };

  const commentId = comment?.id;
  if (!Number.isSafeInteger(commentId) || commentId <= 0) {
    return { ok: false, reason: "invalid_comment_id" };
  }

  const sourceBody = stripTranslationBlock(comment.body || "");
  const minChars = rateLimit.minSourceChars ?? DEFAULT_RATE_LIMIT.minSourceChars;
  if (String(sourceBody).trim().length < minChars) {
    return { ok: false, reason: "source_too_short" };
  }

  const decision = shouldTranslate({
    sourceTitle: commentSourceTitle(commentId),
    sourceBody,
    sourceKey: commentSourceTitle(commentId),
    priorState,
    now,
    // Length already enforced on the body; title is namespace-only.
    rateLimit: { ...rateLimit, minSourceChars: 0 },
  });
  if (!decision.ok) return decision;
  return {
    ...decision,
    sourceBody,
    sourceTitle: commentSourceTitle(commentId),
    commentId,
  };
}

/**
 * Build the in-place comment body: original + folded English translation.
 */
function buildTranslatedCommentBody(sourceBody, translatedBody, detectedLanguage) {
  const lang = scrubDetectedLanguage(detectedLanguage);
  const translationText = [
    `*Original language: ${lang}*`,
    "",
    String(translatedBody || ""),
  ].join("\n");
  return appendTranslationBlock(sourceBody, translationText);
}

/**
 * Required translated fields for a successful apply.
 * Nonempty source title/body each require a nonempty translated counterpart.
 * @returns {string[]} missing field names (`title` / `body`)
 */
function missingRequiredTranslationFields({
  sourceTitle = "",
  sourceBody = "",
  translatedTitle = "",
  translatedBody = "",
} = {}) {
  const missing = [];
  if (String(sourceTitle || "").trim() && !String(translatedTitle || "").trim()) {
    missing.push("title");
  }
  if (String(sourceBody || "").trim() && !String(translatedBody || "").trim()) {
    missing.push("body");
  }
  return missing;
}

function shouldTranslate({
  sourceTitle = "",
  sourceBody,
  sourceKey = ISSUE_SOURCE_KEY,
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

  const key = isValidSourceKey(sourceKey) ? sourceKey : ISSUE_SOURCE_KEY;
  const sourceHash = hashTranslationSource({ title, body });
  if (completedHashFor(priorState, key) === sourceHash) {
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

  return { ok: true, sourceHash, sourceKey: key, recent };
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
  ISSUE_SOURCE_KEY,
  DEFAULT_RATE_LIMIT,
  MAX_CLOCK_SKEW_MS,
  hashTranslationSource,
  findTranslationBlockRange,
  splitTranslationBlock,
  stripTranslationBlock,
  extractTranslationState,
  findControlComment,
  findStickyControlComment,
  findAllControlComments,
  deleteVerifiedControlComments,
  extractTranslationControlState,
  resolveControlState,
  encodeControlState,
  decodeControlState,
  validateControlState,
  isValidControlTimestamp,
  buildTranslationControlComment,
  mergeTranslationAttemptState,
  collectMergedRecentFromComments,
  upsertTranslationControlComment,
  persistTranslationControlState,
  shouldOmitVisibleBookkeeping,
  isPreparedSourceStillCurrent,
  commentSourceTitle,
  shouldSkipCommentTranslation,
  shouldTranslateComment,
  buildTranslatedCommentBody,
  missingRequiredTranslationFields,
  shouldTranslate,
  completedHashFor,
  migrateSourceHashes,
  sanitizeTranslationBody,
  scrubDetectedLanguage,
  isEnglishDetectedLanguage,
  detectedLanguageForControlPersist,
  bookkeepingLanguageLabel,
  stripOrphanBodyControlState,
  buildTranslationBlock,
  maxTranslationChars,
  fitTranslationBody,
  appendTranslationBlock,
  pruneRecent,
  countRecentAttempts,
};
