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

Two assertions fail without the threading and pass with it; the other three are guards that
must hold either way, and they document what the widened lookup must *not* break.

Two shapes needed care while writing them:

- An empty `ConversationStateStructure` serializes to **zero bytes**, which the encoder reads as
  "no checkpoint" and silently downgrades to full replay. A test seeded that way passes while
  exercising the wrong branch. The helper seeds one real root blob instead.
- A turn only opens on a user message, so a suffix of just `[toolResult]` produces **no turns at
  all** (measured: `turns=0`). The turn-step assertion therefore uses a suffix that also carries a
  later user message, which is the shape that actually reaches that code.

## Verification

- `bun test tests/cursor-tool-result-invocation.test.ts tests/cursor-tool-continuation.test.ts tests/cursor-blob.test.ts` — 123 pass, 0 fail.
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
