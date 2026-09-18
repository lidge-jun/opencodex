# U1 — a clean `end_turn` must still produce `final_answer`

Source: issue #4855. Verified against `f1dfda8e48`.

## What is wrong

The Responses bridge decides whether a terminal assistant message is the final
answer by testing whether `stopReason` is truthy:

```ts
// src/bridge/sse.ts:1174
if (currentMsg) closeCurrentMessage(event.stopReason ? undefined : "final_answer");
```

Anthropic ends a normal turn with `stop_reason: "end_turn"` and the adapter
forwards that string verbatim, so a successful turn takes the `undefined`
branch and the terminal message ships without a phase. In Codex App the turn
then renders without the divider that separates activity from the answer.

The non-streaming path splits the same way:

```ts
// src/bridge/response-json.ts:530
cleanDone = e.stopReason === undefined;
```

`cleanDone` is the only input to the `flushText(...)` phase decision further
down, so the buffered path drops the phase for exactly the same reason.

## Why the classifier is the right answer

`src/responses/truncated-stop-reason.ts` exists for this. Three of the four
decisions in the same `case "done":` block already call it — lines 1179, 1184
and 1196 — and 1174 is the one that does not. On the buffered side, lines 538
and 558 already call `truncationReasonFor` and `isTruncatedStopReason`, and
530 is the one that does not.

`TRUNCATED_STOP_REASONS` maps Anthropic's `refusal`, `pause_turn`,
`max_output_tokens` and `model_context_window_exceeded`. It deliberately does
not map `end_turn`, `stop_sequence` or `tool_use`, and its header states that
unknown reasons are not truncation.

## What must not change

A clean stop and a cut-short stop must stay distinguishable. This unit is not
"treat every terminal as final" — it is "ask the classifier instead of asking
whether the string is non-empty". Concretely, after the change:

- `end_turn`, `stop_sequence`, `tool_use` and an absent `stopReason` close
  the message as `final_answer`.
- Every value in `TRUNCATED_STOP_REASONS` still closes without a phase, still
  fails an open tool call, still marks an in-flight search `failed`, and still
  suppresses the compaction item.
- The `error` and `incomplete` terminals are untouched. On the buffered path
  the existing `cleanDone && !errorEvent && !incompleteEvent` conjunction
  already covers them and stays as written.

## Change

Two predicates:

```diff
- if (currentMsg) closeCurrentMessage(event.stopReason ? undefined : "final_answer");
+ if (currentMsg) closeCurrentMessage(isTruncatedStopReason(event.stopReason) ? undefined : "final_answer");
```

```diff
- cleanDone = e.stopReason === undefined;
+ cleanDone = !isTruncatedStopReason(e.stopReason);
```

`isTruncatedStopReason` is already imported in both files. No new coupling.

## Regression coverage

`tests/adapters/bridge.test.ts` already drives both `bridgeToResponsesSSE` and
`buildResponseJSON` and is 1683 lines, below the 2000-line ratchet threshold.
Adding there needs no `scripts/test-layout/layout.json` or
`tests/fixtures/test-layout-expected.json` entry, so this unit adds no test
file.

Four cases, both entry points:

1. `done` with `stopReason: "end_turn"` and open text closes the message with
   `phase: "final_answer"`.
2. `done` with `stopReason: "max_output_tokens"` closes it with no phase.
3. `done` with `stopReason: "refusal"` closes it with no phase, and the turn
   still reports `content_filter`.
4. `done` with no `stopReason` keeps its existing `final_answer` behaviour.

Case 2 and case 3 are the ones that would catch an over-broad fix, and they are
the reason this unit is not a one-line patch with no test.
