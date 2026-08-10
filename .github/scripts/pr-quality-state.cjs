"use strict";

/** Regex that finds the enforcer state marker inside a bot comment body. */
const STATE_PATTERN =
  /<!-- (?:wrong-branch-enforcer|pr-quality-enforcer)-state:([\s\S]*?) -->/;
/** Regex that finds the readiness state marker inside a bot comment body. */
const READINESS_STATE_PATTERN =
  /<!-- pr-quality-readiness-state:([\s\S]*?) -->/;
/**
 * Regex that finds the consolidated gate state marker. This is the only state
 * marker the gate writes after the migration; the two legacy patterns above
 * are read only to migrate pre-consolidation PRs.
 */
const GATE_STATE_PATTERN =
  /<!-- opencodex-pr-gate-state:([\s\S]*?) -->/;

/**
 * v2 adds `completedAtHeadSha` so a completed checklist is bound to the exact
 * head it attested. v1 states (no field) are read the same way: the binding
 * only starts on the next completion.
 */
const READINESS_STATE_VERSION = 2;

/** A completed checklist may attest "on the latest dev" while the head is up to
 * this many commits behind the base. Beyond it the box no longer holds. */
const READINESS_LATEST_DEV_BEHIND_MAX = 10;

/** Parse the enforcer state marker, or `null` when absent or unreadable. */
function parseState(body, warn = () => {}) {
  const match = body?.match(STATE_PATTERN);

  if (!match) {
    return null;
  }

  try {
    return JSON.parse(match[1]);
  } catch (error) {
    warn(`Could not parse stored workflow state: ${error.message}`);

    return null;
  }
}

/** Serialize the enforcer state into its comment marker. */
function stateMarker(state) {
  return (
    "<!-- pr-quality-enforcer-state:" +
    JSON.stringify(state) +
    " -->"
  );
}

/** Parse the readiness state marker, or `null` when absent or unreadable. */
function parseReadinessState(body, warn = () => {}) {
  const match = body?.match(READINESS_STATE_PATTERN);

  if (!match) {
    return null;
  }

  try {
    return JSON.parse(match[1]);
  } catch (error) {
    warn(`Could not parse stored readiness state: ${error.message}`);

    return null;
  }
}

/** Serialize the readiness state into its comment marker. */
function readinessStateMarker(state) {
  return (
    "<!-- pr-quality-readiness-state:" +
    JSON.stringify(state) +
    " -->"
  );
}

/**
 * Parse the consolidated gate state marker, or `null` when absent or
 * unreadable.
 */
function parseGateState(body, warn = () => {}) {
  const match = body?.match(GATE_STATE_PATTERN);

  if (!match) {
    return null;
  }

  try {
    return JSON.parse(match[1]);
  } catch (error) {
    warn(`Could not parse stored gate state: ${error.message}`);

    return null;
  }
}

/** Serialize the consolidated gate state into its comment marker. */
function gateStateMarker(state) {
  return (
    "<!-- opencodex-pr-gate-state:" +
    JSON.stringify(state) +
    " -->"
  );
}

/**
 * Fresh consolidated gate state. It merges the old enforcer ownership fields
 * (active / autoDraftedByBot / titlePrefixedByBot) with the readiness fields
 * (maintainersPinged / completedAtHeadSha). `reviewReadyLabeled` is serialized
 * for backward compatibility with states written by earlier versions of this
 * gate; live label decisions read `pr.labels` directly, never this field.
 */
function defaultGateState() {
  return {
    version: 1,
    active: false,
    autoDraftedByBot: false,
    titlePrefixedByBot: false,
    maintainersPinged: false,
    completedAtHeadSha: null,
    reviewReadyLabeled: false
  };
}

/** The enforcer comment state after every quality gate clears. */
function clearedEnforcerState() {
  return {
    version: 1,
    active: false,
    autoDraftedByBot: false,
    titlePrefixedByBot: false,
    ancestryFailed: false,
    descriptionFailed: false,
    screenshotFailed: false
  };
}

/** Fresh enforcer state for a run that must draft the PR. */
function defaultEnforcerState() {
  return {
    version: 1,
    active: true,
    autoDraftedByBot: false,
    titlePrefixedByBot: false,
    ancestryFailed: false,
    descriptionFailed: false,
    screenshotFailed: false
  };
}

/** Fresh checklist-message state for a contributor PR. */
function defaultReadinessState() {
  return {
    version: READINESS_STATE_VERSION,
    autoDraftedByBot: false,
    maintainersPinged: false,
    completedAtHeadSha: null
  };
}

/**
 * Migrate a pre-consolidation PR: merge the legacy enforcer and readiness
 * states into the consolidated gate state. The legacy states are read from the
 * two old bot comments; either may be absent (null). State fields are read
 * for truthiness (not strict type), matching how the pre-consolidation gate
 * read them — a legacy marker carrying `"active":"true"` still restores.
 */
