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

```
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
