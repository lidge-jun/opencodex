# 030 — Round 1 dispatch record

Five worktree Codex threads were created for round 1, one per lane, each with its
own checkout and branch. Each was told to run cxc-loop itself, to delegate
implementation to devin/swe-2 and xai/grok-4.6 subagents at roughly a 2:3 ratio,
to run no local suite, to push with --no-verify, and to open one pull request
against dev without merging it.

| Lane | Orchestrator | Branch | Issues |
|---|---|---|---|
| R1-L1 catalog normalization | anthropic/claude-opus-5 | codex/260914-l1-catalog-normalization | #4570, #4505 |
| R1-L2 pool routing and prompt cache | kimi/k3[1m] | codex/260914-l2-pool-routing-cache | #4546, #4550 |
| R1-L3 cursor policy and errors | anthropic/claude-opus-5 | codex/260914-l3-cursor-policy-errors | #4508, #4542 |
| R1-L4 responses terminal and media | anthropic/claude-opus-5 | codex/260914-l4-responses-media | #4469, #4311, #4312, #4532 |
| R1-L5 provider account edges | kimi/k3[1m] | codex/260914-l5-provider-account-edges | #4503, #3781 |

## Contributor merge queue, batch 1

The review pass found the thing that had actually been blocking this queue.
Every fork pull request in it was sitting with Cross-platform CI and React Doctor
in `action_required` — the fork-workflow approval gate — so the suite had never
run at those heads. The green checks visible on each pull request were the
hygiene, labeler and target gates only. Nine runs were approved at the exact
current head:

| PR | Head | Approved run |
|---|---|---|
| #4565 | 449a692f4 | 34794874697 |
| #4452 | 4b213ef2b | 34796097782 |
| #4451 | daf735d67 | 34794900986 |
| #4383 | 713fbe66e | 34794898049 |
| #4139 | 2a8ca25cb | 34794890662 |
| #4517 | 3a45afe6a | 34795340237 |
| #4298 | cdbac2727 | 34778679348 |
| #4071 | 78a9e097b | 34774091261 |
| #4033 | 84b197e76 | 34745744790 |

#4309 is held out: it is 288 commits behind dev, and its provider-count
assertions cannot be trusted until it is rebased.

Two reviewer subagents read the diffs first. All five of batch 1's luvs01 pull
requests came back MERGE with specific justification; the other four came back
HOLD for exactly one reason each, the missing exact-head suite run, which is what
the approvals above address.
