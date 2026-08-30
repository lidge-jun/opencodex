# 060 — Phase 7: bound the invocation lookup by position

Depends on: `11d33597f` (#2910), `cfb70c972` (#2913), `6906049c6` (#2919) on `origin/dev`.
Supersedes the implementation intent of `050`; that unit's own defect is now the smaller half of this
one.

## Why this replaces 050

`050` set out to name the invocation on a native turn-branch fallback. Two independent audit rounds
failed it (r2 and r3), and the second one found something that outranks the thing `050` was trying to
fix: **the mislabel is already on the wire, in code merged today.**

Measured on the tracked tree with **no patch applied** — a result whose own output is `EARLY-OUT`,
labelled as having been produced by a command that runs later in history:

```text
grok-4.6-high => invoked: exec_command with {"cmd":"echo LATER"}   | output=EARLY-OUT
composer-2.5  => invoked: exec_command with {"cmd":"echo LATER"}   | output=EARLY-OUT
```

This is the failure mode `toolCallsByCallId`'s own doc comment calls unacceptable: "an early result
could be labelled with a later command — a wrong invocation is worse than none, since it is the kind
of mislabel the model cannot detect." The index implements the *ambiguity* half of that comment and
not the *ordering* half.

So the priority inverts. A missing invocation line on a native turn step is a cosmetic gap; a **wrong**
invocation line on the shipped external root path is the defect this unit exists to prevent, and I
introduced it in #2900.

## Root cause

`toolCallsByCallId` carries no position. It keeps the first call for an id and drops ids claimed by
two different invocations, but nothing constrains *where* the winning call sits relative to the result
being labelled. The comment's parenthetical — "results follow their call, so the first binding is the
one an earlier result belongs to" — is an assumption about history order, not something the code
checks.

`050`'s draft claimed the root path escaped this via `activeUserIndex`. That is false, and audit r3
disproved it: `activeUserIndex` is `-1` whenever the last raw message is a `toolResult`, and otherwise
it bounds the loop end, never the call index. I re-measured it above on the shipped tree.

## Reachability, stated honestly

This needs a history where a result's id is first claimed by a *later* call. It is not the common
shape: Codex normally replays a full thread in which the call precedes its result.

My first draft framed the precondition as id reuse. Audit r4 corrected that — **the actual
precondition is only "a result precedes its call in serialized order"**, and it is reachable without
any id reuse at all: a result serialized before the assistant message declaring its call was measured
being labelled from that later message, with two distinct ids. Routes:

- a result emitted before its own call in the serialized order — no reuse required;
- an id reused by a retry after the original call has left the replayed window.

It also does not need a contrived trailing shape. On the ordinary trailing-`toolResult` continuation —
the single most common shape this proxy sees — `activeUserIndex` is `-1` and the loop walks the entire
history, so nothing bounds the lookup at all.

I have **not** produced this from a live `codex exec` run, and I am not claiming a live repro. What is
demonstrated is that the encoder produces a confidently wrong label when given the shape, on the path
that ships today. Given that a mislabel is undetectable downstream by design, that is worth closing on
its own terms rather than waiting for a user to hit it.

## The change

Give the index position, and require the call to precede the result.

`toolCallsByCallId` gains a companion that records the message index of each first binding. Both
emission sites already know the result's index — the root loop has `i` (it already passes
`messageIndex: i` into `pushDeduped`), and the turn loop can carry it. A call at an index **not less
than** the result's index yields no invocation line: the same honest degradation the ambiguity path
already takes.

### The coordinate-system trap

Both audits converged on this and it is the reason a naive bound is worse than none. `040` threads a
**full-history** index into a **sliced** replay: the checkpoint path builds
`toolCallsByCallId(request.rawMessages)` and hands it to builders that iterate
`rawMessages.slice(suffixStart)`. A full-history call index compared against a slice-local result
index compares two different origins:

| `suffixStart = 4`, call at full index 1, result at full index 4 | comparison | outcome |
|---|---|---|
| correct | `1 < 4` | accept |
| naive (full vs slice-local) | `1 < 0` | **reject** |

Audit r3 measured both directions of this on a patched tree: it rejects valid pairings *and* can
accept for the wrong reason. Rejecting silently re-creates, on the checkpoint path, the exact orphan
#2910 was merged to fix.

The bound therefore compares in one coordinate system. Two options looked available:

1. build the index over the **same array the loop walks**;
2. keep the **full-history** index and have the loop convert its local index to full space before
   comparing.

**Option 1 is self-contradictory and this plan initially chose it.** The checkpoint site threads a
full-history index *precisely because the call can sit outside the slice* — that is what #2910 fixed.
Rebuilding the index over the slice removes that call from the index altogether, so the invocation is
lost for exactly the shape phase 5 closed. Worked through with `suffixStart = 2`, the call at full
index 1 and the result at full index 3:

| option | call in index? | comparison | outcome |
|--------|----------------|------------|---------|
| 1 — rebuild over slice | **no** | n/a | invocation LOST, re-breaks #2910 |
| 2 — full index + offset | yes | `1 < 2 + 1 = 3` | named, and ordering enforced |

