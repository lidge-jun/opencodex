"use strict";

/**
 * Deletion planning for branches left behind by closed-without-merge pull
 * requests.
 *
 * GitHub's repository-level `delete_branch_on_merge` only fires on merge, so a
 * PR that is closed unmerged leaves its head branch in the repository forever.
 * This module decides which of those branches may be deleted; the workflow
 * performs the deletion.
 *
 * Kept as a pure module so the safety rules can be unit-tested without Actions
 * and without a live repository.
 */

/** Branches that may never be deleted regardless of pull-request state. */
const PROTECTED_BRANCHES = Object.freeze(["main", "dev", "preview", "gh-pages"]);

/** Branch namespaces explicitly reserved for disposable pull-request work. */
const DISPOSABLE_BRANCH_PREFIXES = Object.freeze(["codex/", "ingw/"]);

/** Default grace period before a closed PR's head branch becomes eligible. */
const DEFAULT_GRACE_DAYS = 14;

function normalizeBranchName(value) {
  // Git permits non-ASCII whitespace in ref names, while String#trim removes
  // it. Preserve API-provided branch identity byte-for-byte so two distinct
  // refs cannot collapse into one deletion candidate.
  return typeof value === "string" ? value : "";
}

/**
 * A commit id, lowercased for comparison.
 *
 * The REST and GraphQL APIs are not consistent about case, and a full 40-character
 * sha compared case-sensitively against an abbreviated or upper-case one silently
 * reads as "different" - which here would mean "keep", so the failure direction is
 * safe, but it would make the guard useless rather than protective. Anything that
 * is not a plausible hex object id becomes null, i.e. unknown.
 */
function normalizeOid(value) {
  const text = String(value || "").trim().toLowerCase();
  return /^[0-9a-f]{7,64}$/.test(text) ? text : null;
}

function isProtectedBranch(name) {
  return PROTECTED_BRANCHES.includes(normalizeBranchName(name));
}

