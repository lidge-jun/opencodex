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
  tests/cursor-tool-continuation.test.ts` — 133 pass / 0 fail.
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
