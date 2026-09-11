# wp2 — de-confounding the LATE result

The first LATE run varied two things at once and a reviewer caught it. This records the
correction, because the correction is the part worth keeping.

## The confound

Arm B raised the finalize grace by sending `parallel_tool_calls: true` with 12 tools.
But 12 tools is not only a local signal: `buildCursorToolDefinitions` puts them in
`AgentRunRequest.mcpTools` (`protobuf-request.ts:1607`, `:1711-1712`) and the catalog is
named in the system note (`:197-201`). A larger catalog could plausibly change Cursor's
own context accounting and make it emit a `conversationCheckpointUpdate` for reasons
that have nothing to do with how long we waited.

So the original pair could not tell "we waited longer" from "we asked for more tools".

## The correction

Hold the wire constant, vary only the local knob. `parallelToolCalls` is read at
`live-transport.ts:423` and `:689` and is never protobuf-encoded
(`protobuf-request.ts:1736`), so `parallel_tool_calls` changes the grace and nothing
upstream. Three arms, 12 tools in every one:

| Arm | `parallel_tool_calls` | Grace | `conversationCheckpointUpdate` | `capturedBytes` |
|---|---|---|---|---|
| C | false | 50 ms | 0 | 0 |
| B | true | 1500 ms | 1 | 2742 |
| C repeat | false | 50 ms | 0 | 0 |

```
C  [ocx:cursor:checkpoint-commit-refused] {"emittedClientTool":true,"capturedAfterClientTool":false,"externalModel":false,"storeCheckpoints":true,"capturedBytes":0}
B  [ocx:cursor:checkpoint-commit-refused] {"emittedClientTool":true,"capturedAfterClientTool":true,"externalModel":false,"storeCheckpoints":true,"capturedBytes":2742}
C' [ocx:cursor:checkpoint-commit-refused] {"emittedClientTool":true,"capturedAfterClientTool":false,"externalModel":false,"storeCheckpoints":true,"capturedBytes":0}
```

Identical request bytes, opposite outcomes, reproduced in both directions within one
session. **LATE is isolated: the 50 ms finalize grace is the cause.**

## Why this is recorded rather than folded silently

Three times in this unit a plausible mechanism was asserted before the field it rested
on was checked — the native/external gate, `elapsedMs`, and now the tool catalog. Each
was caught by looking at what the value actually is rather than what it was assumed to
mean. The pattern is the finding.
