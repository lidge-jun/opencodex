# wp1 — lane preparation (index)

Four lanes run in parallel, one gpt-6-sol worker each, in separate git worktrees created by the
coordinator from `origin/dev`: `/tmp/ocx-rt6-l1` .. `/tmp/ocx-rt6-l4`. Lane docs: 011 (L1 provider and
client), 012 (L2 Anthropic pool; #6244 investigation only), 013 (L3 transport), 014 (L4 platform).

Surface: the owner asked for gpt-6-sol subagents, so lanes are subagents rather than separate
tasks. A subagent starts in the coordinator's checkout, so isolation is enforced by the packet and
checked by the coordinator: every shell command carries an explicit `workdir` of the lane worktree,
every file edit uses an absolute path under that worktree, and every git command runs there (each
worktree has its own HEAD, so branch operations in different worktrees do not collide). Before
dispatch the coordinator creates the four worktrees and records root, branch and HEAD, and records
its own checkout's branch and HEAD (`codex/rt6-coordinator`, the HEAD at dispatch). After every
worker report it compares its own branch, HEAD and `git status` with those records and stops the
train on any difference, then checks the lane's commits sit on the lane's branches. Workers run a
preflight before their first mutation: `git -C <lane root> rev-parse --show-toplevel` must equal
`realpath <lane root>` (/tmp is /private/tmp on this host).

Worker authority: create branches, commit, push lane branches and fix-up commits to the named in-repo
branches (no force-push, head re-checked before push), open carry/fix PRs against `dev` with the full
template. Workers never merge, never approve workflow runs, never close issues, never comment on
contributors' PRs except to answer the specific review thread their fix-up addresses.

Independent read-only gpt-6-sol security reviewers (separate agents) review #6204/#6207, #6203,
#6200, #6238 and #6161.

Exit criteria for wp1: every selected item is either (a) READY, a PR whose head is ready for the merge
gate in 020, (b) HANDOFF, a patch branch/commit the coordinator must still apply to a contributor PR
(the coordinator applies it and re-reads the PR head before wp1 closes, turning it into READY or
DEFER; wp1 does not exit with any HANDOFF left), or (c) DEFER with its unmet gate. Evidence: each
worker's report (PR URL, head SHA, commands and results), security review verdicts.

Worktrees created 2026-09-30 before dispatch (detached at origin/dev 73289d46ae):
/tmp/ocx-rt6-l1, /tmp/ocx-rt6-l2, /tmp/ocx-rt6-l3, /tmp/ocx-rt6-l4.

Architect wp1 reflection (MISALIGNED, 3 gaps) disposition: (1) subagent cwd — kept subagents per the
owner's request, isolation by absolute paths/workdir plus coordinator checks (above); (2) worktrees
created and recorded; (3) dry runs moved to disposable never-pushed branches (012, 013).
