/**
 * Deletion planning for .github/scripts/closed-pr-branch-cleanup.cjs.
 *
 * This job deletes branches, so every test here is a safety test. It had no
 * coverage at all, which is how a name-only match reached main: the planner
 * selected any branch whose same-NAME historical pull requests were all closed,
 * without checking that the branch still pointed at one of their head commits.
 * A `codex/`-style name reused for new work inherited the closed history of
 * every PR that had ever carried that label.
 */
import { describe, expect, test } from "bun:test";

/**
 * Dynamic import rather than `require`: the repo's other CommonJS-helper tests reach for
 * `await import(...)` (ci-workflows.test.ts:5030), and a `no-require-imports` suppression
 * here would be a new lint suppression for a problem that has a supported spelling.
 */
interface CleanupModule {
  DEFAULT_GRACE_DAYS: number;
  KEEP_REASONS: Record<string, string>;
  PROTECTED_BRANCHES: string[];
  isProtectedBranch: (name: string) => boolean;
  planClosedPrBranchDeletions: (input: {
    pullRequests?: unknown[];
    branches?: unknown[];
    now?: number;
    graceDays?: number;
  }) => { deletions: { branch: string; pullRequests: number[] }[]; keeps: { branch: string; reason: string }[] };
}

const cleanup = await import("../.github/scripts/closed-pr-branch-cleanup.cjs") as unknown as CleanupModule & { default?: CleanupModule };
// A .cjs module reached through ESM interop may arrive under `default`; taking whichever
// carries the planner keeps the test honest about what it is calling.
const api: CleanupModule = typeof cleanup.planClosedPrBranchDeletions === "function"
  ? cleanup
  : cleanup.default!;
const { KEEP_REASONS, planClosedPrBranchDeletions } = api;

const NOW = Date.parse("2026-08-27T00:00:00Z");
const LONG_AGO = new Date(NOW - 90 * 24 * 60 * 60 * 1000).toISOString();
const OLD_TIP = "a".repeat(40);
const NEW_TIP = "b".repeat(40);

function closedPr(over: Record<string, unknown> = {}) {
  return {
    number: 42,
    state: "CLOSED",
    merged: false,
    closedAt: LONG_AGO,
    headRefName: "codex/some-work",
    headRefOid: OLD_TIP,
    baseRefName: "dev",
    isCrossRepository: false,
    ...over,
  };
}

function plan(pullRequests: unknown[], branches: unknown[]) {
  return planClosedPrBranchDeletions({ pullRequests, branches, now: NOW, graceDays: 14 });
}

function keepReason(result: ReturnType<typeof plan>, branch: string): string | undefined {
  return result.keeps.find(k => k.branch === branch)?.reason;
}