function migrateLegacyGateState(enforcerState, readinessState) {
  const gate = defaultGateState();
  if (enforcerState) {
    gate.active = Boolean(enforcerState.active);
    gate.autoDraftedByBot = Boolean(enforcerState.autoDraftedByBot);
    gate.titlePrefixedByBot = Boolean(enforcerState.titlePrefixedByBot);
  }
  if (readinessState) {
    // Either legacy record may own the auto-draft: the enforcer converted the
    // PR to draft for a quality failure, the readiness comment recorded the
    // checklist-driven draft, or both. Ownership is a union — letting the
    // readiness value overwrite a true enforcer bit drops the restore path
    // and leaves a bot-drafted maintainer PR stuck in draft forever.
    gate.autoDraftedByBot =
      gate.autoDraftedByBot || Boolean(readinessState.autoDraftedByBot);
    gate.maintainersPinged = Boolean(readinessState.maintainersPinged);
    gate.completedAtHeadSha = readinessState.completedAtHeadSha ?? null;
  }
  return gate;
}

/**
 * A completed checklist is an attestation about a specific head. The
 * attestation is stale when the recorded completion head differs from the
 * live head (new commits landed after the last completion) or when the boxes
 * were ticked in an event that saw an older head than the live one — a push
 * raced the `edited` job, so no completion head was recorded yet but the
 * ticks predate the code under review — or when a synchronize event sees a
 * complete checklist with no recorded head at all (the completion job may
 * still be queued for an older head).
 */

/**
 * Bot-side verification of the checklist claim the gate can check itself for
 * ancestry. The local-CI box is an author attestation only (fork contributors
 * cannot start repository CI; a maintainer has to), so it is never disproved
 * here — head-drift still resets every box after a new push. The latest-dev
 * box only holds while the head is at most READINESS_LATEST_DEV_BEHIND_MAX
 * commits behind the base. Unknown state (compare lookup failed) fails closed:
 * an unverifiable claim is a violation, because an attestation must not ride
 * on missing evidence.
 */
function readinessClaimViolations({
  behindBase,
  behindUnknown = false,
  behindMax = READINESS_LATEST_DEV_BEHIND_MAX
}) {
  const violations = [];
  if (behindUnknown || behindBase > behindMax) {
    violations.push("latest_dev");
  }
  return violations;
}

/**
 * The review bots whose findings threads the gate can verify. Codex posts
 * under the ChatGPT Codex Connector app; CodeRabbit under coderabbitai. Both
 * attach inline findings as pull-request review threads.
 */
const REVIEW_FINDINGS_BOT_LOGINS = [
  "chatgpt-codex-connector[bot]",
  "coderabbitai[bot]"
];

/** The login that authors CodeRabbit reviews. */
const CODE_RABBIT_LOGIN = "coderabbitai[bot]";

/**
 * CodeRabbit's review-body line that reports all actionable findings. This is
 * kept as a compatibility fallback for older review bodies that predate the
 * stable outside-diff markers below.
 */
const CODE_RABBIT_ACTIONABLE_RE =
  /\*\*Actionable comments posted:\s*(\d+)\*\*/i;

/** Stable identity CodeRabbit embeds with each finding it cannot attach inline. */
const CODE_RABBIT_OUTSIDE_DIFF_MARKER_RE =
  /<!--\s*(cr-comment:v1:[a-f0-9]+)\s*-->/gi;

function submittedAt(review) {
  const parsed = Date.parse(String(review?.submitted_at ?? ""));
  return Number.isNaN(parsed) ? -Infinity : parsed;
}

/** Latest CodeRabbit review for the exact head the readiness claim covers. */
function latestCodeRabbitReviewForHead({ reviews = [], liveHeadSha }) {
  if (!liveHeadSha || !Array.isArray(reviews) || reviews.length === 0) {
    return null;
  }
  return reviews
    .filter(
      review =>
        review?.commit_id === liveHeadSha &&
        review?.user?.login === CODE_RABBIT_LOGIN
    )
    .sort((a, b) => {
      const aTime = submittedAt(a);
      const bTime = submittedAt(b);
      if (aTime > bTime) return -1;
      if (aTime < bTime) return 1;
      return Number(b?.id ?? -1) - Number(a?.id ?? -1);
    })[0] ?? null;
}

/**
 * Stable identities for CodeRabbit findings outside the current diff. Real
 * outside-diff findings in CodeRabbit review bodies carry a
 * `cr-comment:v1:<id>` marker. Only the latest CodeRabbit review for the live
 * head is authoritative: markers present there are active; a later same-head
 * review that omits a marker is the bot-controlled resolution signal.
 */
