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

/** Default grace period before a closed PR's head branch becomes eligible. */
const DEFAULT_GRACE_DAYS = 14;

function normalizeBranchName(value) {
  return String(value || "").trim();
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
 *
 * @param {object} input
 * @param {Array<object>} input.pullRequests Pull requests with
 *   `headRefName`, `baseRefName`, `state`, `merged`, `closedAt`, and
 *   `isCrossRepository`.
 * @param {Array<string>} input.branches Branch names that currently exist.
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
  const existing = new Set(branches.map(normalizeBranchName).filter(Boolean));
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

  for (const branch of [...existing].sort()) {
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
  KEEP_REASONS,
  PROTECTED_BRANCHES,
  isProtectedBranch,
  planClosedPrBranchDeletions,
};
