# wp2 — does `conversationCheckpointUpdate` arrive late, or never

Decides C1. Written at wp1; re-verify against the tree before executing.

## The lever, and why no build is needed

`src/adapters/cursor/live-transport.ts:114`:

```ts
const CLIENT_TOOL_FINALIZE_GRACE_MS = 50;
```

Fifty milliseconds. The probe that produced `capturedBytes: 0` sent one tool and no
`parallel_tool_calls`, so it took the base path and the stream was cancelled 50 ms
after the turn drained.

`clientToolFinalizeGraceMsForRequest` (same file, line 416) already raises that window
from the request alone:

```ts
if (request.parallelToolCalls === true && (request.tools?.length ?? 0) > 1) {
  const advertised = request.tools?.length ?? 0;
  return Math.max(baseGraceMs, Math.min(1_800, Math.max(750, advertised * 125)));
}
```

A request with `parallel_tool_calls: true` and 12 advertised tools therefore gets
`min(1800, max(750, 1500)) = 1500 ms` instead of 50 ms — on the shipped binary, with
no patch, no second proxy and no credential copy. That is the experiment.

This deliberately replaces the instrumented build the roadmap first imagined. It is
strictly better: it exercises production code rather than a local mutant, and it
touches nothing on the operator machine.

## Procedure

1. `ocx debug provider on` on macbookpro-2; record the log line count as a baseline.
2. Request A (control): 1 tool, no `parallel_tool_calls`, `tool_choice: required`,
   model `cursor/auto-intelligence`. Expect the 50 ms path.
3. Request B (treatment): 12 tools, `parallel_tool_calls: true`, `tool_choice: required`,
   same model. Expect the 1500 ms path.
4. Capture per request: `client-tool-suspend.elapsedMs`, whether any
   `conversationCheckpointUpdate` frame appears, and
   `checkpoint-commit-refused.capturedBytes`.
5. `ocx debug provider off`.

## Decision rule

**This experiment can only return a positive.** Folded from the wp1 audit (high):
`client-tool-suspend.elapsedMs` is `Date.now() - this.turnStartedAt`
(`live-transport.ts:1015`, `turnStartedAt` set in `open()` at :1033), so it measures
the whole turn, not the grace delay. `000_plan.md` already records `elapsedMs: 2886`
on the 50 ms path. Model generation time swamps a 50-vs-1500 ms difference, so
`elapsedMs` cannot witness which branch of
`clientToolFinalizeGraceMsForRequest` ran. The original rule below was wrong and is
replaced.

- **LATE** — B shows `capturedBytes > 0`, or a `conversationCheckpointUpdate` frame
  that A lacked. Self-proving: bytes can only appear if the window outlasted their
  arrival. The 50 ms base grace is the defect. Go to `030` branch A.
- **INCONCLUSIVE** — anything else. A `capturedBytes: 0` result here does **not**
  establish NEVER, because nothing in the emitted diagnostics witnesses the grace that
  was actually used.

**Reaching a sound NEVER requires instrumentation**, and only if the cheap arm comes
back INCONCLUSIVE: add `graceMs: this.activeClientToolFinalizeGraceMs` to the
`client-tool-suspend` diagnostic payload, build on macbookpro-2 in a throwaway
checkout, and rerun arm B. NEVER is then `capturedBytes: 0` with a logged
`graceMs` of 1500. That instrumented arm is wp2b, appended only if needed.

## Result — LATE

Run 2026-09-11 on macbookpro-2, opencodex 2.50.0, same account and toggle as `001`.
Both arms used `cursor/auto-intelligence` and `tool_choice: required`.

Arm A, 1 tool, no `parallel_tool_calls` (50 ms path):

```
[ocx:cursor:client-tool-suspend]       {"framesReceived":33,"elapsedMs":3299}
[ocx:cursor:checkpoint-commit-refused] {"replayUnsafe":false,"emittedClientTool":true,"capturedAfterClientTool":false,"externalModel":false,"storeCheckpoints":true,"capturedBytes":0}
conversationCheckpointUpdate frames in window: 0
```

Arm B, 12 tools, `parallel_tool_calls: true` (1500 ms path):

```
[ocx:cursor:frame]                     {"case":"conversationCheckpointUpdate","usedTokens":0}
[ocx:cursor:client-tool-suspend]       {"framesReceived":34,"elapsedMs":4553}
[ocx:cursor:checkpoint-commit-refused] {"replayUnsafe":false,"emittedClientTool":true,"capturedAfterClientTool":true,"externalModel":false,"storeCheckpoints":true,"capturedBytes":2977}
conversationCheckpointUpdate frames in window: 1
```

**LATE.** Upstream does send `conversationCheckpointUpdate` on a suspended client-tool
turn. At 50 ms the stream is cancelled before it lands; given a longer window the frame
arrives and 2977 bytes are captured. The positive is self-proving, so the `elapsedMs`
problem that made a NEVER unreachable never had to be solved. **wp2b is not needed.**

### The second barrier, now visible for the first time

Arm B also shows `capturedAfterClientTool: true` with `externalModel: false` — and it
*still* refused. With bytes finally present, `toolSuspendedCommit` fails on the wire-model
test alone. So the two barriers are now separated by evidence rather than by argument:

1. capture never happened (all models) — fixed by `030` branch A1;
2. the native wire-model gate — reachable only after A1, and still gated on wp5
   proving the snapshot covers the tool call.

The original triage proposed removing barrier 2 while barrier 1 made it unreachable.
That is exactly what the probe was built to distinguish, and it did.
