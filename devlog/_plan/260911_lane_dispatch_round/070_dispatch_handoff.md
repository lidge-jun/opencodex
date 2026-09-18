# Dispatch handoff

A thread is opened by the operator in the Codex app against the lane's worktree; an agent cannot
create one. Everything else is ready: the worktree exists on its branch, the packet is committed on
that branch, and the round is recorded in PR #4217.

Paste the matching block into a new thread whose working directory is the lane worktree.

## L1

```text
You are lane L1 of the 260911 dispatch round. Your worktree is
~/.codex/worktrees/260911-l1/opencodex, already on branch codex/260911-l1-responses-core, cut from origin/dev 6d3ad12e3.

Read devlog/_plan/260911_l1_responses_core/000_packet.md first and follow it exactly. It is your contract:
owned paths, the decisions already made for you, the rules, and the report format.

Run $codexclaw:cxc-loop as HOTL for your stack, in this order: #4172 then #4176.

Non-negotiable: never run the local product suite, typecheck, build, or install - report them as
NOT RUN. Prefix every mutating git command with `git -c core.hooksPath=/dev/null`. Push with
--no-verify. Use unlimited read-only xai/grok-4.6 subagents to reproduce, to read call sites, and to
review your own staged diff before you push; fold their findings in rather than arguing with them.
Stay inside your owned paths, even when a carried PR touches more. Do not merge - when your last PR
is green, report and stop.
```

## L2

```text
You are lane L2 of the 260911 dispatch round. Your worktree is
~/.codex/worktrees/260911-l2/opencodex, already on branch codex/260911-l2-catalog-provider, cut from origin/dev 6d3ad12e3.

Read devlog/_plan/260911_l2_catalog_provider/000_packet.md first and follow it exactly. It is your contract:
owned paths, the decisions already made for you, the rules, and the report format.

Run $codexclaw:cxc-loop as HOTL for your stack, in this order: #4201.

Non-negotiable: never run the local product suite, typecheck, build, or install - report them as
NOT RUN. Prefix every mutating git command with `git -c core.hooksPath=/dev/null`. Push with
--no-verify. Use unlimited read-only xai/grok-4.6 subagents to reproduce, to read call sites, and to
review your own staged diff before you push; fold their findings in rather than arguing with them.
Stay inside your owned paths, even when a carried PR touches more. Do not merge - when your last PR
is green, report and stop.
```

## L3

```text
You are lane L3 of the 260911 dispatch round. Your worktree is
~/.codex/worktrees/260911-l3/opencodex, already on branch codex/260911-l3-account-pool, cut from origin/dev 6d3ad12e3.

Read devlog/_plan/260911_l3_account_pool/000_packet.md first and follow it exactly. It is your contract:
owned paths, the decisions already made for you, the rules, and the report format.

Run $codexclaw:cxc-loop as HOTL for your stack, in this order: #4126 then #4212 then #4211.

Non-negotiable: never run the local product suite, typecheck, build, or install - report them as
NOT RUN. Prefix every mutating git command with `git -c core.hooksPath=/dev/null`. Push with
--no-verify. Use unlimited read-only xai/grok-4.6 subagents to reproduce, to read call sites, and to
review your own staged diff before you push; fold their findings in rather than arguing with them.
Stay inside your owned paths, even when a carried PR touches more. Do not merge - when your last PR
is green, report and stop.
```

## L4

```text
You are lane L4 of the 260911 dispatch round. Your worktree is
~/.codex/worktrees/260911-l4/opencodex, already on branch codex/260911-l4-service-cli, cut from origin/dev 6d3ad12e3.

Read devlog/_plan/260911_l4_service_cli/000_packet.md first and follow it exactly. It is your contract:
owned paths, the decisions already made for you, the rules, and the report format.

Run $codexclaw:cxc-loop as HOTL for your stack, in this order: #4202 then #4169 then #4204 then #4207.

Non-negotiable: never run the local product suite, typecheck, build, or install - report them as
NOT RUN. Prefix every mutating git command with `git -c core.hooksPath=/dev/null`. Push with
--no-verify. Use unlimited read-only xai/grok-4.6 subagents to reproduce, to read call sites, and to
review your own staged diff before you push; fold their findings in rather than arguing with them.
Stay inside your owned paths, even when a carried PR touches more. Do not merge - when your last PR
is green, report and stop.
```

## L5

```text
You are lane L5 of the 260911 dispatch round. Your worktree is
~/.codex/worktrees/260911-l5/opencodex, already on branch codex/260911-l5-integrations-io, cut from origin/dev 6d3ad12e3.

Read devlog/_plan/260911_l5_integrations_io/000_packet.md first and follow it exactly. It is your contract:
owned paths, the decisions already made for you, the rules, and the report format.

Run $codexclaw:cxc-loop as HOTL for your stack, in this order: #4197 then #4214.

Non-negotiable: never run the local product suite, typecheck, build, or install - report them as
NOT RUN. Prefix every mutating git command with `git -c core.hooksPath=/dev/null`. Push with
--no-verify. Use unlimited read-only xai/grok-4.6 subagents to reproduce, to read call sites, and to
review your own staged diff before you push; fold their findings in rather than arguing with them.
Stay inside your owned paths, even when a carried PR touches more. Do not merge - when your last PR
is green, report and stop.
```

## L6

```text
You are lane L6 of the 260911 dispatch round. Your worktree is
~/.codex/worktrees/260911-l6/opencodex, already on branch codex/260911-l6-streaming-tools, cut from origin/dev 6d3ad12e3.

Read devlog/_plan/260911_l6_streaming_tools/000_packet.md first and follow it exactly. It is your contract:
owned paths, the decisions already made for you, the rules, and the report format.

Run $codexclaw:cxc-loop as HOTL for your stack, in this order: #4191 then #4190.

Non-negotiable: never run the local product suite, typecheck, build, or install - report them as
NOT RUN. Prefix every mutating git command with `git -c core.hooksPath=/dev/null`. Push with
--no-verify. Use unlimited read-only xai/grok-4.6 subagents to reproduce, to read call sites, and to
review your own staged diff before you push; fold their findings in rather than arguing with them.
Stay inside your owned paths, even when a carried PR touches more. Do not merge - when your last PR
is green, report and stop.
```

## L7

```text
You are lane L7 of the 260911 dispatch round. Your worktree is
~/.codex/worktrees/260911-l7/opencodex, already on branch codex/260911-l7-docs, cut from origin/dev 6d3ad12e3.

Read devlog/_plan/260911_l7_docs/000_packet.md first and follow it exactly. It is your contract:
owned paths, the decisions already made for you, the rules, and the report format.

Run $codexclaw:cxc-loop as HOTL for your stack, in this order: #4215 then #4200.

Non-negotiable: never run the local product suite, typecheck, build, or install - report them as
NOT RUN. Prefix every mutating git command with `git -c core.hooksPath=/dev/null`. Push with
--no-verify. Use unlimited read-only xai/grok-4.6 subagents to reproduce, to read call sites, and to
review your own staged diff before you push; fold their findings in rather than arguing with them.
Stay inside your owned paths, even when a carried PR touches more. Do not merge - when your last PR
is green, report and stop.
```

## What the orchestrator does with the returns

Nothing lands on a lane's authority. The orchestrator refreshes each lane's PR head, run id, and
review state from `gh`, resolves the append-only conflicts in the two test-layout maps, and merges
one lane at a time, each only when hosted CI is green on that exact head, with fetched `origin/dev`
ancestry as the landing proof.

