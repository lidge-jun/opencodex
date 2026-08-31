# Kiro post-final-answer tool calls — measurement and root cause

Reported symptom, twice: routed through Kiro, the agent keeps issuing tool calls
after its final response has already been delivered.

## Hosts measured

| Host | Proxy | Version | Checkout | Kiro attempt rows |
| --- | --- | --- | --- | --- |
| local (this machine) | PID 99470, port 10100 | 2.36.0 | primary source checkout | 4080 |
| `macmini-cf` | PID 96671, port 10100 | 2.35.0 | `~/opencodex` | 0 |

`macmini-cf` carries no Kiro attempt diagnostics at all, so every behavioral
row below comes from the local 2.36.0 proxy. The remote host is one release
behind and is not the reporting surface.

## What the attempt rows say

`ocx:kiro:attempt_complete` over the local log, bucketed:

| Count | mode | sawText | sawRealTool | completionCalls | stopReason |
| --- | --- | --- | --- | --- | --- |
| 2643 | required | true | true | 0 | TOOL_USE |
| 1400 | required | false | true | 0 | TOOL_USE |
| 23 | required | true | false | 1 | TOOL_USE |
| 10 | disabled | true | false | 0 | END_TURN |
| 2 | required | false | false | 1 | TOOL_USE |
| 1 | required | true | false | 0 | END_TURN |
| 1 | text_fallback | false | false | 1 | TOOL_USE |

4069 of 4080 attempts ran in `required` mode and every one of them ended with
upstream `stopReason: TOOL_USE`. Only 25 attempts ever called the private
completion tool. The model overwhelmingly prefers another tool call to the
completion channel.

## What is NOT the cause

Two candidate mechanisms were ruled out with evidence rather than reading.

Replayed history is not the cause. 532 client rollouts under
`~/.codex/sessions/2026/08/{29,30}` were scanned for a `final_answer` message
followed by a tool call with no intervening user turn. What actually follows a
recorded `final_answer`: END 478, user message 131, developer message 5, tool
call 0. The client never replays a post-answer tool call.

The delivered-answer local terminal is not broken. Two live probes against the
running proxy replayed a closed turn — once with `phase: "final_answer"`
echoed, once without it, matching real Codex traffic — and both returned
`output: []` with `end_turn: true` and added zero upstream Kiro requests.
The guard added in `b557a8140`/`68eaf45d8` works.

It has simply never been needed: `~/.opencodex/usage.jsonl` holds 25042 Kiro
rows with zero `localTerminalReason` and zero `locallyAnswered`. Real turns
never arrive already closed, because the client ends the turn itself. So the
defect lives inside a live turn, not across turns.

## Rejected first hypothesis

The first diagnosis was that the model calls the completion tool, waits for a
tool result that never arrives, and then calls another tool. An independent
read-only audit refuted it with the parser: `flushOpen` consumes a valid
completion call and records `completionAnswer` without emitting any tool-call
event, the stream end yields the answer as `final_answer` followed by
`done(endTurn: true)`, and `parseKiroStream` returns without another request.
A completion call therefore terminates locally inside one inference; there is
no later inference in which the model could "keep going". Mixed
completion-plus-real-tool output in one inference also fails closed before any
answer is delivered.

That refutation is correct, and it narrows the defect rather than dissolving it:
the problem is not what happens AFTER a completion call, it is that the model
mostly never makes one.

## Root cause

The private completion tool is advertised to the model as an ordinary tool.

A source probe (`buildKiroPayload` with an `exec`/`wait` catalog) renders the
wire tool names as `["exec","wait","codex_kiro_final_answer"]` and injects:

> Valid tool names for this turn are exactly \`exec\`, \`wait\`,
> \`codex_kiro_final_answer\`. These listed names are the complete top-level
> tool-call surface for this turn.

That sentence comes from the shared, provider-agnostic nudge in
`src/adapters/tool-catalog-nudge.ts`, which knows nothing about completion
semantics. It cannot distinguish the proxy's private terminal channel from
`exec`, and the same nudge closes with:

> Count a tool call only after its tool result returns.

`KIRO_COMPLETION_INSTRUCTIONS` is the only text that describes the completion
tool, and it never contradicts that:

> When tools are available, ordinary assistant text is mid-task commentary and
> does not end the turn. Continue using tools after progress updates. When the
> task is fully complete and no more tool calls are needed, call
> `codex_kiro_final_answer` exactly once with the complete user-facing final
> answer in `answer`. Do not provide the final answer as ordinary assistant
> text.

Every sentence there is about WHEN to call it. Nothing marks it as different in
kind from `exec`, and nothing states what happens after. So the model holds a
contract in which the terminal channel is one more ordinary tool it may defer
while it keeps working — and the generic nudge's "count a tool call only after
its tool result returns" applies to it as uniformly as to everything else.

The failure that follows is one of SELECTION, not sequencing. Across 4069
required-mode attempts the completion tool was chosen 25 times: 0.6%. The model
keeps emitting finished prose as commentary and calling ordinary tools instead
of completing through the channel built for it.

That is what the user sees. Measured over 1116 Kiro turns in the same two days
of client rollouts: 626 turns ended through the completion channel, 462 ended
on a tool call, and 28 ended with answer-shaped commentary prose and no
completion call at all. Those 28 are answers the model had already finished
writing — they open with "Done.", "완료", "머지까지 끝났습니다", "All ten items are
done" — delivered as mid-task commentary, which by the proxy's own contract
"does not end the turn". Three of them are followed by 4, 10, and 12 further
tool calls after the closing summary was already on screen.

The missing terminal distinction is the leading mechanism behind that measured
selection failure: the terminal channel is advertised as an ordinary, deferrable
tool, and nothing tells the model that this is the one call that ends the turn.
It is a defect in the proxy's own injected text, not a client bug and not a
stream-parsing bug. Causality is not claimed as proven — establishing it
requires a live post-change comparison of the same selection rate, which this
unit records as the follow-up measurement rather than asserting up front.

## Fix direction

State terminal semantics where the model reads them: calling the completion
tool ENDS the turn, returns no tool result, and nothing may follow it. The
completion tool's own schema description is the load-bearing site — it travels
with the tool the nudge enumerates — with the prose contract kept consistent.

Removing the tool from the enumeration is not an option: the nudge states that
names mentioned only in instructions are not callable, so an unlisted
completion tool would be a tool the model is told not to call.
