# Frame-level record of one suspended tool turn

Research material for `000_plan.md`. No diffs here.

`000_plan.md` asserts that no `conversationCheckpointUpdate` appears among the frames
of a client-tool turn. That claim carries the whole unit — branch A exists only if the
frame is absent at 50 ms — so the sequence it rests on is recorded here rather than
left in a chat transcript.

## Capture conditions

macbookpro-2, macOS, opencodex 2.50.0, proxy PID 70500 on 127.0.0.1:10100, real Cursor
OAuth account. `ocx debug provider on` (runtime override, no restart). Request:
`POST /v1/chat/completions`, `model: cursor/auto-intelligence`, one `get_weather` tool,
`tool_choice: required`, no `parallel_tool_calls` — so the 50 ms base grace applied.
Response was HTTP 200 with `finish_reason: tool_calls` and
`prompt_tokens_details.cached_tokens: 0`.

## Sequence

```
[ocx:cursor:connected]   {"transport":"http2","connectMs":403}
[ocx:cursor:first-frame] {"latencyMs":630}
[ocx:cursor:frame] {"case":"interactionUpdate","update":"heartbeat"}
[ocx:cursor:frame] {"case":"kvServerMessage","kv":"getBlobArgs"}       x2
[ocx:cursor:frame] {"case":"kvServerMessage","kv":"setBlobArgs"}       x4
[ocx:cursor:frame] {"case":"interactionUpdate","update":"thinkingDelta"}
[ocx:cursor:frame] {"case":"interactionUpdate","update":"tokenDelta"}
[ocx:cursor:frame] {"case":"interactionUpdate","update":"thinkingDelta"}
[ocx:cursor:frame] {"case":"interactionUpdate","update":"tokenDelta"}
[ocx:cursor:frame] {"case":"interactionUpdate","update":"thinkingCompleted"}
[ocx:cursor:frame] {"case":"interactionUpdate","update":"textDelta"}   interleaved with
[ocx:cursor:frame] {"case":"interactionUpdate","update":"tokenDelta"}  x7 pairs
[ocx:cursor:frame] {"case":"interactionUpdate","update":"partialToolCall","toolCase":"mcpToolCall","callId":"call-d4f5fcfc-...-0"}
[ocx:cursor:frame] {"case":"interactionUpdate","update":"tokenDelta"}
[ocx:cursor:frame] {"case":"interactionUpdate","update":"toolCallStarted","toolCase":"mcpToolCall","callId":"call-d4f5fcfc-...-0"}
[ocx:cursor:frame] {"case":"execServerMessage","exec":"mcpArgs"}
[ocx:cursor:frame] {"case":"kvServerMessage","kv":"setBlobArgs"}       x4
[ocx:cursor:client-tool-suspend]      {"reason":"Responses bridge owns client tools; ending turn without fake mcpResult","framesReceived":33,"elapsedMs":2886}
[ocx:cursor:stream-end]               {"committed":true,"framesReceived":33,"expectedClose":true,"elapsedMs":2886}
[ocx:cursor:checkpoint-commit-refused] {"replayUnsafe":false,"emittedClientTool":true,"capturedAfterClientTool":false,"externalModel":false,"storeCheckpoints":true,"capturedBytes":0}
[ocx:cursor:stream-cancel-expected]   {"message":"Cursor upstream error: Cursor request was aborted","framesReceived":33,"elapsedMs":2887}
[ocx:cursor:stream-cancel-expected]   {"code":"ERR_HTTP2_STREAM_ERROR","message":"Cursor stream suspended: Stream closed with error code NGHTTP2_CANCEL","framesReceived":33,"elapsedMs":2893}
```

## What the sequence establishes, and what it does not

Establishes: across all 33 decoded frames there is no `conversationCheckpointUpdate`,
and the refusal that follows is over-determined — `capturedBytes: 0` fires regardless
of the model gate one line above it.

Does **not** establish that upstream never sends one. The stream was cancelled 7 ms
after the suspend (2886 to 2893), so the observation window closes immediately. This is
precisely why `010` can only return a positive; an absence here is an absence of
opportunity, not evidence of absence.

The last four `setBlobArgs` frames arriving after `toolCallStarted` are worth noting:
upstream was still writing blob state when the cancel landed. That is consistent with
the late-arrival hypothesis, and consistent with the frame simply not existing for a
suspended turn. It does not discriminate between them.
