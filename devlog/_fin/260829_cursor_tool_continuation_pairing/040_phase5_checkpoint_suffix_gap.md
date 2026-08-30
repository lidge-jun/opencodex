# 040 — Phase 5: the checkpoint suffix reopened the same defect

Depends on: `8df7051201df09113b17da3f71ace992f001d66c` (PR #2900) and
`27c6993c5471958db97c9a4ce1dccc2f591f6094` (PR #2903), both on `origin/dev`.

## What happened

A live re-run against merged `dev` reproduced the original symptom the unit had just closed:
12 duplicate `command_execution` items and 5 phantom "interrupted" mentions in one
`codex exec` transcript against `cursor/grok-4.6`.

The fix was not wrong; it was incomplete. Every run that had verified it used
`continuationMode: "full-replay"`. The failing run used `"checkpoint"` for 13 of its 14
requests — and the checkpoint path is a second, separate replay site.

## Root cause

`buildPreparedCursorRunRequest` handles a stored checkpoint by replaying only the part of
history the checkpoint does not already cover:

```ts
rawMessages: request.rawMessages.slice(suffixStart)
```

Both `rootPromptMessages` and `conversationTurns` then indexed tool calls from **that slice**.
A checkpoint is committed right after the assistant emits its tool call, so the cut normally
falls *between* the call and its result: the call is at `suffixStart - 1`, outside the slice.
The index came back empty, no invocation line was attached, and the result went out orphaned —
byte-for-byte the state the unit had set out to eliminate.

This is why the earlier verification was clean and the later run was not. Nothing about the
invocation line changed; the code path around it did.

## The change

`toolCallsByCallId` now runs over `request.rawMessages` (full history) and the resulting map is
threaded into both replay builders as an optional `knownCalls` parameter. What gets *replayed*
is unchanged — still only the suffix — so covered messages are not re-sent. Only the lookup
widens.

```text
                     suffixStart
                          │
  user ─ assistant(call) ─┤─ toolResult ─ …
   └──── covered by checkpoint ────┘  └── replayed ──┘
          ▲
          └─ read for the invocation line; NOT replayed
```

Both call sites keep their previous behaviour when `knownCalls` is absent, so the full-replay
path is untouched.

## Tests

`tests/cursor-tool-result-invocation.test.ts` gains a second describe block, driven red before
the fix was restored:

| Test | Red without the fix |
|------|---------------------|
| a result whose call is BEFORE the checkpoint cut still names its invocation | yes |
| the invocation line also reaches the checkpoint suffix turn step | yes |
| covered history is not replayed a second time | no — double-replay guard |
| an id reused in covered history yields no invocation line | no — ambiguity guard |
| native composer keeps checkpoint results off the root prompt | no — native-path guard |
| an ambiguous id resolved from full history is not re-resolved from the suffix | yes — against the threading *and* against `size > 0` |

### Why the lookup uses `??` and not a `size > 0` check

A review asked whether passing an empty `knownCalls` map should fall back to indexing the suffix,
since `??` keeps the empty map. It should not, and the distinction is load-bearing.

An empty map is a *decided* answer — "the full history holds no call that can be named" — not a
missing one. `toolCallsByCallId` deliberately **drops** any id that two different invocations claim,
because a confidently wrong label is worse than none: nothing downstream can detect a mislabel.

Measured, with two calls sharing one id before the cut and the result belonging to the *first*:

| Lookup | Invocation line emitted |
|--------|-------------------------|
| `knownCalls ?? …` (shipped) | none — correct, the id is ambiguous |
| `knownCalls.size > 0 ? … : …` | `invoked: exec_command with {"cmd":"echo SECOND"}` — **wrong command** |

The suffix contains only the second call, so a suffix-only index sees one unambiguous-looking
candidate and names it. `tests/…` case "an ambiguous id resolved from full history is not
re-resolved from the suffix" pins this: it fails with the `size > 0` variant and passes with `??`.

Worth recording that the first version of this argument cited the wrong test. "an id reused in
covered history yields no invocation line" passes under *both* variants, because there the reused id
is ambiguous within the suffix too. The distinction only shows up when the ambiguity is visible in
full history but not in the suffix, which is what the added case constructs.

**Three** of the six assertions fail without the threading and pass with it; the other three are
guards that must hold either way, and they document what the widened lookup must *not* break.

An independent final-gate review corrected this count. The original text said two of five, which was
wrong on both numbers: the sixth test was added after the table was written, and it fails against a
missing threading too, not only against a `size > 0` fallback. Without the threading `knownCalls` is
`undefined`, so the suffix-only index sees one candidate and names `echo SECOND` for a result whose
output is `FIRST` — the same wrong label, reached by a different route. Measured at `1241a8d5c`:
reverting only the call-site threading gives **16 pass / 3 fail**.

The fix is therefore better covered than the first version of this record claimed. Recorded because a
reader who reverts the threading expecting two failures would not know whether they were looking at a
stale doc or a real drift.

Two shapes needed care while writing them:

- An empty `ConversationStateStructure` serializes to **zero bytes**, which the encoder reads as
  "no checkpoint" and silently downgrades to full replay. A test seeded that way passes while
  exercising the wrong branch. The helper seeds one real root blob instead.
- A turn only opens on a user message, so a suffix of just `[toolResult]` produces **no turns at
  all** (measured: `turns=0`). The turn-step assertion therefore uses a suffix that also carries a
  later user message, which is the shape that actually reaches that code.

## Verification

- `bun test tests/cursor-tool-result-invocation.test.ts tests/cursor-tool-continuation.test.ts tests/cursor-blob.test.ts` — 123 pass, 0 fail.

## Completeness: are the two patched sites the whole set?

The obvious residual risk is a *third* replay site with the same suffix-indexing bug, which would
make this unit's third partial fix. Enumerated against the source rather than assumed.

Only two functions attach an invocation line, and both now take `knownCalls`:

| Site | Line | Emits | Indexed from |
|------|------|-------|--------------|
| `rootPromptMessages` | 240 | root `[Tool Result]` blob | `knownCalls ?? toolCallsByCallId(messages)` |
| `conversationTurns` | 953 | turn step `[Tool Result]` | `knownCalls ?? toolCallsByCallId(messages)` |

`toolResultToText` has a third caller, `contentText` at line 498, which passes no call and therefore
can never name an invocation. It is not a gap, because no tool result reaches it: all three of its
callers select on role first.

- line 285 — `historyContentText`, guarded by `message.role === "user" || message.role === "developer"`.
- line 1034 — the turn's `userMessage`, reached only in the loop's final `else` after the `assistant`
  and `toolResult` branches have both `continue`d.
- line 1052 — `activePromptText`, which scans backwards for a `user`/`developer` message.

So the `toolResult` branch inside `contentText` is dead for these paths, and the two patched sites are
the complete set. `request-builder.ts` has its own `toolResultToText` for the text `messages` channel;
it is a different channel with no invocation line by design and is out of scope here.

### Two gaps that enumeration missed

The final-gate review found the argument above correct about `contentText` but the surrounding claim
overstated: "only two functions attach an invocation line" is true, yet it is not the same statement as
"every site that emits a result envelope has been accounted for". Both items below are **pre-existing**
and neither is induced by the checkpoint cut.

**A fourth emission site, line ~1025.** The `conversationTurns` native branch resolves its call from
suffix-local `pendingToolCalls` and, on a miss, falls through to a bare `toolResultToText(message)`
with no invocation line. It never consults `knownCalls`. Measured: full replay and checkpoint produce
byte-identical bare output on the same interleaved input, so the cut does not induce it.

**The two builders gate on different predicates.** `rootPromptMessages` uses
`cursorNeedsExternalToolContinuation`; `conversationTurns` uses `isCursorExternalWireModel`. These
disagree for exactly one model:

| Model | `cursorNeedsExternalToolContinuation` | `isCursorExternalWireModel` |
|-------|--------------------------------------|------------------------------|
| `composer-2.5` | true | **false** |
| `grok-4.6-high` | true | true |
| `composer-2.5-fast` | false | false |

So for `composer-2.5` the map is threaded in and then ignored by the turn builder. Measured on an
interleaved history: `ROOT invoked=true`, `TURN_STEP invoked=false`.

The asymmetry was inherited from #2900, where the root gate was deliberately widened to
`cursorNeedsExternalToolContinuation` (audit 001 F2) while the turn gate was left alone. Whether
`composer-2.5` turn steps should also name the invocation is a behaviour question about a native
model's replay, not a checkpoint-indexing bug, so it is not folded in here — it belongs to a unit that
can verify the native path end to end rather than being changed on inference.
- `bun x tsc --noEmit` — exit 0.
- Full suite on `ssh lidge`; no local full-suite run was used as a gate.

## What the live runs did and did NOT prove

This has to be stated plainly, because the previous phase of this unit recorded a live claim that
turned out not to hold.

Three live `codex exec` runs against `cursor/grok-4.6` through a patched probe on port 10199, all
confirmed served by that probe (`cursor:run-request` present in its own diagnostic log):

| Run | Commands requested | Unique `command_execution` items | `interrupted` | Terminated |
|-----|--------------------|----------------------------------|---------------|-----------|
| 1 (3-step) | 3 | 3 | 0 | `ALLDONE`, exit 0 |
| 2 (4-step) | 4 | 3 | 0 | `turn.completed`, no `ALLDONE` |
| 3 (4-step, same prompt as 2) | 4 | 4 | 0 | `ALLDONE`, exit 0 |

**Every one of the 13 requests across those runs used `continuationMode: "full-replay"`.** The
checkpoint branch this PR changes was never entered, so these runs do NOT verify the fix. They only
establish that it caused no regression on the path they did take — which is expected, since the
full-replay call sites pass no `knownCalls` and are byte-identical in behaviour.

Checkpoint mode did not engage because every commit was refused. The probe's own diagnostics name
the guard:

```text
[ocx:cursor:checkpoint-commit-refused] {"replayUnsafe":true,"emittedClientTool":true,…}
```

`replayUnsafe` is set by `live-transport.ts` on `local_side_effect`, which native exec pushes before
running a local command. A shell-command repro therefore cannot produce a committable checkpoint,
and the following request falls back with `checkpointInvalidationReason: "missing_ref"`. The
original failing transcript reached checkpoint mode 17 times because its checkpoints were committed
as `toolSuspended` — upstream serialized state while suspended on a client tool call.

What does verify the fix is the encoder-level evidence, which addresses the same code path directly:
the two red-then-green assertions, and a standalone probe that builds a real 59-byte checkpoint with
the cut between call and result and reports `invoked=true` (`invoked=false` before the change).

### Run 2 is a sampling artifact, not a regression

Run 2 stopped after three of four commands, and its final assistant message contained a
**fabricated** `[Tool Result]` envelope as chat text — the model wrote out a plausible-looking result
for `echo DDD` rather than calling the tool. That is the 363-B mimicry failure mode, and it deserved
attribution rather than dismissal.

It is not caused by this change:

- The change cannot reach that run. All 13 requests used full replay, whose call sites are unchanged.
- A baseline probe built from `27c6993c5` (`dev` without this PR) ran the identical prompt: 4/4
  commands, `ALLDONE`, no fabrication.
- Re-run 3 on the **patched** probe with the identical prompt: 4/4 commands, `ALLDONE`, no
  fabrication.
- The operator's unpatched 2.35.0 proxy ran the same prompt cleanly as well.

Same code, same prompt, different outcomes across runs 2 and 3, so the variable is model sampling.
The underlying tendency — an external model imitating a replayed result envelope instead of calling
the tool — is a real and known weakness of text-echoed continuation, and it is what the 363-B guard
exists to limit. It is a pre-existing exposure, not something this PR introduces, and it is worth a
separate unit rather than being folded in here.
