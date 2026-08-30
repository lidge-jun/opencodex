# wp6 — the orphan-strip loop eats the whole checkpoint suffix

Status: plan. Work-phase wp6, criterion `c-2`. Predecessors: `050` (superseded), `060` (merged as
#2936 / `d882caed5`).

## Symptom the user reported

Cursor models "무한 출력" and "툴 출력을 못받고" — the turn never terminates and the model behaves as if it
never saw its tool output.

Reproduced on merged `dev` `d882caed5`, isolated proxy, `cursor/grok-4.6`, three sequential `echo`
commands requested one at a time. Counts are from the COMPLETED artifacts, recounted after audit r8
found the first table had been read from a file that was still being written:

| observed | `live3b.jsonl` | `live3.jsonl` |
|---|---|---|
| distinct commands requested | 3 | 3 |
| `command_execution` items emitted | 21 | 133 |
| STEP1 runs | 10 | 64 |
| STEP2 runs | 10 | 67 |
| STEP3 runs | 1 | 2 |
| "interrupted" mentions | 8 | 134 |
| terminal answer | reached, after 21 executions | reached, after 133 |

The turn does eventually terminate. The defect is that it burns 21 to 133 tool executions to run three
commands, repeatedly re-running work that already succeeded. The earlier claim that it never terminates
was an artifact of counting a file mid-run and is withdrawn.

The narration alternates verbatim: "STEP1 already ran. Next is STEP2." then "STEP1 was interrupted last
time, so I'll run it now." The model contradicts itself every other turn, which is the signature of a
prompt whose history changes shape between turns rather than of a confused model.

## Root cause

`rootPromptMessages` ends its external-model pruning with an orphan guard:

```ts
const historyEntries = [...keptPrior, ...active];
// Guard against orphan assistant / toolResult at the start of the retained suffix.
while (historyEntries[0]?.role === "assistant" || historyEntries[0]?.role === "toolResult") {
  if (historyEntries.length <= active.length) break;
  historyEntries.shift();
}
```

On a **full replay** the premise holds: history starts at the real conversation start, so a leading
assistant or result entry means the user turn was pruned and the entry is genuinely orphaned.

On the **checkpoint path** the premise is false. `buildPreparedCursorRunRequest` replays only
`rawMessages.slice(suffixStart)`, and `suffixStart` is `coveredMessageCount` — the count of messages the
checkpoint already carries. A suffix therefore legitimately **begins** with the assistant message
whose initiating user turn sits inside the checkpoint. The loop reads that as an orphan and shifts it
off, then reads the next entry the same way, and keeps going until `historyEntries.length <= active.length`
stops it — that is, until nothing but the trailing active result block is left.

The `break` is what makes this total rather than partial: it fires only when the survivors are exactly
the active block, so every earlier pair is discarded no matter how many there are.

### Measured, with a checkpoint covering message 0 and N completed pairs in the suffix

| pairs in suffix | `rawMessages` | roots emitted | what the model sees |
|---|---|---|---|
| 1 | 3 | 2 | seed + result 1 |
| 2 | 5 | 2 | seed + result **2** only |
| 3 | 7 | 2 | seed + result **3** only |
| 4 | 9 | 2 | seed + result **4** only |

This table needs one qualifier audit r8 supplied: it holds for the shape a real agent produces, where
the assistant NARRATES before calling a tool. With a bare tool call and no assistant text there is no
strippable entry at the head of the suffix, `activeStart` walks back over the whole block, and the counts
grow normally (2, 3, 4, 5). The narration root is what arms the loop — which is why the defect looked
intermittent rather than universal.

The suffix grows and the payload does not. Live diagnostics agree: one checkpoint series measured
`rawMessages` 8, 10, 12, 14, 16, 18 across consecutive tool-continuation turns with `rootBlobs` pinned at
8 and `continuationMode: checkpoint` every time. (An earlier draft cited 9..19 against a pinned 5 and a
proxy port that no artifact contains; the property is real, those specific figures were not, and they are
corrected here rather than restated.)

That explains both halves of the report. The model cannot see the output of the command it just ran two
turns ago ("툴 출력을 못받고"), so it re-runs it; and because every turn presents the same collapsed shape,
it never accumulates enough state to finish ("무한 출력").

### Causation, not correlation

Gating the loop off behind a scratch environment variable, changing nothing else, turns the roots
column from 2, 2, 2, 2 into 3, 5, 7, 9. The scratch mutation was reverted; `git diff` is empty.

## Why the guard cannot simply be deleted

It is load-bearing on the full-replay path. `tests/cursor-blob.test.ts` covers the case it was written
for: byte pressure consumes the budget with one large active result, the user turn that asked for it is
pruned, and `conversationTurns()` then discards the result too for lack of a current turn — the wire
request degenerates to system roots plus a bare result marker. #1527.

The fix must keep that behaviour for full replay and stop applying it to a suffix whose initiating turn
is covered by the checkpoint.

## Change

`src/adapters/cursor/protobuf-request.ts`, `rootPromptMessages`:

1. The function already receives `knownCallsOffset` (added by #2936), which is `suffixStart` on the
   checkpoint path and `0` on full replay. A non-zero offset is exactly the "my history starts
   mid-conversation" signal the guard is missing. Introduce a named boolean from it —
   `suffixContinuesCoveredTurn` — rather than testing the arithmetic inline, because the two meanings
   (positional re-basing vs. provenance) must not silently merge again.
2. Skip the orphan-strip loop when that flag is set. A covered-turn suffix has no orphan to strip: its
   initiating turn exists, upstream, inside the checkpoint.
3. Leave the `#1527` initiator-recovery block below it unchanged. Its own comment already argues it
   needs no mode distinction, and `activeStart > 0` confines it to this call's own slice — so it stays
   correct for both paths and is not part of this defect.

Not in scope: the `suffixStart === 0` edge, where a checkpoint reports zero covered messages and the
suffix is the full history. The flag is false there, which is the correct answer — that request *is* a
full replay in every respect that matters to the guard.

## Verification

- Red first: the growth table above becomes a test that asserts roots grow with pairs. It must fail on
  `d882caed5` and pass after.
- The `#1527` full-replay assertions in `tests/cursor-blob.test.ts` must stay green untouched; they are
  the guard's reason to exist and the only proof this change is narrow.
- `a checkpoint suffix may legitimately begin with a tool result` must stay green — it is the existing
  expectation that most nearly overlaps this change.
- Live re-measurement of the exact repro above on an isolated proxy: three commands, one run each,
  zero interrupt narrations, terminal `ALLDONE`.
- `bun x tsc --noEmit` and `bun run privacy:scan`; full suite on `ssh lidge`, never locally.

## Audit r8 reopened the change: one mechanism was not enough

The first implementation fixed only the orphan-strip loop. An independent audit measured two further
paths to the same user-visible symptom, both confirmed here before anything was changed.

### The orphan fix is inert under byte pressure

Eight pairs of 64 KiB results still produced 2 roots, with and without the orphan fix. The `keptPrior`
loop above the guard admits **complete turns**, and a turn starts at a `user` root — which a checkpoint
suffix does not have, by definition. `turnStart` walks to 0, the whole prior block becomes one
all-or-nothing pseudo-turn, and the first budget overrun drops every entry. The orphan guard then has
nothing left to strip, so it never runs and the fix cannot help.

The remedy is to admit entries individually when the suffix continues a covered turn: without a turn
boundary to respect there is nothing for turn-granularity to protect, and keeping the most recent
history that fits beats keeping none. Measured 2 → 15 roots on that fixture.

This matters more than a partial loss would, because root replay is the **only** channel carrying suffix
history. `conversationTurns` walks from `historyMessageStart` and never meets a `user` message in a
suffix, so `current` is never created and every entry hits `if (!current) continue` — the suffix
contributes 0 turns both before and after this change. Verified directly rather than assumed.

### Restored growth collided with the cumulative envelope

Suffix pruning measured only its own slice, so it produced suffixes that were individually legal and
cumulatively fatal. Once replay actually grew, the downstream envelope guard began throwing
`CursorRootEnvelopeLimitError` — a non-retryable 400 — on conversations that previously degraded
silently: 50 pairs behind 100 checkpoint roots, 10 behind 180, 4 behind 190. Growth was also
non-monotonic, with 95 pairs giving 191 roots and 96 collapsing back to 2.

Two things were wrong and both are fixed. Pruning now subtracts the checkpoint's own roots and bytes, so
the suffix is measured against the room that actually remains. And when a checkpoint leaves no room at
all, the checkpoint is **abandoned** for a full replay under a new `envelope_exhausted` invalidation
reason rather than pruned to fit. Pruning to fit would emit the covered prefix and silently drop every
uncovered message — this unit's own defect, reintroduced at the top of the range — and throwing would
hand the caller a 400 it cannot retry. A full replay rebuilds a self-contained prompt and prunes it
coherently. After the change all three fixtures stay at 191 roots with no throw and no cliff.

### The abandon decision reads pruning's result, not a byte threshold

Two threshold attempts both left a live gap, which is why the predicate ended up where it is. Comparing
carried bytes against the raw limit left a few-hundred-byte band below it where the checkpoint was kept,
the suffix budget collapsed, and the newest tool result vanished — silently, where the old code at least
threw. Adding `systemBytes` moved the band instead of closing it, and the surviving positions were the
instructive ones: pruning kept the assistant narration and dropped the result, then kept the result
truncated so hard that only the truncation marker remained. Both leave the model looking at a call with no
answer, which is worse than keeping nothing.

So the condition is not predictive. Pruning runs first, and the checkpoint is abandoned when the message
the turn continues from did not survive it. Two earlier attempts at that predicate are worth recording
because each failed differently. Matching the result's own output text against the serialized root broke
on JSON escaping the moment real output contained a newline, which made every live continuation abandon
its checkpoint — correct output, checkpointing silently dead. Checking the surviving roots' roles could not
distinguish the result from the narration beside it. The predicate is now positional: `rootPromptMessages`
returns the source message index of every root that survived, plus the indexes whose output was elided
entirely by truncation, and the caller asks whether the last replayed message is in the first set and out
of the second.

That second set exists because "the result root survived" is not the same as "the result survived".
Truncation has two ways to leave a root that answers nothing: reduce it to the marker alone, or cut
mid-envelope before the `output:` line. Both were live in the band, and both now set `outputElided` at the
single place that produces them, so no threshold has to guess.

Swept across 15 positions from 100 KiB below the byte limit to 100 bytes above it, the newest result is
present at every one; before, five positions dropped it. Live turns still resume from their checkpoint
(`mode=checkpoint`, no invalidation reason) — the predicate costs nothing on ordinary conversations.

Scoped out explicitly rather than silently: the abandon branch sits inside the `suffixStart`-valid block,
so a plain resume turn with an oversized checkpoint still throws as it did before this unit. That path has
no suffix to lose and no measurement here, so widening it belongs to its own phase.

Two pre-existing tests asserted the throw. They now assert the bound instead: the assembled request stays
inside the envelope and the uncovered history is still present.

An earlier draft claimed those two rewrites were mutation-checked against the `carriedRoots` subtraction.
The re-audit measured otherwise and it was wrong: both exit through the abandon branch — the count case
uses unmeasurable checkpoint roots, the byte case a checkpoint large enough to trip abandonment — so
neither touched the subtraction. Deleting it reintroduced all three throws with the suite still 97/0
green. The subtraction now has its own case built to reach it: measurable checkpoint roots, a count three
below the limit so abandonment does not fire, and a suffix that only fits if pruning knows what the
checkpoint spends. Removing the subtraction now reddens three tests.

## Verification (as performed)

- Focused suite: `bun test tests/cursor-blob.test.ts tests/cursor-tool-result-invocation.test.ts
  tests/cursor-tool-continuation.test.ts` — 138 pass / 0 fail at the head of this unit (133 when this line
  was first written, before the later rounds added assertions).
- Every assertion driven red against the implementation it exists to catch, each mutation applied alone:
  restoring the unconditional orphan guard reddens the two suffix-growth rows; restoring turn-granular
  admission reddens the byte-pressure row; removing the `carriedRoots` subtraction reddens three rows;
  neutering the result-survival predicate reddens the byte-band row; skipping the orphan guard
  unconditionally reddens the full-replay orphan row.
- Live re-measurement on an isolated proxy built from the final tree, counted after the run exited
  (`/tmp/ocxv2.ojEUBe/v2.jsonl`): 3 commands, one execution each, 0 interrupt mentions, terminal
  `ALLDONE`. The run-request diagnostics from that same proxy's debug buffer report `rawMessages`/`rootBlobs`
  of 3/4, 5/6, 7/8, 9/10 across the four turns, with the last three in `checkpoint` mode and no
  invalidation reason — roots tracking history instead of pinned to a constant, and checkpointing intact.
  An earlier draft cited a series read from a snapshot log copied out of the operator's home, which could
  not be traced to the run it described.
- The operator's own proxy (port 10100, pid 62773, 2.35.0) was never touched; every probe ran against a
  scratch `OPENCODEX_HOME` on a scratch port.

## Audit round 3: the predicate had to learn which path it applies to

The positional predicate was correct for the path it was written against and wrong for two others. Both
were measured before being changed.

### Native models were losing their checkpoint on every continuation

`suffixKeptItsResult` asked whether the replayed result root survived pruning. A native resume model has
no such root: its result travels in server-side turn state, so `echoToolResultInRoot` is false and
`rootPromptMessages` skips it. The question answered "no" unconditionally, which meant the checkpoint was
discarded on **every** native tool continuation — including `cursor/auto`, the default id — regardless of
size or byte pressure.

That is not a cosmetic loss. `pendingToolCalls`, `readPaths` and `previousWorkspaceUris` exist only inside
the checkpoint, and a full replay does not rebuild them, so this unit's own defect had been relocated to
the native path. Measured through the real builder: `readPaths` went 2 → 0 for `auto`,
`composer-2.5-fast` and `composer-3`, while `composer-2.5` and `grok-4.6` were unaffected — exactly the
split `cursorNeedsExternalToolContinuation` draws. The predicate is now gated on it.

Worth stating plainly: this was introduced by the fix for the previous round's finding, not by the original
defect. Three rounds of audit each found one, which is the argument for the rounds rather than against
them.

### Parallel results were protected one at a time

The check read the last replayed index only. Parallel tool calls arrive as a run of results, and under byte
pressure the older ones were the ones being emptied — a prompt with three calls and one answer, which the
code's own comment calls worse than keeping nothing. `historyOutputElided` already recorded them; nothing
read them. The whole trailing run of results is checked now. Swept 628 (carried-bytes, payload-size)
positions: 10 partial-answer positions before, 0 after.

### The invalidation reason still reaches nothing, and that is now a recorded decision

`envelope_exhausted` is assigned to a local, so it lands in the debug diagnostic and stops there.
`src/adapters/cursor.ts` drops a dead checkpoint by reading `request.checkpointInvalidationReason`, so an
exhausted checkpoint is re-decoded and re-abandoned every turn until its TTL.

Round 3 asked for it to be propagated and the obvious fix — writing the field back onto the argument, which
is what `request-builder.ts` does — was implemented and then measured inert. `live-transport.ts` prepares a
**spread copy** of the request, so the write lands on the copy: the outer object the adapter reads stayed
`undefined`. A test asserting on the argument would have passed while proving nothing about the real path,
which is the same vacuous-coverage trap round 2 caught.

Reaching the store means threading the reason back through `PreparedCursorRunRequest`, a signature change
on the shared prepare path. That belongs to its own phase. The cost of leaving it is bounded and worth
stating: wasted work each turn, not wrong output — the request assembled is correct either way.

### Verification of this round

- `bun test` across `cursor-blob`, `cursor-tool-result-invocation`, `cursor-tool-continuation` and
  `cursor-request-builder`: 188 pass / 0 fail, and 102 / 0 in `cursor-blob` alone. An earlier draft said 187,
  which matched no commit in the stack — recounted after audit round 4 flagged it.
- Each new assertion driven red against the implementation it catches: removing the native gate reddens the
  native-checkpoint row; reading only the last index reddens the parallel row. The parallel fixture's
  375-byte offset was derived from the sweep rather than guessed — it is the one position where a
  last-index-only check leaves exactly one answer standing.
- Sweeps re-run clean after the change: 15/15 band positions deliver the newest result, 222 edge positions
  (multi-byte UTF-8, empty, whitespace-only, error, self-referential `output:` payload) with no loss, 628
  parallel positions with no partial answers and no throws.

## Audit round 4: the gate covered one disjunct out of three

The abandon condition is a three-way disjunction, and round 3 gated only the last term. The middle one —
"the suffix produced no history roots at all" — is about the same thing, a replayed root going missing, so
it was equally meaningless for a model whose results never become roots.

It fired whenever a native assistant turn was a **bare tool call with no narration**: no text root, no
result root, zero history roots, condition true, checkpoint discarded. Measured on the silent shape,
`readPaths` went 2 → 0 for `auto`, `composer-1`, `composer-2.5-fast` and `composer-3` while
`composer-2.5` and `grok-4.6` were unaffected — the same split, the same loss, one disjunct over. Both
survival terms are gated now; the count-full term stays ungated because it is a real envelope fact
independent of who echoes results.

### Why four rounds each found something

Every fix in this unit was correct for the path it was written against and silent about a sibling path in
the same condition. The fixture that let round 4's blocker through was round 3's own test: it asserted the
native path with narration, so the narration-free shape of the same path stayed invisible. The test is now
a cross product — four model ids by four assistant shapes (narrated, silent, empty text, whitespace text) —
because that is the axis the bugs kept hiding along, not because sixteen cases are inherently better than
four.

Two counts in this document were also wrong and are corrected: the four-suite total is 188, not 187, and
the three-suite figure is 138 at head rather than the 133 true when it was written.

## Audit round 5: the count budget was computed and never applied to the trailing run

`historyLimit` subtracts `carriedRoots.count`, and every prior round reasoned about that subtraction as if
it bounded the assembled payload. It did not. It was read by the prior-history `while` loop alone. The
trailing tool-result block was assembled before that loop under **byte** pressure only, and
`historyEntries` was then built as `[...keptPrior, ...active]` with no count check anywhere. When
`keptPrior` is empty — the ordinary checkpoint-continuation shape — `historyEntries.length` equals
`active.length`, bounded by nothing at all.

`truncateToolResultBlob` cannot save it: shrinking a result frees bytes, never a root slot.

The abandon condition was supposed to catch the overflow, and it tested
`carriedRoots.count + suffixSystemCount` — carried plus system, asking whether there is room for **one**
more root. A parallel tool-call batch needs `active.length` of them. With 190 carried roots and a
3-result batch the test computes `190 + 1 >= 192` → false, keeps the checkpoint, appends 3 to 190, and
throws `CursorRootEnvelopeLimitError`: status 400, `retryable: false`, and `src/adapters/cursor.ts` fails
closed on the invalid-argument retry path when the last raw message is a tool result, which is exactly
this shape.

Measured at `bde5b19dd`, before the fix:

```
carried=190 parallel=2  -> OK roots=192
carried=190 parallel=3  -> THROW 193 roots
carried=189 parallel=4  -> THROW 193 roots
carried=188 parallel=8  -> THROW 196 roots
carried=170 parallel=25 -> THROW 195 roots
```

Reachable by ordinary growth, not a crafted fixture. Feeding each turn's assembled state back as the next
checkpoint — what `commitCursorCheckpoint` does — a plain conversation of 3-parallel-call turns died at
turn 48, and 5 calls per turn at turn 32. Both survive 200 turns after the fix, as do 1, 2 and 8 calls
per turn.

The fix bounds `active` by count where it is assembled, rather than adding a fourth disjunct that has to
predict the suffix width. Oldest results drop first, matching the direction byte pressure already prunes,
and at least one always survives; the existing abandon check then reads `historyMessageIndexes`, sees the
dropped result, and falls back to a coherent full replay. That is why the grid shows the newest result
delivered at all 78 positions rather than merely "no throw".

### Why the existing 188 could not see it

The three pressure fixtures this document already claims — 50 pairs behind 100 roots, 10 behind 180, 4
behind 190 — are all **sequential** pairs, and a sequential suffix has a trailing run of exactly 1, the
single width at which `+ 1` predicts the suffix correctly. The 628-position parallel sweep applied
**byte** pressure, where the abandon branch fires before the count cliff is reachable. Both axes existed
in the suite; neither case crossed them. All 188 tests passed identically with and without the production
fix, which is the sharpest available proof that no assertion covered this path.

`tests/cursor-blob.test.ts` now crosses them: three `test.each` rows (carried 190 × 3 results, 188 × 8,
170 × 25) assert both halves — inside `CURSOR_EXTERNAL_ROOT_BLOB_LIMIT` **and** the newest output still
present, because staying inside the envelope by sending nothing useful is the other half of this defect.
Disabling the new bound reddens exactly those three and nothing else. Four-suite total is 191 pass / 0
fail, `cursor-blob` alone 105.

The pattern named after round 4 held for a fifth time, one level up: rounds 2 through 4 all reasoned about
the count budget as a settled fact and argued about the disjuncts consuming it, while the budget itself was
never applied to the wider of the two things it was supposed to bound.

## Audit round 6: the r5 fix dropped in root space, and the check that guards it read raw space

The count bound from round 5 acts on `active`, a list of ROOT entries. The abandon check derived its
trailing run by scanning `suffixMessages`, which is RAW messages. The two spaces are not the same, and they
diverge on the most ordinary assistant shape there is: a bare tool call with no narration emits no root at
all, so two sequentially-executed results sit ADJACENT as roots while raw space still separates them with an
assistant message.

Consequence: both results entered the root-space trailing run, the count bound dropped the older one, and
the raw-space scan — seeing a run of length one, the newest result, which survived — reported "kept". The
checkpoint was retained and the request went out with a tool call answered by nothing. Measured at 190
carried roots with bare-call pairs: the first answer was absent from every root and from `turns[]`. No
throw, no diagnostic, and the model's only sensible response is to re-issue the call — the exact loop this
unit exists to end, reintroduced by the fix for the previous round's blocker.

`tests/cursor-blob.test.ts` uses that bare-call shape in nine fixtures, so this was not an exotic input.

Two separable defects sat in the same place. The drop was also unnecessary: `historyLimit` subtracted
`systemEntryCount` on the checkpoint path, where the caller appends only `ids.slice(suffixSystemCount)` and
the checkpoint's own system roots are already inside `carriedRoots.count`. One free slot was charged twice,
so at 190 carried roots the limit came out 1 where 2 results fit.

Both are fixed at the origin of the mismatch rather than at the call site. `rootPromptMessages` now returns
`activeMessageIndexes` — the trailing run as pruning saw it, recorded before pruning can shrink it — and the
abandon check reads that instead of re-deriving a run it cannot see correctly. It falls back to the
raw-space scan when the field is empty, which is how the full-replay and native shapes keep their previous
behaviour. `chargeableSystemCount` is zero on the covered-turn path, closing the double charge.

Measured after the fix: 24 bare-call configurations across carried 170-190 and 2-8 pairs lose no answer at
all, and the reclaimed slot is visible — 192 roots where the defect emitted 191.

### Mutation evidence, including one gap this caught in its own first attempt

- abandon check re-derives from raw space → 2 red
- system count charged twice → 1 red
- the round 5 count bound removed → 5 red

The middle row is worth keeping. The first version of the silent-loss test passed with the double charge
still in place, because that defect abandons the checkpoint and a full replay carries every answer — correct
output, reached wastefully, which no assertion about answer presence can distinguish. It took a second case
asserting the exact root count at exact fit to pin the arithmetic. A test that cannot fail against the
defect it was written for is the thing five of these six rounds actually kept finding.

Round 6 also found that `outputElided` on the marker-only truncation return had no coverage: removing the
flag left all 191 tests green, and `tests/` is outside `tsconfig`'s `include`, so nothing else would have
noticed either. Covered now by asserting the abandonment it is supposed to trigger.

Four-suite total is 197 pass / 0 fail; `cursor-blob` alone 111.

## Audit round 7: the repetition note stopped the walk that protects the results

The trailing-result walk tested one thing — `role === "toolResult"` — and walked backwards from the very end
of `history`. The repetition breaker appends a synthetic `[context note]` **user** root after the transcript
when the same output repeats three times or more. That note stands for no message, so it carries no
`messageIndex`, and the walk hit it immediately and stopped: `activeStart === history.length`, the trailing
run came out empty, `activeMessageIndexes` came out `[]`.

Two failures at once, both worse than the defect round 6 fixed:

The results lost trailing-run status altogether. They fell through into `prior` and were pruned as ordinary
history, so the "keep at least one result" floor never applied to them.

And the empty `activeMessageIndexes` sent the abandon check into its raw-space fallback — the exact scan
round 6 exists to avoid. Measured: at 186 carried roots the note-armed shape was RETAINED where the
identical shape without the note correctly abandoned to a coherent full replay.

The trigger is the worst possible one. The note arms on three consecutive identical assistant narrations,
which is the runaway-repetition shape this entire unit exists to end — so the input most likely to hit the
defect is the input the fix was written for.

Instrumented state at the moment of the break:

```
PRUNE   {historyLen:10, activeStart:10, active:0, activeIdx:[], historyLimit:6, lastRole:"user"}
ABANDON {activeIdx:[], usedFallback:true, trailingIndexes:[19], keptEnough:true}
```

`activeStart` equal to `historyLen` is the whole bug in one number.

The walk now skips trailing roots that carry no `messageIndex` before looking for the result run, and the
excluded roots are re-appended afterwards so the note itself still reaches the model. That re-append is the
part that needed care: a root added after pruning has to be paid for DURING pruning, or the envelope is
overrun by exactly its number. Left uncharged, note-armed continuations at 188-190 carried roots threw the
non-retryable 400 for both sequential and parallel suffixes. `syntheticCount` and `syntheticBytes` are
therefore charged in the count bound, in the prior-history admission loop, and in the byte accounting, and
the orphan-strip floor counts them too so the strip cannot eat into the trailing run.

### The byte relaxation was dropped rather than covered

Round 7 also found that `chargeableSystemBytes = 0` had no coverage: reverting it alone left all four suites
green. The double-charge argument applies to bytes in principle, but no configuration could be found where
relaxing it changes the assembled payload — six crossings of carried bytes against system size against
result size in the deciding band produced byte-identical output either way. So it is gone. Charging the
system bytes twice only ever errs conservative, and untested new code on the envelope path is a liability,
not a saving. The count relaxation stays: it is covered, and its own case reddens without it.

### Mutation evidence

- the `messageIndex` walk removed (r11 defect restored) → 1 red
- `syntheticCount` uncharged in the count bound → 1 red
- the note dropped from the payload instead of re-appended → 1 red
- `syntheticCount` uncharged in the prior-history loop → 2 red

The middle two are why this round's first attempt was not finished: both charges initially had no failing
test, exactly the condition round 6 had already been caught on once. A 224-configuration count sweep across
carried 185-191 by note-armed sequential and parallel suffixes showed the uncharged version throwing and the
charged version clean, which is what the new boundary case now asserts.

Four-suite total is 198 pass / 0 fail; `cursor-blob` alone 115. Sweeps re-run clean at this head: 1440
configurations across narrated, bare-call, whitespace-text and parallel shapes with zero envelope overruns,
zero orphaned calls and zero lost newest results; 78-position count-by-parallel grid clean; all five
multi-turn growth shapes survive 200 turns.

## Audit round 8: the note was inside the array every pruning block reasons about

Round 7 re-appended the note into `historyEntries` before the pruning blocks ran, and from that point every
one of them had to recognise a tail it could only identify by position. The initiator-recovery block could
not. Its floor is "stop when one entry is left", so with `[toolResult, note]` it counted the note as the
survivor and shifted off the **result**.

What reached the model, one 600 KB result, three identical narrations instead of two the only difference:

```
PLAIN  roots=3  lens=[16, 24, 524067]   <- the answer
ARMED  roots=3  lens=[16, 24, 193]      <- the note, and nothing else
```

193 bytes of "take a DIFFERENT action" in place of the output the model was waiting for. The result had
already been truncated to fit; the recovery block deleted it anyway. This is the reported symptom exactly —
no tool output, so the model runs the command again — re-entered through the fix for it.

A second mechanism compounded it. `activeBytes` included `syntheticBytes` while the equal-share divisor did
not, so shares summed to the entire budget and adding the note back always exceeded it. The
shrink-toward-equal-share pass — whose whole purpose is "a missing result is worse than a truncated one" —
became structurally unfittable, and control fell through to the loop that deletes a whole result. 246 bytes
of note cost a 200 KB answer. Reviewer measured 166 of 432 byte-pressure configurations losing an answer.

### The fix is structural, not another floor

Adding `+ trailingSynthetic.length` to each floor would have worked and would have left the next block to
discover the same trap. Instead the tail is held **out** of `historyEntries` entirely until assembly, and
every budget below is expressed net of it: `historyLimitForReal` and `historyBudgetForReal` are computed
once, before the first result is measured. The pruning blocks then reason only about real history and cannot
mistake one kind of root for the other, and the reservation is what keeps the tail from overrunning the
envelope when it returns.

That the reservation is load-bearing was proved twice over: with it removed the same shapes 400 on the byte
limit, and an intermediate version that held the tail out without reserving its bytes committed 51 bytes
over.

### Coverage, which was the round's second finding

The entire `syntheticBytes` charge family had no test: neutralizing it in one edit left the suite green
while a sweep against that mutation threw 148 envelope errors. That is the third uncovered hunk in this
unit, and it landed in the same commit whose message drops `chargeableSystemBytes` for being uncovered —
the argument was made and then not applied to the new code beside it.

Mutation evidence at this head:

- byte reservation removed → 2 red
- count reservation removed → 3 red
- note dropped from the payload → 4 red
- `messageIndex` walk removed (r11 defect) → 3 red
- note re-appended into `historyEntries` **and** the gross budget spent (r12 defect in full) → 2 red

The last row is worth stating precisely: re-appending alone is now harmless, because the reservation
prevents the loss on its own. The defect needed both halves, and the test catches the pair.

Four-suite total is 201 pass / 0 fail; `cursor-blob` alone 118. Sweeps at this head: 896 note-armed
configurations across four assistant shapes crossed with count and byte pressure, 1440-case
call-answer-invariant sweep, 224-case count sweep, 78-position grid — zero overruns, zero orphaned calls,
zero lost answers, zero notes lost. Five multi-turn growth shapes survive 200 turns.

### What eight rounds actually found

One defect, re-entering through each of its own fixes. Every round's patch was correct for the path it was
written against and silent about a sibling path in the same condition — and three times the sibling was
created by the previous fix. The through-line is not carelessness about the condition; it is that each fix
added a fact to the pruning code (`carriedRoots`, a count bound, a root-space run, a synthetic tail) without
asking which existing block already assumed that fact absent. The last fix is the first that removes a
distinction rather than adding one.

## Audit round 9: a subtraction clamped at zero cannot say "unaffordable"

The reservation was `Math.max(0, historyBudget - syntheticBytes)`, and the tail was appended
unconditionally. Those two facts are compatible only while the difference is non-negative. Below that the
clamp reports "the note costs nothing", every pruning block correctly reasons about a budget of zero and
emits nothing, and the note is appended anyway — so the payload lands over the limit by exactly the deficit
the clamp erased. With 26 bytes free and a 246-byte note, 220 bytes over and a non-retryable 400.

Holding the tail out of `historyEntries` is what made it unrecoverable. No block below could see it, so
none could charge it.

Ninth iteration of the same pattern, and this time the new fact was *the tail is always appended*; the
construct that assumed otherwise was the clamp introduced beside it.

### Why every fixture missed it

The exposed shape is a turn that does **not** end in a tool result — an ordinary user interjection after a
repetitive stretch. With a trailing result the abandon check's survival disjuncts fire and rescue the turn;
on a plain follow-up they structurally cannot, and nothing else bounded the tail. Every fixture in
`cursor-blob` is a tool continuation. Measured across 42 carried-byte positions: 13 throws with the note
armed, 0 without, all on the interjection tail.

The note is now dropped when it cannot be paid for. That is this unit's own priority order, stated in the
round 8 record and applied here: a missing instruction is recoverable, a missing tool result restarts the
loop.

### One inert condition removed rather than shipped

The first version of the affordability test also required a free root slot. It could not be made to matter:
60 boundary positions at and past the root limit behaved identically with and without it, because the count
bound already stops at one surviving result. It is gone. Byte affordability alone decides.

That is the second time in this unit an inert guard was written and then dropped, and the reason is worth
recording: an envelope condition that cannot fail is indistinguishable from one that is wrong, so keeping it
costs the next reader the same audit it cost this one.

Also corrected: one `activeBytes > historyBudget` gate still read the gross budget while its body wrote the
net one. Provably no behavioural difference — the entry has already been truncated to net by then — but it
is the exact drift that seeded rounds 5 and 6.

Mutation evidence: affordability removed → 3 red; tail appended regardless of affordability → 3 red.

Four-suite total is 208 pass / 0 fail; `cursor-blob` alone 122. Every sweep re-run clean at this head: 42
deficit positions, 60 count-boundary positions, 150 zero-budget boundary cases, 896 note-armed
configurations, 1440-case call-answer invariant, 224-case count sweep, 78-position grid, 24 bare-call cases,
and five multi-turn growth shapes surviving 200 turns.

## Audit round 10: the guard removed as inert was load-bearing at exactly one value

Round 9 dropped the count half of the affordability test, arguing that the count bound below always leaves a
slot free because it keeps one result. That is true for every value of `historyLimit` except 1 — where the
one free slot is precisely the one the surviving result takes. The note was then judged affordable on bytes
alone, the reservation clamped to zero, and the append pushed full replay to 193 roots.

Four armed-only `CursorRootEnvelopeLimitError` throws at 191 system prompts, across both tails and both
suffix widths, where the same request without the note assembled 192 and succeeded. Full replay has no
abandon branch, so nothing rescued it.

The reasoning error is worth naming precisely, because the sweep that supported it was real. It varied
**carried roots on the checkpoint path**, where the count-full disjunct abandons the checkpoint long before
`historyLimit` can reach 1. The reachable route is full replay with many system prompts — a different axis
entirely, and one no earlier round had needed. "Inert across 60 positions" was a true statement about the
wrong sixty.

Both conjuncts are restored. The lesson is not that removing inert guards was wrong; it is that "inert"
needs the axis that can make it fire, and a sweep along one axis does not establish it along another.

### The reservation was uncovered, distinctly from the append

Round 9's own mutation table claimed the affordability check was covered. It was covered at the **append**
site only: neutering `syntheticCount`/`syntheticBytes` while leaving `trailingSynthetic` gated left the
suite green, because asserting on the assembled payload cannot separate "the deficit was charged" from "the
tail simply was not appended". Asserting the exact root count at the boundary does separate them, and that
case is now present.

Mutation evidence at this head, each applied alone:

- count conjunct removed (the r14 defect) → 4 red
- byte conjunct removed (the r13 defect) → 3 red
- reservation neutered, append still gated → 6 red
- append ungated → 7 red

Four-suite total is 212 pass / 0 fail; `cursor-blob` alone 126.

### Ten rounds, one shape

Every round found the same class of defect: a fact added to the pruning code beside a construct that assumed
it absent. Rounds 5 through 10 were each triggered by the previous round's own fix. Two of those were
arguments about whether a guard could fire — one dropped correctly, one dropped wrongly and restored here —
which suggests the code's real difficulty is that its budget arithmetic has several axes and any single sweep
silently fixes all but one of them.

## Audit round 11: PASS, and the two notes it left

Round 11 found no blocker. It confirmed `syntheticCountRaw` can only be 0 or 1 — one push site, once per
request — so the conjunct reduces to `historyLimit >= 2` when the note exists, and checked that threshold in
both directions: at 1 the single free slot belongs to the result, at 2 both fit exactly at 192 roots. It
audited all 25 budget references and found gross values only in the affordability test itself, which is
where they belong. Across 5040 checkpoint configurations and 200-turn feedback growth at five call widths:
no throw, no overrun, no lost newest result, no orphaned call.

Its attribution rig is the more useful artifact. Driving HEAD, the parent, and base `dev` through identical
576-position grids: HEAD is never worse than its parent anywhere, and the 8 positions where HEAD throws and
`dev` did not are all 192 system prompts, where the prompts alone exceed the envelope and HEAD throws with
or without the note. On those same positions `dev` emitted 192 roots carrying **zero** tool results — the
re-run loop this unit exists to end. Totals: HEAD 104 throws / 232 newest-lost, parent 112 / 232, `dev`
96 / 372.

### The threshold is now pinned from the tight side too

Round 11's one actionable note: tightening `>= 1` to `>= 2` left all 212 tests green. Over-conservative is
safer than over-eager, but a suite that cannot tell a correct bound from an unnecessarily strict one is
exactly the gap that cost round 14. A case at two free slots now asserts that the note and the answer both
arrive at exactly 192 roots: relaxing the bound reddens 4, tightening it reddens 1.

### A claim in the round 10 record was wrong

That record said the reservation had been pinned at the append site only, and that neutering
`syntheticCount`/`syntheticBytes` left the suite green. On the parent commit that mutation already reddens
6, all of them pre-existing round 8 and 9 cases. The count-conjunct finding stands on its own evidence; this
secondary claim did not, and the root-count case is not what closed it.

### Remaining known gap, scoped out deliberately

On the extreme byte axis — a single system prompt near 523 KB — the note can be kept while the result
truncates to a marker, which inverts this unit's stated priority order. That band is identical on the parent
(24 positions) and far worse on `dev` (180), so it is pre-existing and improved here rather than introduced.
Full replay has no abandon branch to rescue it, which makes it a genuine follow-up rather than a
non-problem, and it belongs to its own phase.

Four-suite total is 213 pass / 0 fail; `cursor-blob` alone 127.

## Terminal outcome

PR #2940 landed on `dev` as squash commit `62df78d8dd2451accdc0ddd615b9fad080d64a60`, from head
`0340d17599b65dda8b739a30107f59297e0d145b`, with CI green at that exact head. The remote gate on
`ssh lidge` was re-run against the merge commit itself and reported exit 0 with 16359 pass / 0 fail /
16 skip, so the landed tree is verified rather than only the pre-merge head.

Round 11 is the closing verdict: PASS, with two minor notes, both addressed in `0340d1759` before the
merge — a threshold case pinned from the tight side, and the correction of a wrong secondary claim in
the round 10 record. Rounds 1 through 10 each found a genuine blocker, and rounds 5 through 10 were
each triggered by the previous round's own fix. That is the finding worth carrying forward: every one
of those fixes added a fact to the pruning code without asking which existing block had assumed that
fact absent.

Three items were scoped out on purpose and are not defects of this unit. The `envelope_exhausted`
reason still does not reach the checkpoint store, and the spread copy in `live-transport.ts` makes it
provably inert rather than merely unobserved; propagating it needs a signature change on a shared
prepare path. On the extreme byte axis near a 523 KB system prompt the repetition note can survive
while the result truncates to a marker, which is pre-existing and measurably better here than on the
parent. And `composer-2.5` assembles 194 roots because it is a hybrid — `echoToolResultInRoot` true
with `externalModel` false — which places it outside the envelope guard; that behaviour is identical
on `dev` and predates this work.

This unit moves to `_fin` under the rule in `AGENTS.md`: the work it records is now visible in public
git history.
