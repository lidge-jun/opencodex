# 260914 — Triage round lanes: two merge rounds, four worktree lanes

Status: OPEN. Opened 2026-09-14 KST. Owner: main orchestration session
`01a09bc0-bb13-7393-8526-785a3aeacb91`, goalplan slug
`opencodex-2026-09-14-triage-delivery-loop-hotl-o`.

## Objective

Land 9-11 pull requests into `dev` across two merge rounds, then close the issues
and pull requests those merges resolve or supersede. The input is the 2026-09-14
triage of 64 open PRs and 60 open issues; this unit is the delivery half of it.

## Why this shape

The triage queue mixes two kinds of work that cannot be orchestrated the same way.
PRs #4528, #4529, #4511 and #4512 belong to outside contributors: the work there is
verification and merge, and nothing can be stacked on a fork branch. The remaining
items — the #4515 follow-up, #4519, #4530 and #4516 — are ours to author, and only
those can carry a branch chain. Treating the whole queue as one stack is the failure
mode this unit exists to avoid.

Ordering inside a chain follows gate speed, not importance. #4519 is the highest
priority item in the triage and it sits at the TOP of its lane, because it needs an
independent security review that can stall for days. A stalled bottom layer freezes
everything above it; a stalled top layer costs nothing once its parent has landed.

## Verified repository facts (2026-09-14)

These were read live and decide the merge mechanics. Refresh before acting on them.

- `dev` ruleset carries `deletion`, `non_fast_forward` and `pull_request`
  (1 approval, code-owner review required). There is **no** required-status-check
  rule and **no** strict up-to-date rule, so a `dev` move does not mechanically
  invalidate another PR's checks. Batch merging disjoint PRs inside one CI
  generation is therefore sound, and the residual risk is semantic, not textual.
- Cross-platform CI runs in 9-11 minutes (runs observed 2026-09-13T16:54-17:03 and
  17:12-17:23).
- Contributor fork PRs sit at `action_required`: their workflow runs have never
  executed. #4528 and #4529 both show this. Approving those runs is the first
  merge-track action, not the last.
- `src/web-search/passthrough-bridge.ts` holds both `resolveOllamaWebSearchEndpoint`
  (119-243) and `sidecarSettingsForBridge` (689). The two lane-A layers collide in
  one file, which is what makes lane A a real chain rather than two parallel PRs.

## Lane map

Four `environment: worktree` threads. Write-sets are disjoint by construction; that
disjointness is what licenses the batch merge above.

| Lane | Orchestrator | Bottom layer | Top layer | Write set |
|---|---|---|---|---|
| L1 | `anthropic/claude-opus-5` high | sidecar backend/model agreement | #4519 endpoint destination policy | `src/web-search/`, `src/server/responses/core.ts` (~6290) |
| L2 | `kimi/k3[1m]` high | catalog parser preserves `supportsImages` | capability propagation + override precedence | `src/adapters/devin/`, `src/codex/catalog/provider-fetch.ts` |
| L3 | `anthropic/claude-opus-5` high | #4516 spare-budget argument restoration | budget/ordering regressions | `src/adapters/cursor/` |
| L4 | `kimi/k3[1m]` high | #4529 carry, version-skew refusal plus its unknown-version case | #4512 live-failure regressions | `src/cli/index.ts`, `src/cli/system-restart-client.ts`, `tests/cli/`, `tests/server/audio-dictation.test.ts` |

Lane A's top layer is security-gated. If it stalls past round 2, cut it loose from
the chain and re-base it directly on `dev` rather than holding the lane open.

L4 is not a tests-only lane. The #4529 carry writes `src/cli/index.ts` and
`src/cli/system-restart-client.ts`, so it carries the same structure obligation as
any other source change. Structure owners per lane: L1 `structure/runtime.md`;
L2 `structure/catalog.md` and `structure/adapters/registry.md`; L3
`structure/runtime.md` and `structure/providers/cursor.md`; L4 the owner of
`src/cli/`. Each lane resolves its owner from `structure/INDEX.md` at its own P and
updates the doc in the same PR, because `bun run structure:check` fails on a doc
that no longer matches the tree.

## Worker policy

Two surfaces, each doing what it is for. A **lane** needs its own branch, its own
CI and its own merge, so every lane is a `create_thread` task with
`environment: worktree`. A **worker inside a lane** is a bounded slice of that
lane's own tree, so it is a subagent, spawned by the lane thread into the lane's
worktree. Subagents belonging to different lanes cannot collide because the
worktrees differ.

Four lane threads: `anthropic/claude-opus-5` on L1 and L3, `kimi/k3[1m]` at high
effort on L2 and L4. Each lane loads `$codexclaw:cxc-loop` and runs its own scoped
PABCD cycle with its own goal and FSM, because a thread owns both.

Inside a lane, workers are `devin/swe-2` and `xai/grok-4.6` subagents at roughly
2:3, with no cap on count. Both ids are accepted by `spawn_agent` even though
`devin/swe-2` is absent from the advertised override list in the tool description;
that omission was verified as a documentation gap on 2026-09-14, not a real
restriction. Only one subagent writes at a time, and no subagent runs a
branch-level git operation.

## Proof policy

No local product suite, typecheck, build or install. Every PR body labels them
NOT RUN. The only proof is hosted Cross-platform CI at the exact head SHA,
dispatched explicitly with `gh workflow run ci.yml --ref <branch> -F lane=all`,
because a sync or rebase does not reliably queue it. Non-tip chain commits carry
`[skip ci]`. Pushes are `--no-verify` and fast-forward only; no shared branch is
force-pushed. Each round closes with one post-merge `dev` run as the joint proof
for that batch.

## Work-phase map

| Phase | Outcome | Depends on |
|---|---|---|
| wp1 | This roadmap, at diff level, before any lane dispatch | — |
| wp2 | Round 1: lanes created, bottom-layer PRs, merge-track approvals, batch merge, post-merge dev CI | wp1 |
| wp3 | Round 2: top-layer PRs, retarget after parents land, batch merge, post-merge dev CI | wp2 |
| wp4 | Closure sweep: resolved issues closed with merge references, superseded PRs and issues closed with written reasons | wp3 |

Phase documents: `010_wp2_round1.md`, `020_wp3_round2.md`, `030_wp4_closure.md`.

## Out of scope

#4022, #4259, #2562, #3283, #3742, #3738, #4020 and #4299; any account-pool
redesign; any Lab import into `src/router.ts`, `src/server/lifecycle.ts` or
`src/server/responses/core.ts`; security write-ups in any tracked directory
(scratch only, per AGENTS.md); rewriting another maintainer's branch; and the
uncommitted `src/codex/inject.ts` and `src/codex/sync.ts` changes observed in the
parent checkout, whose author was never identified.

## Terminal outcomes

DONE needs 9 or more PRs merged, each with a CI run id at its merged SHA or an
explicitly recorded decision to merge without observing CI, both rounds closed with
a post-merge `dev` run, the named issues closed with merge references, and the
superseded set closed with written reasons. NEEDS_HUMAN is reserved for the
security review on #4519 and #4528. A heartbeat firing, a wait timeout or a
compaction is none of these.