So the design is **option 2**: the index stays full-history, and each emission site converts the
position it walks into full-history space before comparing. The root path already has the full-history
`i` when it is not slicing; the checkpoint path must add its `suffixStart`, which means that offset has
to be passed to the builders alongside `knownCalls` rather than inferred.

That is one more parameter than option 1 would have needed, and it is the price of not re-breaking the
previous phase. Recording the wrong first choice because "no offset to thread" is exactly the kind of
simplicity argument that produced the last three partial fixes.

### The three origins ADD — write the expression, not the parts

There are three offsets in play, and the comparison position is their **sum**:

```text
resultFullIndex = knownCallsOffset + start + w

  knownCallsOffset : checkpointSuffixStart, or 0 on full replay
  start            : historyMessageStart in conversationTurns, or 0
  w                : the loop's own position within the array it walks
```

Audit r5 implemented this plan and then mutation-tested the two readings the earlier prose permitted.
Both typecheck cleanly and passed all 274 cursor tests **plus the five rows the table below had at the
time**. Row 6 exists because of this measurement, so it is the one row they do not pass — see the note
under the table.

| variant | 274 cursor tests | live behaviour |
|---------|------------------|----------------|
| `start + w` (drops `knownCallsOffset`) | 273 pass, 1 fail | caught |
| `knownCallsOffset + w` (drops `start`) | **274 pass** | **live orphan** |
| `knownCallsOffset > 0 ? offset + w : start + w` | **274 pass** | **live orphan** |

The shape that exposes the two survivors is checkpoint **and** root pruning together:
`suffixStart = 1` with a large turn inside the suffix forcing `historyMessageStart = 3`. Correct
arithmetic names the call; both survivors emit no invocation line — re-creating on the checkpoint path
the exact orphan #2910 fixed, which is the failure this document spends its longest section warning
about.

So the expression is normative. An implementer who derives only one term ships something that looks
green from every angle this plan would otherwise check.

**Storage mechanism, so review does not relitigate it:** `toolCallsByCallId` returns a bare `Map`, so
positions go in a side table keyed by the returned map — a `WeakMap<Map, Map<string, number>>` — rather
than changing the return type and every caller. There are four `toolCallsByCallId(` invocations
(`rg -c` on the file) across two builders and the checkpoint site. Audit r6 built the side table exactly
as specified and confirmed the return type and all existing call sites stay unchanged, with positions
recorded on first binding and deleted alongside the ambiguity drop.

**Loop rewrite caution:** converting `conversationTurns`' `for…of` to an indexed loop should keep an
`if (!message) continue;` guard, matching the existing root loop. Audit r6 corrected my stated reason:
`noUncheckedIndexedAccess` is **not** enabled in this repo, so `walked[w]` types as `OcxMessage` and no
narrowing is lost — removing the guard still typechecks. Confirmed: `grep -c noUncheckedIndexedAccess
tsconfig.json` returns 0. So the guard is a runtime-consistency choice, not a strictness requirement,
and an implementer who tests the original justification would find it did not hold.

## Tests

**Exactly one row is red without the fix.** Saying "every row must fail first" would be the same
overclaim `040` was audited for twice: the accept-side rows exist to stop the bound from becoming a
blanket refusal, and a guard that is green before *and* after is doing its job. What matters is that no
row is **vacuous** — every row must be red under at least one wrong implementation.

| Test | Unpatched | Red under |
|------|-----------|-----------|
| a result whose id's call appears LATER in history gets NO invocation line | **red** — names `echo LATER` today | the defect itself |
| the same history with the call EARLIER still names it | green | a bound that refuses everything |
| on the checkpoint ROOT path, a call before `suffixStart` is still named | green | `same-array`, `naive` |
| on the checkpoint TURN path, the same call is still named | green | `same-array`, `naive` |
| an id ambiguous in FULL history but not in the suffix yields no line | green | `same-array` |
| on the checkpoint TURN path with root pruning too (`suffixStart` > 0 **and** `historyMessageStart` > 0) the call is still named | green | `knownCallsOffset + w`, `start + w`, ternary |

Row 5 is the one audit r4 said was missing, and it is the most important guard in the table. The
plain "an ambiguous id yields no line" row I originally listed does **not** catch suffix-narrowing —
measured green under `same-array` — because the ambiguity is visible in the slice too. The guard has to
construct ambiguity that full history sees and the suffix does not. That test already exists in the
tree as `an ambiguous id resolved from full history is not re-resolved from the suffix`, added in
#2919, so this phase must keep it green rather than write a new one.

Rows 3 and 4 are split because audit r4 showed the single row as worded was satisfiable by the root
path alone, which would let a turn-path regression through.

Row 6 is the one audit r5 proved was missing, and it must assert against the **turn** path. Audit r6
built it both ways on identical history and only the turn form discriminates:

