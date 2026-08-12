# 030 — Merge the stack bottom-up, then close what it resolved

## Renumbering

Layer 1 (#951) merged as `af3ddedb4`, and this unit adds a seventh layer. Titles
currently read `stack N/6` and become `stack N/7`. The merged layer keeps its
historical title — retitling a merged PR rewrites a record nobody can act on.

| Layer | PR | Branch | Base while stacked |
|---|---|---|---|
| 1/7 | #951 | `codex/bug-stack-plan` | merged `af3ddedb4` |
| 2/7 | #952 | `codex/908-long-context-pricing` | `dev` after #951 landed |
| 3/7 | #953 | `codex/carry-contributor-bugfixes` | #952 |
| 4/7 | #954 | `codex/545-classifier-thinking-disabled` | #953 |
| 5/7 | #955 | `codex/915-cooldown-recovery-probe` | #954 |
| 6/7 | #973 | `codex/stack6-overnight-triage` | #955 |
| 7/7 | new | `codex/stack7-service-vision` | #973 |

Navigation comments on every open layer get refreshed to the seven-row chain with
layer 1 marked merged.

## Merge order and the gate at each step

Strictly bottom-up. A layer merges only after its parent has landed, because
every layer's diff is expressed against its parent's tree.

For each layer, in order:

1. Confirm the child's base branch is the just-merged parent, then retarget it to
   `dev` (`gh pr edit <n> --base dev`). GitHub does this automatically when the
   parent merges, but it is verified rather than assumed.
2. **Force a fresh CI run against the new base** (audit B5). Retargeting alone
   does not produce one: `.github/workflows/ci.yml` uses the default
   `pull_request` activity types (`opened`/`synchronize`/`reopened`), and a base
   edit emits `edited`. So `gh pr checks` can report green checks bound to the
   same head sha that never ran against the new merge base — materially wrong
   here, because `dev` is well ahead of the stacked heads. Merge current `dev`
   into the child to trigger `synchronize`.
3. Verify the run's **base** matches the retargeted PR, not merely that the head
   sha matches. Sha identity does not imply base identity, and a remembered green
   is not evidence at all.
4. Merge.
5. Record the merge commit for the issue-closure step below.

### The #954 gate

Layer 4 (#545, keeping an explicit thinking disable through translation) touches
request translation for a security-relevant control. `MAINTAINERS.md` reserves
that class for human security review. If that review has not happened when the
queue reaches #954, the honest outcome is: merge #952 and #953, stop, state the
gate, and leave #954–#973 stacked. Layers above it cannot be merged out of order
to route around the gate — their diffs assume #954's tree.

That is a `NEEDS_HUMAN` terminal outcome for the merge work-phase, not a failure,
and not a reason to shrink the goal.

## Issue closure

An issue closes when the layer that fixes it is **merged into `dev`**, with a
comment naming the merge commit. Closing on "the PR exists" is what makes issue
trackers untrustworthy.

| Issue | Fixed by | Layer |
|---|---|---|
| #908 | long-context pricing tiers | #952 |
| #545 | explicit thinking disable through translation | #954 |
| #915 | cooldown early-recovery probe | #955 |
| #962 | custom rows inherit provider metadata (carried #965) | #973 |
| #956 | NIM vision classification | stack 7 |

**#956 closes with a bounded scope statement.** `010` fixes the classification
for verified ids and explicitly leaves unknown/future NIM models unchanged. The
closing comment must say so rather than implying a complete fix — otherwise the
issue reads as resolved for a model NVIDIA ships next month, which it is not.
| issues fixed by the six carried contributor fixes | — | #953 |

The #953 row is deliberately unresolved here: the six carried fixes
(#939, #942, #943, #944, #945, #948) must be re-read at closure time to map each
to the issue it actually resolves. Several were PR-only with no filed issue.

### Contributor PRs to close as superseded

#964 and #970 close once stack 7 is open **and green** — not the moment it opens.

The first draft of this document said "when stack 7 opens", mirroring the six
carried PRs closed earlier in this session. That parallel does not hold and the
earlier text was wrong. Those six were closed with equivalent replacement commits
already on a branch and patch-id verified; here the replacement does not exist
yet, and its first design failed the audit gate outright
(`001_audit_response.md`). Closing a contributor's live path while ours is
unproven trades a working proposal for a plan.

Each closing comment must name the superseding commits, state plainly what
changed relative to the contributor's version, and say that reopening is one
click.

For #964 the comment owes the author a specific correction: five ids in the
submitted list are natively image-capable, and the reasoning is in `010`. The
contributor found a real bug and the list shape is what failed, not the finding —
and my own first replacement for that shape failed too, which belongs in the
comment as well.

For #970 the comment should credit the part the PR got right (the `/create`
elevation diagnosis) and name the two things the reconstruction adds: the
narrowed Windows GUI skip, without which the reporter's own surface stays broken,
and the diagnostic-based install fallback.

## Left open deliberately

#961 (enhancement, provider headers), #966 (two falsifications survive), #969
(CI governance policy), #922, #928, #935, #936, #940, #557 — each already carries
a stated reason on the PR. Nothing in this unit changes them.

#907 stays blocked on `lidge-jun/jawcode`: the canonical `models.json` lives in
another repository across four provider bundles, and the local fix cannot land
without it. The coupling trap is recorded on the issue — correcting the Terra and
Luna base prices without recomputing `PRIORITY_MULTIPLIERS`
(`src/usage/expected-prices.ts:152-156`) trades an overcharge for an undercharge
and no test fails.