function coderabbitOutsideDiffFindingIds({ reviews = [], liveHeadSha }) {
  const latestForHead = latestCodeRabbitReviewForHead({ reviews, liveHeadSha });
  const body = String(latestForHead?.body ?? "");
  if (!/outside diff range comments/i.test(body)) return [];

  const ids = [];
  const seen = new Set();
  for (const match of body.matchAll(CODE_RABBIT_OUTSIDE_DIFF_MARKER_RE)) {
    const id = match[1].toLowerCase();
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

/**
 * Compatibility parser for older CodeRabbit review bodies that expose only
 * `Actionable comments posted: N`. New outside-diff accounting uses the stable
 * `cr-comment` identities above, because the actionable total also includes
 * normal inline findings and therefore is not itself an outside-diff count.
 */
function coderabbitOutsideDiffFindings({ reviews = [], liveHeadSha }) {
  const latestForHead = latestCodeRabbitReviewForHead({ reviews, liveHeadSha });
  const body = String(latestForHead?.body ?? "");
  const match = CODE_RABBIT_ACTIONABLE_RE.exec(body);
  if (!match) return { code: null, unresolved: 0, byBot: {} };
  const count = Number(match[1]);
  if (!(count > 0)) return { code: null, unresolved: 0, byBot: {} };
  return {
    code: "review_findings",
    unresolved: count,
    byBot: { [CODE_RABBIT_LOGIN]: count }
  };
}

/**
 * Verify the Codex/CodeRabbit findings claim. Inline findings come from the
 * pull-request review threads GraphQL query. CodeRabbit findings that cannot
 * attach inline are independent: the latest CodeRabbit review for the live
 * head exposes stable `cr-comment:v1:<id>` markers for them, so a standalone
 * outside-diff finding remains active even when every inline thread is already
 * resolved. A later same-head CodeRabbit review that omits the marker clears
 * it without an empty commit. Older CodeRabbit bodies without stable markers
 * retain the previous actionable-count supplement while an inline bot thread
 * is unresolved.
 */
function unresolvedFindingsClaim({ threads = [], reviews = [], liveHeadSha }) {
  const byBot = {};
  let unresolved = 0;
  for (const thread of threads) {
    const login = thread?.author?.login;
    if (!REVIEW_FINDINGS_BOT_LOGINS.includes(login)) continue;
    if (thread.isResolved !== true) {
      byBot[login] = (byBot[login] ?? 0) + 1;
      unresolved += 1;
    }
  }

  const outsideIds = coderabbitOutsideDiffFindingIds({ reviews, liveHeadSha });
  if (outsideIds.length > 0) {
    byBot[CODE_RABBIT_LOGIN] =
      (byBot[CODE_RABBIT_LOGIN] ?? 0) + outsideIds.length;
    unresolved += outsideIds.length;
  } else if (unresolved > 0) {
    // Legacy fallback for older CodeRabbit review bodies that did not expose
    // stable outside-diff identities. Keep the old bounded behavior so an
    // immutable aggregate count cannot block a PR forever by itself.
    const outside = coderabbitOutsideDiffFindings({ reviews, liveHeadSha });
    if (outside.code) {
      for (const [login, count] of Object.entries(outside.byBot)) {
        byBot[login] = (byBot[login] ?? 0) + count;
        unresolved += count;
      }
    }
  }

  return unresolved > 0
    ? { code: "review_findings", unresolved, byBot }
    : { code: null, unresolved: 0, byBot };
}

function completionIsStale({
  checklistRequired,
  checklistComplete,
  readinessPresent,
  completionHeadSha,
  eventHeadSha,
  liveHeadSha,
  eventAction
}) {
  const completionRecordedForLiveHead =
    completionHeadSha !== null && completionHeadSha === liveHeadSha;
  // A push raced the edited job: the event still carries the older head the
  // boxes were ticked against.
  const ticksPredateLiveHead =
    completionHeadSha === null &&
    checklistComplete &&
    eventHeadSha !== liveHeadSha;
  // A complete checklist with no recorded head on synchronize has no
  // provenance for which head was attested. The edited job may still be
  // queued for an older head; do not let this push inherit that attestation.
  const unrecordedCompleteOnSynchronize =
    completionHeadSha === null &&
    checklistComplete &&
    eventAction === "synchronize";

  return (
    checklistRequired &&
    readinessPresent &&
    ((completionHeadSha !== null && !completionRecordedForLiveHead) ||
      ticksPredateLiveHead ||
      unrecordedCompleteOnSynchronize)
  );
}

module.exports = {
  READINESS_LATEST_DEV_BEHIND_MAX,
  readinessClaimViolations,
  unresolvedFindingsClaim,
  STATE_PATTERN,
  READINESS_STATE_PATTERN,
  GATE_STATE_PATTERN,
  READINESS_STATE_VERSION,
  REVIEW_FINDINGS_BOT_LOGINS,
  CODE_RABBIT_LOGIN,
  CODE_RABBIT_ACTIONABLE_RE,
  CODE_RABBIT_OUTSIDE_DIFF_MARKER_RE,
  latestCodeRabbitReviewForHead,
  coderabbitOutsideDiffFindingIds,
  coderabbitOutsideDiffFindings,
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
  completionIsStale
};