function toTimestamp(value) {
  if (!value) return null;
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Reasons a candidate branch is kept. Exported so the workflow can log a
 * stable, greppable verdict per branch instead of a free-form sentence.
 */
const KEEP_REASONS = Object.freeze({
  PROTECTED: "protected-branch",
  MERGED: "pull-request-merged",
  OPEN: "open-pull-request",
  BASE_OF_OPEN: "base-of-open-pull-request",
  CROSS_REPOSITORY: "cross-repository-head",
  MISSING_CLOSED_AT: "missing-closed-at",
  WITHIN_GRACE: "within-grace-period",
  OUTSIDE_DISPOSABLE_NAMESPACE: "outside-disposable-namespace",
  MOVED_SINCE_CLOSE: "branch-moved-since-close",
  UNKNOWN_HEAD_SHA: "unknown-head-sha",
});

/**
 * Plan deletions for head branches of closed-unmerged pull requests.
 *
 * Every rule here is a safety rule, and each one exists because the opposite
 * behavior destroys work that is still referenced:
 *
 * - A branch is a candidate only when *every* pull request that ever used it as
 *   a head is closed and unmerged. One open or merged PR on the same branch
 *   keeps it, because reopening a PR whose head branch is gone cannot restore
 *   the commits.
 * - A branch that is the base of an open pull request is kept. Deleting it
 *   closes the stacked child PR that targets it.
 * - Cross-repository (fork) heads are never touched: they live in the
 *   contributor's repository and this token has no business there.
 * - A grace period after `closed_at` leaves room to reopen a PR that was
 *   closed by mistake.
 * - Only branches under namespaces explicitly reserved for disposable pull-
 *   request work are eligible. Pull-request history alone must not authorize
 *   deletion of an unrelated persistent branch.
 * - Branch names are compared and emitted byte-for-byte. Normalizing Unicode
 *   whitespace can merge distinct valid refs and delete the wrong branch.
 * - The branch must still POINT AT a commit one of those closed pull requests
 *   had as its head. Matching by NAME alone deletes reused work: `codex/`-style
 *   names get picked up again all the time, and a branch recreated for new work
 *   inherits the closed history of every PR that ever used that name. The tip
 *   moved, so the branch is not the closed PR's branch any more - it only shares
 *   its label.
 * - A branch whose current tip cannot be determined is kept. An unknown tip is
 *   not evidence of an abandoned branch, and this job's mistakes are not
 *   recoverable.
 *
 * @param {object} input
 * @param {Array<object>} input.pullRequests Pull requests with
 *   `headRefName`, `headRefOid`, `baseRefName`, `state`, `merged`, `closedAt`,
 *   and `isCrossRepository`.
 * @param {Array<string|{name: string, oid?: string}>} input.branches Branches
 *   that currently exist. A bare string carries no tip, which is treated as an
 *   unknown tip and kept.
 * @param {number} [input.now] Current time in milliseconds.
 * @param {number} [input.graceDays] Days to wait after `closedAt`.
 * @returns {{ deletions: Array<{branch: string, pullRequests: number[]}>,
 *   keeps: Array<{branch: string, reason: string}> }}
 */
function planClosedPrBranchDeletions({
  pullRequests = [],
  branches = [],
  now = Date.now(),
  graceDays = DEFAULT_GRACE_DAYS,
}) {
  // Accepts both shapes so an older caller passing bare names still works - it
  // just gets the conservative answer, because a name without a tip cannot be
  // proven safe to delete.
  /** @type {Map<string, string|null>} */
  const existing = new Map();
  for (const entry of branches) {
    const name = normalizeBranchName(typeof entry === "string" ? entry : entry && entry.name);
    if (!name) continue;
    const oid = typeof entry === "string" ? null : normalizeOid(entry && entry.oid);
    existing.set(name, oid);
  }
  const graceMs = Math.max(0, Number(graceDays) || 0) * 24 * 60 * 60 * 1000;

  /** @type {Map<string, object[]>} */
  const byHead = new Map();
  const openBases = new Set();

  for (const pr of pullRequests) {
    const head = normalizeBranchName(pr && pr.headRefName);
    if (head) {
      const list = byHead.get(head) || [];
      list.push(pr);
      byHead.set(head, list);
    }
    const isOpen = String(pr && pr.state).toUpperCase() === "OPEN";
    if (isOpen) {
      const base = normalizeBranchName(pr && pr.baseRefName);
      if (base) openBases.add(base);
    }
  }

  const deletions = [];
  const keeps = [];

  for (const branch of [...existing.keys()].sort()) {
    if (isProtectedBranch(branch)) {
      keeps.push({ branch, reason: KEEP_REASONS.PROTECTED });
      continue;
    }

    const related = byHead.get(branch) || [];
    if (related.length === 0) continue; // No PR ever used it; out of scope.

    if (related.some((pr) => pr && pr.isCrossRepository === true)) {
      keeps.push({ branch, reason: KEEP_REASONS.CROSS_REPOSITORY });
      continue;
    }
    if (related.some((pr) => pr && pr.merged === true)) {
      keeps.push({ branch, reason: KEEP_REASONS.MERGED });
      continue;
    }
    if (related.some((pr) => String(pr && pr.state).toUpperCase() === "OPEN")) {
      keeps.push({ branch, reason: KEEP_REASONS.OPEN });
      continue;
    }
    if (openBases.has(branch)) {
      keeps.push({ branch, reason: KEEP_REASONS.BASE_OF_OPEN });
      continue;
    }

    const closedTimestamps = related.map((pr) => toTimestamp(pr && pr.closedAt));
    if (closedTimestamps.some((ts) => ts === null)) {
      keeps.push({ branch, reason: KEEP_REASONS.MISSING_CLOSED_AT });
      continue;
    }
    const newestClosedAt = Math.max(...closedTimestamps);
    if (now - newestClosedAt < graceMs) {
      keeps.push({ branch, reason: KEEP_REASONS.WITHIN_GRACE });
      continue;
    }

    if (!DISPOSABLE_BRANCH_PREFIXES.some((prefix) => branch.startsWith(prefix))) {
      keeps.push({ branch, reason: KEEP_REASONS.OUTSIDE_DISPOSABLE_NAMESPACE });
      continue;
    }

    // The tip check, last because it is the most expensive claim to satisfy and
    // the cheaper rules above have already excluded most branches.
    //
    // A closed PR's head branch is only THIS branch if the branch still points at
    // a commit that PR had as its head. Without this, a name reused for new work
    // is deleted on the strength of an unrelated PR that happened to share the
    // label months earlier - and a deleted branch whose commits were never pushed
    // anywhere else is gone.
    const currentOid = existing.get(branch) || null;
    if (!currentOid) {
      keeps.push({ branch, reason: KEEP_REASONS.UNKNOWN_HEAD_SHA });
      continue;
    }
    const closedOids = new Set(
      related.map((pr) => normalizeOid(pr && pr.headRefOid)).filter(Boolean),
    );
    // An empty set means the API gave us no head SHA for any of them, which is the
    // unknown case again rather than a licence to delete.
    if (closedOids.size === 0) {
      keeps.push({ branch, reason: KEEP_REASONS.UNKNOWN_HEAD_SHA });
      continue;
    }
    if (!closedOids.has(currentOid)) {
      keeps.push({ branch, reason: KEEP_REASONS.MOVED_SINCE_CLOSE });
      continue;
    }

    deletions.push({
      branch,
      pullRequests: related
        .map((pr) => Number(pr && pr.number))
        .filter((n) => Number.isFinite(n))
        .sort((a, b) => a - b),
    });
  }

  return { deletions, keeps };
}

module.exports = {
  DEFAULT_GRACE_DAYS,
  DISPOSABLE_BRANCH_PREFIXES,
  KEEP_REASONS,
  PROTECTED_BRANCHES,
  isProtectedBranch,
  planClosedPrBranchDeletions,
};
