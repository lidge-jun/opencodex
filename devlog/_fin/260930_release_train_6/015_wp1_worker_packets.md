# wp1 — worker packets

Dispatch text for the four lane workers. Security reviewers get separate read-only packets.

## Common packet (prepended to every lane packet)

- ROLE: implementation worker for one RT6 lane (gpt-6-sol subagent, leaf). No goal, FSM or spawning.
- REPO: lidge-jun/opencodex (remote `origin`). Your worktree is the path named in your lane packet;
  run every command with that path as workdir. Never touch /Users/jun/.codex/worktrees/dc4c/opencodex
  (the coordinator's checkout) except to read the plan documents. Every exec_command sets `workdir`
  to your worktree; every apply_patch/file edit uses an absolute path inside your worktree; never run
  git without that workdir. Dry-run merges go on disposable local branches deleted afterwards.
- READ FIRST: AGENTS.md at the repo root, the nearest nested AGENTS.md for each directory you edit,
  000_plan.md (credit rule, union risks) and your lane doc in this unit.
- MUST: small commits; `bun install --frozen-lockfile` once in your worktree; focused tests from your
  lane doc plus `bun run typecheck`; `bun run privacy:scan` before any push; file-size ratchet and
  both test-layout manifests respected; PR bodies fill Summary / Verification / Checklist of
  .github/PULL_REQUEST_TEMPLATE.md and say plainly which checks ran locally and what is left to CI.
- MAY: push your own `codex/rt6-*` branches; open PRs against `dev`; push fix-up commits to the
  in-repo branch named in your lane doc after re-checking its head SHA (no force-push, stop and report
  if it moved); reply on the specific review thread your fix-up addresses, naming the commit.
- MUST NOT: merge, approve workflow runs, close or label issues/PRs, force-push, rewrite another
  author's commits, run the full `bun run test` (four lanes share this machine; CI runs it), write
  security analysis anywhere tracked.
- PREFLIGHT: before the first mutation, `git -C <lane root> rev-parse --show-toplevel` must equal
  `realpath <lane root>` (on macOS /tmp resolves to /private/tmp); otherwise stop and report.
- RETURN: per item — status (READY / HANDOFF with patch branch+commit and observed PR head / DEFER
  with the unmet gate), PR URL, head SHA, commands run with pass/fail counts, open questions. Keep it
  under 60 lines.

## L1

- WORKTREE: `/tmp/ocx-rt6-l1` (created by the coordinator from origin/dev).
- LANE DOC: `011_wp1_l1_provider_client.md`.
- TASK: Review #6230 and #6236 heads (verdict + tests on a local fetch of pull/<n>/head); carry #6225; run the #6242 evidence step and, only if it succeeds, the fix.

## L2

- WORKTREE: `/tmp/ocx-rt6-l2` (created by the coordinator from origin/dev).
- LANE DOC: `012_wp1_l2_anthropic_pool.md`.
- TASK: Dry-run #6204 then #6207 merge on dev; fix-up #6203 in place; carry #6234. #6244 is out of scope for this worker.

## L3

- WORKTREE: `/tmp/ocx-rt6-l3` (created by the coordinator from origin/dev).
- LANE DOC: `013_wp1_l3_transport.md`.
- TASK: Review #6235 (dry-run merge with #6204 head); carry #6232 with the sibling test; fix-up #6200 in place.

## L4

- WORKTREE: `/tmp/ocx-rt6-l4` (created by the coordinator from origin/dev).
- LANE DOC: `014_wp1_l4_platform.md`.
- TASK: Review #6238 and add negative cases if missing; bring #6161 current from dev and fix-up in place; record packaged evidence claims (a)/(b).