| row 6 asserts against | correct | `knownCallsOffset + w` | ternary | `start + w` |
|---|---|---|---|---|
| turn path | pass | **fail** | **fail** | **fail** |
| root path | pass | pass | pass | fail |

The reason is structural, not fixture luck. `historyMessageStart` is an *output* of
`rootPromptMessages`, assigned only after its loop finishes, while that loop walks full-history `i` from
zero — so the root path's expression reduces to `knownCallsOffset + 0 + i` and `knownCallsOffset + w` is
*identical* to the correct one there. No root-path test can ever separate them. Only
`conversationTurns` carries `start = historyMessageStart` into its slice.

This is the same defect rows 3 and 4 were split to avoid, in the one row that must not have it: a
table that cannot distinguish a correct derivation from a plausible wrong one is the shape of every
earlier failure in this unit. Row 6 is also the only row whose preconditions must be checked rather
than assumed — r6 instrumented it and confirmed `offset=1 start=1 w=2`, both offsets genuinely
non-zero, so the row exercises the composition instead of being incidentally satisfied.

### Measured across implementations

Audit r4 implemented every coordinate option behind one knob and ran identical tests:

Test counts below differ by **file scope**, not because the suite grew — r4 measured the three files
this unit touches (124 tests: `cursor-tool-result-invocation` 19, `cursor-tool-continuation` 12,
`cursor-blob` 93), r5 and r6 widened to seven and nine cursor files respectively. The three-file figure
is the one this phase gates on, and it is reproducible with
`bun test tests/cursor-tool-result-invocation.test.ts tests/cursor-tool-continuation.test.ts tests/cursor-blob.test.ts`.

| implementation | new rows | three-file cursor suite |
|----------------|----------|-------------------------|
| shipped (no bound) | row 1 red | 124 pass |
| `same-array` (this plan's first choice) | row 3/4 red | **121 pass, 3 fail** |
| `naive` (condemned by r2/r3) | row 3/4 red | 122 pass, 2 fail |
| **`offset`** (the design above) | **all green** | **124 pass** |

`same-array` is worse than the option two earlier audits already rejected: besides losing the
out-of-slice call, it narrows the ambiguity evidence and emits `invoked: … echo SECOND` for a result
whose output is `FIRST` — a fresh instance of the wrong-label defect, on the checkpoint path.

### A third coordinate origin

`conversationTurns` iterates `messages.slice(start, historyEnd)` with a `for…of` over **values**, so it
has no index at all today, and `start` is `historyMessageStart` — non-zero on the full-replay path after
root pruning. The loop-local position is therefore `start + w`, not `w`. Audit r4 confirmed this third
origin produces no mislabel on its own, so it is an implementation trap rather than a live defect, but
an implementer who reads only the `suffixStart` discussion above will walk straight into it.

## Scope

The bound lives in the shared lookup, so it covers every consumer at once — the external root path
(where the mislabel is live), the external turn path, and the checkpoint variants of both.

The native turn-branch fallback from `050` is **not** included. Audit r3 showed the affected id set is
48 wire ids rather than the four `050` listed, that the paired `mcpToolCall` step already describes the
same call so the envelope is not as orphaned as `050` claimed, and that a raw-vs-decoded id keying
asymmetry between `pendingToolCalls` and the index is unaccounted for. That is a separate phase with
its own measurements, not a rider on a correctness fix.

## Verification

### Implementation notes: row 6 took five fixtures to make discriminate

The plan predicted row 6 would catch a dropped `start` term. Getting a fixture that actually does took
five attempts, and the failures are worth recording because each one looked correct:

| attempt | why it did not discriminate |
|---------|------------------------------|
| `suffixStart = 1`, 400 KiB filler | cut left the call INSIDE the slice, so no covered call was exercised |
| `suffixStart = 2`, 400 KiB filler | 400 KiB is under the 512 KiB root budget, so nothing pruned and `start` stayed 0 |
| `suffixStart = 2`, 600 KiB filler | call was in the COVERED region, where its position is below the offset and the under-count cannot cross it |
| call adjacent to result, 600 KiB | correct shape, but the assertion pooled roots **and** turn steps |
| same, asserting the TURN step only | **discriminates** |

The fourth is the instructive one. Pooling both sources hid the mutation exactly as the plan's own
analysis said it would: the root path has no `start` term to drop, so it keeps naming the call and an
either-source assertion stays green. Instrumenting the loop gave `offset=1 start=1 w=2`, so under the
mutation the result's computed position was 3 while its call sits at 3 — `3 >= 3` rejects, the turn step
loses its invocation line, and the root step still has one.

The condition was derived rather than guessed after the third failure: dropping `start` under-counts a
walked message by exactly `start`, so it flips the decision only when the call is inside the slice and
`w_result - w_call <= start`.

- Focused `bun test` on the cursor files; row 1 driven red first, and each guard row driven red against
  the wrong implementation it exists to catch.
- `bun x tsc --noEmit`.
- `bun run privacy:scan` — the declared CI gate in `AGENTS.md`, omitted from the first draft of this list.
- Full suite on `ssh lidge`; no local full-suite run as a gate.
