# wp4 — a measurement artifact that nearly reversed the verdict

While sizing `CHECKPOINT_CAPTURE_GRACE_MS`, a batch of runs returned 0 checkpoint
frames for **every** arm, including the 12-tool 1500 ms condition that had just
produced a frame twice. Taken at face value that reverses wp2.

It was an instrumentation bug in the probe, not a behaviour change.

## The artifact

The probes windowed the log by line count: record `L = ocx debug provider logs | wc -l`
before a request, then read `tail -n +$((L+1))` after. `ocx debug provider logs` is a
**bounded ring buffer** — measured at exactly 500 lines on this machine. Once the buffer
is full, `L` equals the cap and every later `tail -n +501` returns nothing. Every arm
then reports zero, uniformly and convincingly.

Reading `tail -50` after each request instead of a computed offset restores the signal
immediately.

This is the fourth time in this unit a conclusion rested on a field that did not mean
what it appeared to mean. The others were the native/external gate, `elapsedMs`, and
the tool catalog. It is worth saying plainly: **the failure mode of this investigation
is not bad reasoning about the adapter, it is trusting an observable without checking
what produces it.**

## Corrected measurement

Tool turn, `parallel_tool_calls: true`, 12 tools (1500 ms):

```
[ocx:cursor:frame] {"case":"interactionUpdate","update":"toolCallStarted",...}
[ocx:cursor:frame] {"case":"conversationCheckpointUpdate","usedTokens":0}
[ocx:cursor:client-tool-suspend] {"framesReceived":33,"elapsedMs":4488}
[ocx:cursor:checkpoint-commit-refused] {"emittedClientTool":true,"capturedAfterClientTool":true,"externalModel":false,"storeCheckpoints":true,"capturedBytes":3036}
```

Tool turn, same 12 tools, `parallel_tool_calls` absent (50 ms):

```
[ocx:cursor:frame] {"case":"interactionUpdate","update":"toolCallStarted",...}
[ocx:cursor:client-tool-suspend] {"framesReceived":32,"elapsedMs":2827}
[ocx:cursor:checkpoint-commit-refused] {"emittedClientTool":true,"capturedAfterClientTool":false,"externalModel":false,"storeCheckpoints":true,"capturedBytes":0}
```

Plain turn, for shape comparison:

```
[ocx:cursor:frame] {"case":"conversationCheckpointUpdate","usedTokens":0}
[ocx:cursor:frame] {"case":"conversationCheckpointUpdate","usedTokens":12037}
[ocx:cursor:frame] {"case":"interactionUpdate","update":"stepCompleted"}
[ocx:cursor:frame] {"case":"conversationCheckpointUpdate","usedTokens":12037}
[ocx:cursor:frame] {"case":"interactionUpdate","update":"turnEnded"}
[ocx:cursor:checkpoint-continuation] {"checkpointBytes":492,"wireModel":"default"}
```

**wp2's LATE verdict stands.** The frame arrives strictly after `toolCallStarted` and is
cancelled away at 50 ms.

## One hypothesis raised and discarded here

Mid-investigation the `usedTokens: 0` on the tool-turn checkpoint was read as evidence
that it is an early, pre-tool snapshot, which would have made branch A actively unsafe.
The ordering above refutes that: the frame arrives **after** `toolCallStarted` within the
same turn, and carries 3036 bytes against the 492 a plain turn commits.

`usedTokens: 0` therefore looks like an unpopulated field on this update, not an empty
snapshot. That is a reading, not a proof — and it is exactly the kind of reading this
unit keeps getting wrong. **wp5 still owns the question of whether those 3036 bytes
cover the tool call, and branch A2 stays gated behind it.**