describe("closed-PR branch cleanup planning", () => {
  test("an abandoned branch still at the closed PR tip is deleted", () => {
    // The case the job exists for. If this stops passing the job has become
    // a no-op, which is a different failure from deleting live work but still
    // a failure.
    const result = plan(
      [closedPr()],
      [{ name: "codex/some-work", oid: OLD_TIP }],
    );
    expect(result.deletions).toEqual([{ branch: "codex/some-work", pullRequests: [42] }]);
  });

  test("an abandoned ingw branch still at the closed PR tip is deleted", () => {
    const result = plan(
      [closedPr({ headRefName: "ingw/some-work" })],
      [{ name: "ingw/some-work", oid: OLD_TIP }],
    );
    expect(result.deletions).toEqual([{ branch: "ingw/some-work", pullRequests: [42] }]);
  });

  test("a persistent branch outside disposable namespaces is kept", () => {
    const branch = "release/maintenance";
    const result = plan(
      [closedPr({ headRefName: branch })],
      [{ name: branch, oid: OLD_TIP }],
    );
    expect(result.deletions).toEqual([]);
    expect(keepReason(result, branch)).toBe(KEEP_REASONS.OUTSIDE_DISPOSABLE_NAMESPACE);
  });

  test("near-miss prefixes do not enter disposable namespaces", () => {
    for (const branch of ["codexx/some-work", "ingw2/some-work"]) {
      const result = plan(
        [closedPr({ headRefName: branch })],
        [{ name: branch, oid: OLD_TIP }],
      );
      expect(result.deletions).toEqual([]);
      expect(keepReason(result, branch)).toBe(KEEP_REASONS.OUTSIDE_DISPOSABLE_NAMESPACE);
    }
  });

  test("Unicode whitespace preserves ref identity and cannot create a namespace match", () => {
    const trailing = "codex/some-work\u00a0";
    const collision = plan(
      [closedPr({ headRefName: trailing })],
      [
        { name: "codex/some-work", oid: NEW_TIP },
        { name: trailing, oid: OLD_TIP },
      ],
    );
    expect(collision.deletions).toEqual([{ branch: trailing, pullRequests: [42] }]);

    const leading = "\u00a0codex/some-work";
    const outside = plan(
      [closedPr({ headRefName: leading })],
      [{ name: leading, oid: OLD_TIP }],
    );
    expect(outside.deletions).toEqual([]);
    expect(keepReason(outside, leading)).toBe(KEEP_REASONS.OUTSIDE_DISPOSABLE_NAMESPACE);
  });

  test("BUG-R4: a branch reused for new work is kept, not deleted", () => {
    // Same NAME, different tip. Before the SHA guard this returned a deletion
    // for a branch carrying commits that had never been in any pull request.
    const result = plan(
      [closedPr()],
      [{ name: "codex/some-work", oid: NEW_TIP }],
    );
    expect(result.deletions).toEqual([]);
    expect(keepReason(result, "codex/some-work")).toBe(KEEP_REASONS.MOVED_SINCE_CLOSE);
  });

  test("a tip matching ANY of several closed PRs is enough", () => {
    // Reopening and reclosing a branch, or two PRs from the same head, must not
    // make the branch undeletable forever - matching one closed head is the bar.
    const result = plan(
      [
        closedPr({ number: 7, headRefOid: OLD_TIP }),
        closedPr({ number: 9, headRefOid: NEW_TIP }),
      ],
      [{ name: "codex/some-work", oid: NEW_TIP }],
    );
    expect(result.deletions).toEqual([{ branch: "codex/some-work", pullRequests: [7, 9] }]);
  });

  test("an unknown current tip is kept", () => {
    // A bare string carries no tip. An older caller passing names gets the
    // conservative answer rather than the old destructive one.
    const result = plan([closedPr()], ["codex/some-work"]);
    expect(result.deletions).toEqual([]);
    expect(keepReason(result, "codex/some-work")).toBe(KEEP_REASONS.UNKNOWN_HEAD_SHA);
  });

  test("an unknown closed head SHA is kept", () => {
    const result = plan(
      [closedPr({ headRefOid: null })],
      [{ name: "codex/some-work", oid: OLD_TIP }],
    );
    expect(result.deletions).toEqual([]);
    expect(keepReason(result, "codex/some-work")).toBe(KEEP_REASONS.UNKNOWN_HEAD_SHA);
  });

  test("SHA comparison ignores case", () => {
    // The REST and GraphQL APIs disagree about case. A case-sensitive compare
    // would keep every branch and quietly turn the job into a no-op.
    const result = plan(
      [closedPr({ headRefOid: OLD_TIP.toUpperCase() })],
      [{ name: "codex/some-work", oid: OLD_TIP }],
    );
    expect(result.deletions).toHaveLength(1);
  });

  test("the existing safety rules still hold ahead of the tip check", () => {
    // Each of these must win BEFORE the SHA comparison, so a matching tip cannot
    // override them. Asserted through the keep reason, not just the empty
    // deletion list: the reason is what proves which rule fired.
    const at = (name: string, oid: string | null = OLD_TIP) => [{ name, oid }];

    const merged = plan([closedPr({ merged: true })], at("codex/some-work"));
    expect(keepReason(merged, "codex/some-work")).toBe(KEEP_REASONS.MERGED);

    const open = plan([closedPr({ state: "OPEN" })], at("codex/some-work"));
    expect(keepReason(open, "codex/some-work")).toBe(KEEP_REASONS.OPEN);

    const fork = plan([closedPr({ isCrossRepository: true })], at("codex/some-work"));
    expect(keepReason(fork, "codex/some-work")).toBe(KEEP_REASONS.CROSS_REPOSITORY);

    const stacked = plan(
      [
        closedPr(),
        closedPr({ number: 43, state: "OPEN", headRefName: "codex/child", baseRefName: "codex/some-work" }),
      ],
      at("codex/some-work"),
    );
    expect(keepReason(stacked, "codex/some-work")).toBe(KEEP_REASONS.BASE_OF_OPEN);

    const recent = plan(
      [closedPr({ closedAt: new Date(NOW - 60 * 60 * 1000).toISOString() })],
      at("codex/some-work"),
    );
    expect(keepReason(recent, "codex/some-work")).toBe(KEEP_REASONS.WITHIN_GRACE);

    const protectedBranch = plan([closedPr({ headRefName: "dev" })], at("dev"));
    expect(keepReason(protectedBranch, "dev")).toBe(KEEP_REASONS.PROTECTED);
  });

  test("a branch no pull request ever used is out of scope entirely", () => {
    // Neither deleted nor reported as a keep: this job only speaks about
    // branches it can attribute to a pull request.
    const result = plan([closedPr()], [{ name: "codex/never-a-pr", oid: NEW_TIP }]);
    expect(result.deletions).toEqual([]);
    expect(keepReason(result, "codex/never-a-pr")).toBeUndefined();
  });
});
