# 260914 — Round 2/3 delivery roadmap

## Where this starts

The 2026-09-14 triage delivery loop closed with #4519, #4534, #4535, #4536,
#4539, #4555, #4562 and #4563 on dev. What it did not do is reduce the open
surface: 63 pull requests and 63 issues are still open, and a large share of the
pull requests are contributor work that is already green and simply never got
landed. This unit plans two more delivery rounds against that backlog.

## Objective

Rebuild the lane roadmap, run two merge rounds, and finish with a closure sweep
that closes at least 10 issues and at least 10 pull requests with written
reasons. Every close names either a merge commit or the change that supersedes
it.

## Delivery constraints carried from the session

- Lanes are **worktree Codex threads**, one per branch. Subagents inside a lane
  are that lane's workers; they never own a branch of their own.
- Lane orchestrators split between `anthropic/claude-opus-5` and `kimi/k3[1m]`.
- Inside a lane, implementation is delegated to `devin/swe-2` and
  `xai/grok-4.6` subagents at roughly a 2:3 ratio.
- Each lane runs `cxc-loop` itself: its own goal, its own PABCD cycle.
- **No local suite.** `bun run test`, `bun run typecheck` and `bun install` are
  not run locally. Proof is hosted CI at the exact final head, nothing else.
- Pushes use `--no-verify`.
- Merges into dev are admin squash merges, taken on maintainer judgment under
  the MAINTAINERS.md single-maintainer dev integration policy, with exact-head
  CI recorded.
- Landing another author's work carries a `Co-authored-by` trailer in a branch
  commit so it survives the squash.

## Round shape

Two merge rounds, then one closure sweep.

| Round | Work | Merge target |
|---|---|---|
| 1 (wp2) | 5 lane threads on issues that have no pull request, plus review-and-land of the already-green contributor queue | dev |
| 2 (wp3) | 4 lane threads on the second issue cluster, plus the second contributor batch | dev |
| Sweep (wp4) | Close resolved issues with merge references, close superseded and abandoned pull requests with reasons | — |

## Acceptance criteria

1. This roadmap unit exists with per-lane issue assignment, dispatch models and
   acceptance criteria.
2. Round 1 lanes were dispatched as separate worktree threads and their pull
   requests reached green hosted CI at their exact final head.
3. Round 1 pull requests were admin squash-merged into dev with recorded merge
   commits.
4. Round 2 lanes were dispatched and squash-merged into dev the same way.
5. At least 10 issues are closed with a merge-commit reference or a written
   supersession reason.
6. At least 10 pull requests are closed — merged, or closed with a written reason
   naming the superseding change.

## What would make this fail

The backlog is contributor work, so the failure mode is not "no code lands", it
is "code lands that nobody reviewed". A green check on a three-day-old head is
not evidence about the head being merged. Every merge in this unit re-reads the
diff at the head it is about to squash, and re-reads CI at that same SHA.
