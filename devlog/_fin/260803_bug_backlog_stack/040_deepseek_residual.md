# 040 — Phase 4: #875 DeepSeek tool-loop residual

Outcome: **no code**. The reopen evidence does not describe current `dev`.

## What the issue claims

#875 was closed as fixed by #892, then reopened on 2026-08-03: the reporter
tested a candidate branch, the initial DeepSeek Responses request returned 200
with output and reasoning tokens, no `function_call_output` continuation was
ever sent, and Codex Desktop stayed pending.

That is a serious report and the reopen was the right call on the information
available. The information turned out to be stale.

## The ancestry check

The reporter tested commit `0b30283b6`. The commit that fixes DeepSeek
Responses over the Codex WebSocket is `5dd965a13` — "fix DeepSeek Responses
over Codex WebSocket".

```console
$ git merge-base --is-ancestor 5dd965a13 origin/dev && echo YES
YES
$ git merge-base --is-ancestor 0b30283b6 5dd965a13 && echo "tested BEFORE the fix"
tested BEFORE the fix
$ git rev-list --count 0b30283b6..5dd965a13
115
```

The tested build predates the fix by 115 commits. On `0b30283b6`, DeepSeek WS
turns still went through upstream SSE, where a missing or delayed terminal
leaves the client waiting — which is exactly the reported symptom. The
reproduction is real; it just reproduces a bug that has since been fixed.

## What current dev actually emits

A Codex Desktop turn against DeepSeek takes the bounded-JSON path, not SSE. The
registry declares `modelWebsocketUpstreamStreaming: false`
(`src/providers/registry.ts:1077-1080`), final-route normalization switches the
upstream request to `stream:false`
(`src/server/responses/core.ts:818-834`), and the JSON response is handed to
the WS bridge (`src/server/index.ts:1048-1057`).

`sendResponsesJsonAsEvents()` (`src/server/ws-bridge.ts:289-324`) then emits:

1. `response.created`
2. one `response.output_item.done` per `output[]` item — **including
   `function_call` items**, since the loop is untyped and forwards every item
3. `response.completed` / `.failed` / `.incomplete`

That is the sequence Codex needs. Its WebSocket frames enter the same parser as
SSE, and that parser accepts a function call directly from
`response.output_item.done` — `output_item.added` and
`function_call_arguments.done` are not prerequisites. On the done item Codex
queues the tool and sets `needs_follow_up`; on `response.completed` it drains
and issues the next `response.create` carrying `function_call_output`.

So there is no missing frame to fix on current `dev`.

## #940 does not touch this path

@mouzhi's #940 is real work for #938 and now also enables the repair on the
built-in DeepSeek preset. But every repair integration sits under the
`isEventStream` branch (`src/server/responses/core.ts:1851`), and DeepSeek WS
turns reach the JSON branch (`:2007`). The PR itself says JSON repair is not
implemented.

@Ingwannu's path distinction was therefore correct even as the PR moved. #940
should land or not land on #938's merits; it neither fixes nor blocks #875.

## DeepSeek's documented contract

Retrieved 2026-08-03 from the official
[Responses API reference](https://api-docs.deepseek.com/api/create-response/)
and [compatibility guide](https://api-docs.deepseek.com/guides/responses_api/):
the API is stateless, `previous_response_id` is unsupported so clients replay
full history, `function_call` / `function_call_output` are supported input
items, `call_id` must be non-empty and unique, and plain-text reasoning is
merged into the adjacent assistant message.

Nothing there contradicts what ocx emits.

## Disposition

Keep the issue open — a reporter saw a real stall and deserves confirmation,
not a close on an ancestry argument they cannot check themselves. The comment
states the ancestry finding, names `5dd965a13`, and asks for a re-test on a
build containing it.

If it still reproduces, the capture that settles it: proof the build contains
`5dd965a13`, the raw DeepSeek JSON, the exact ocx→Codex WS frames (especially
the `response.output_item.done` function item and the terminal frame), that
item's `type`/`call_id`/`name`/`arguments`, and whether a second inbound
`response.create` reached ocx at all. That last one splits the remaining space
cleanly: if it arrives, the defect is downstream of the handoff; if not, it is
the client's move that never came.

## One test worth adding regardless

`tests/ws-endpoint.test.ts:220-233` covers the JSON-to-WebSocket bridge with a
**message** item only. Nothing pins the function-call case — the exact shape
this issue turns on.

A regression asserting that a `function_call` item in `output[]` is forwarded
as `response.output_item.done` with `call_id`, `name`, and `arguments` intact
would make the disposition above provable by test rather than by reading the
loop. It rides along with the #545 layer since neither touches the other's
files, and it is cheap insurance: the current behavior is correct by virtue of
an untyped `forEach`, which is exactly the kind of correctness that a future
refactor breaks silently.
