# 080 — Final gate: independent audit of the landed fix

Reviewed tree: `7747bf74f`, checked out detached and clean, which at the time was `origin/dev`.
The fix path and this unit are byte-identical at later heads, so the audit still describes them.

## Why a separate gate, after eleven rounds

Rounds 1 through 11 in `070` audited the change while it was being built, against a plan the same
session wrote. This gate asks a narrower question that those rounds structurally could not: does the
landed code on `dev` hold up to someone who did not build it, and is every claim in the written record
true against git rather than against memory.

The reviewer was given the three deliberately scoped-out items up front — the inert
`envelope_exhausted` propagation, the extreme-byte-axis note ordering, and `composer-2.5`'s hybrid
root count — precisely so it could not bill known accepted tradeoffs as new findings, and was told a
PASS was an acceptable outcome so it had no incentive to manufacture one.

## Verdict: pass, no findings

### The invariant is not the one the plan named

The most useful thing the gate produced is a correction to how this fix should be described. It does
not emit a separate assistant `[Tool Call]` root before the result. It names the invocation *inside*
the result envelope, as an `invoked: <tool> with <args>` line
(`src/adapters/cursor/protobuf-request.ts`). That is deliberate: a standalone `[Tool Call]` marker
gets few-shot-mimicked by the model and breaks multi-tool continuations, which is what the remote
suite's 363-B guard caught when this unit first tried that shape.

So the invariant worth testing is "no replayed result root lacks its invocation line", not "a call
root precedes the result". The goalplan's own criterion wording carries the older framing.

### Coverage, measured rather than asserted

Six mutations, each reddening on-point tests against a 166 pass / 0 fail baseline on four cursor
suites:

| Mutation | Red |
|---|---|
| Orphan-strip skip reverted | 3 — suffix-growth and byte-pressure rows |
| Guard skipped unconditionally | 1 — the full-replay orphan row |
| `callBefore` positional bound dropped | 2 — both history-position rows |
| `knownCallsOffset` dropped from the root bound | 3 — including the pre-cut call naming row |
| `carriedRoots.count` removed from `historyLimit` | 10 |
| Turn-granular admission restored for suffixes | 1 — incremental pruning |

The round 11 note threshold reproduces in both directions: relaxing `>= 1` to `>= 0` reddens 4,
tightening to `>= 2` reddens 1. A suite that can tell a correct bound from an unnecessarily strict one
is the strongest single piece of evidence in this unit, and it is what rounds 5 through 10 lacked.

### Sweeps

96 shapes across pair counts, full replay and two checkpoint cuts, bare-call and narrated histories,
result sizes to 64 KiB: 503 result roots, none missing an invocation line. A wider 576-configuration
sweep over parallel batches, system-prompt counts, carried roots, tail kinds and note arming reported
no throws, no count overrun, no orphan cases and no lost newest result. 55 invocation pairings across
checkpoint cuts produced no mislabel, so no result was ever named with a later command.

### The checkpoint skip does not rest on trusting the checkpoint

Three hostile shapes attacked the `knownCallsOffset > 0` premise: a covered prefix with no user turn,
`suffixStart = 1` where message 0 is an assistant, and a cut falling between a call and its result.
All three kept the invocation line and produced no orphan, because the line is keyed by call id over
full history. The positional bound and the orphan-strip skip are independent mechanisms, which is why
the skip cannot resurrect the original looping symptom.

### Claims checked against git

`62df78d8d` is #2940's squash commit and an ancestor of the reviewed head; `0340d1759` is that PR's
recorded head with all-success CI; `git diff` between them on the fix path is empty, which is what
makes "the landed tree is verified, not only the pre-merge head" a fair statement rather than a
flourish. The 213 / 127 test counts reproduce exactly. `bun run typecheck` is clean.

## One behaviour named, not counted as a defect

When two calls share a decoded call id, `toolCallsByCallId` drops the id as ambiguous and both results
replay with no invocation line — the pre-fix orphan shape, for that narrow case. The code argues the
tradeoff explicitly: a wrong invocation is undetectable by the model, a missing one is honest. Upstream
Codex call ids are unique. The gate agreed with the choice and recorded it rather than filing it.
