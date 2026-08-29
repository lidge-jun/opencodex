# wp6 — the orphan-strip loop eats the whole checkpoint suffix

Status: plan. Work-phase wp6, criterion `c-2`. Predecessors: `050` (superseded), `060` (merged as
#2936 / `d882caed5`).

## Symptom the user reported

Cursor models "무한 출력" and "툴 출력을 못받고" — the turn never terminates and the model behaves as if it
never saw its tool output.

Reproduced on merged `dev` `d882caed5`, isolated proxy, `cursor/grok-4.6`, three sequential `echo`
commands requested one at a time:

| observed | value |
|---|---|
| distinct commands requested | 3 (STEP1, STEP2, STEP3) |
| `command_execution` items emitted | 14 |
| STEP1 runs | 7 |
| STEP2 runs | 7 |
| STEP3 runs | **0** |
| "interrupted" narrations | 6 |
| terminal answer | never (`ALLDONE` absent) |

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

The suffix grows and the payload does not. Live diagnostics agree — `rawMessages` 9, 11, 13, 15, 17, 19
across consecutive tool-continuation turns with `rootBlobs` pinned at 5 and `continuationMode`
`checkpoint` every time.

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

