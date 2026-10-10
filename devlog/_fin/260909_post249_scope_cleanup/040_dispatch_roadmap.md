# 040 — dispatch roadmap (post-2.49 delivery round)

Loop: cxc-loop HOTL under an active host goal. Main session owns phase control,
merge order, and rebase timing. Eight parallel worktree threads own implementation.

## Delivery contract (identical for every thread)

- Skills: cxc-loop + cxc-dev. Classify each item C0-C5 and scale process to it.
- NEVER run the local product suite, typecheck, build, or install. Remote CI on the
  exact PR head is the only gate. Label skipped local checks NOT RUN.
- Push with `--no-verify`. Branch prefix `codex/` (or keep an existing head branch
  when shepherding someone else's PR).
- Every PR bases on `dev` at 57077ca32 unless it is a child inside its own chain,
  in which case it bases on its parent's head branch.
- Do NOT rebase. The main session controls rebase timing after watching merge order.
- Threads may dispatch xai/grok-4.6 subagents (spawn_agent) for parallel bounded work.
- Carry `Co-authored-by` trailers when landing or shepherding another author's work.

## Thread map

| T | Owns | Kind | Base |
|---|---|---|---|
| 1 | #4114, #4084, #4068 | shepherd 3 open PRs to ready | dev (existing heads) |
| 2 | #4127 (issue #4112) -> #3573 | shepherd + child | dev, then #4127 head |
| 3 | #4128 (issue #4122) | shepherd | dev (existing head) |
| 4 | #4120 -> #3848 -> #3777 | new + shepherd + new | dev, then chain |
| 5 | #4089 | new (C4, security review before merge) | dev |
| 6 | #4057 | new | dev |
| 7 | #3761 Design A | new (largest) | dev |
| 8 | #4073, #4121 | docs only | dev |

## Merge order (main session controls)

Land bottoms as they go green; do not wait for tops.
#4114 -> #4068/#4084/#4073 -> #4127/#4128 (first green wins, loser rebases on
instruction) -> #4120 -> #4121-docs/#4057 -> #4089 -> #3573 -> #3777 -> #3848 -> #3761.

Independent of any chain: #4114, #4068, #4084, #4073, #4127, #4128, #4120, #4057, #4121.
Chain-dependent: #3573 (needs #4127), #3777 (needs #3848 for cli/account-api.ts),
#3848 (needs #4120 for the account store/guardian fields), #3761 (wants a settled core.ts).

## Shared-file risk

`src/server/responses/core.ts` is the common trunk for #4127, #4128, #4089, #3573,
#3761, and part of #4057. Parallel implementation is fine; merging is serial and the
main session issues the rebase instruction to whichever PR loses the race.

`token-guardian.ts` / `account-store.ts` / `types/accounts.ts` are the second trunk,
shared by #4120 and #3848 — which is why they are one chain rather than two lanes.

## Probes (main session, no PR)

#3782 Claude Desktop in-conversation model switch, #3765 Astra cache plateau,
#3719 Anthropic thinking replay. Evidence attaches to the issues.

## Out of this round

#4076 closed (transient overlay; registration half covered by #3848).
#3506 direction comment posted (translation fidelity, not a proxy-side progress cutoff).
#2495 dropped after a feasibility study: not redundant with #4089, needs its own cycle.
#3978 deferred until the compaction status contract settles.
