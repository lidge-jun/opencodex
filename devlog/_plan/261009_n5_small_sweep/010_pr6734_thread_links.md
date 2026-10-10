# 010 — wp1: PR #6734, Codex thread links in the conversation filter

**Reader summary.** #6734 (luvs01) lets the Logs conversation filter, `GET /api/logs?conversationId=` and
`ocx logs filter --conversation` accept a pasted `codex://threads/<id>` link. Its CI ran green on an older dev
base; this phase proves it still holds on current dev and gets an independent review. No code is written
unless the review finds a defect.

## Facts (verified against origin/dev 730d898457)

- Head `ca2391373f10795bf9270ba388344bec2ec2301f`, MERGEABLE, all triggered checks green on that head
  (Cross-platform CI run 37725885408; enforce-target/hygiene reruns 37846215811/37846185830).
- Union: `git merge-tree --write-tree origin/dev pr/6734` exit 0, no conflicts, tree `9e44b77e61`.
- Ten touched files; only `structure/dashboard-and-usage.md` changed on dev since the PR base (lines 336, 500);
  the union reaches the 600-line structure budget exactly (`structure/manifest.json:3`, enforced by
  `scripts/structure-ssot.ts:350-357`). No file-size baseline caps apply; no test-layout registration changes.

## Plan

1. Independent gpt-6.1-sol review (no builder context; the lane did not author the change) of the PR diff
   against current dev: bounded unwrap (512 chars, `src/server/request-log-conversation.ts:40-66`), digest
   bound (4096, lines 20-37), case handling (57, 61, 92-94), dual candidates (75-78), GUI mirror
   `gui/src/log-conversation-id.ts`, privacy (no raw ID logging, no persistence change), docs/structure
   contract wording.
2. Union verification (already run by the explorer; re-run by the reviewer only if it doubts it):
   `bun test tests/usage/request-log-conversation.test.ts tests/cli/cli-log-view-filter.test.ts` (exit 0, 96 pass;
   reads the target: both files are named directly), `(cd gui && bun test tests/logs-filter.test.ts
   tests/logs-filter-bar.test.ts)` (exit 0, 28 pass), `bun run typecheck` (exit 0; covers `src/` only, GUI
   compile is covered by hosted `gates`), `bun run structure:check` on the union tree for the 600-line budget.
3. Decision rule: review PASS + union checks pass → original PR READY (no carry; lane cannot rerun another
   author's CI, and the exact head is unchanged). Review FAIL with a fix → carry to
   `codex/n5-6734-thread-links` (cherry-pick the six commits, keep authors, add the fix, `Co-authored-by: luvs01`),
   open a dev PR. Structure budget failure on the union → carry with a one-line structure trim.

## Acceptance

- Reviewer verdict PASS (or FAIL folded via carry and re-reviewed PASS).
- Union structure:check exit 0 (activation: the 600-line budget is exactly hit; a 601st line would fail).
- Final report lists #6734 as READY (original) or the carry PR, and nothing to close until merge.

## Cycle revision (wp1 P, origin/dev bb36029ef9)

The facts above were observed at dev `730d898457` and are historical. dev moved one commit (#6820, Codex home
restore; it touches none of the ten files). This cycle replaces "already run" with fresh checks:

- **W1 union.** In the lane worktree, create the unpublished branch `n5-union-6734` from origin/dev `bb36029ef9` and
  `git merge --no-ff refs/remotes/pr/6734` (head `ca2391373f`). Record parents, union commit and tree in 011. A conflict
  switches to the carry path. The branch is never pushed.
- **W2 review.** The independent gpt-6.1-sol review (reviewer 01a1205e, no builder context) is bound to the PR head and
  current dev; its verdict, findings and limitations go to `011_pr6734_review.md` on `codex/n5-small`.
- **W3 checks.** Session source is the lane worktree; C runs `cxc receipt test` with the union branch checked out:
  the two root test files, the two GUI test files, `bun run typecheck`, `bun run structure:check`. 011 is committed on
  `codex/n5-small` after switching back, so the doc commit is never confused with the tested tree.
- **W4 READY.** Original READY additionally requires a fresh read of the PR's exact-head checks, review threads and
  mergeability at report time; an unchanged head alone does not refresh that evidence.
