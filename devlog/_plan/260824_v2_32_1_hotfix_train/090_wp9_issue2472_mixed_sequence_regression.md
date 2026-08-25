# 090 — wp9: #2472, a real regression for silent zero-output tool results

Phase: wp9. Depends on: wp1 only. Independent of wp3–wp7. Must reach a terminal
outcome before wp8 freeze.

> This phase exists because the second audit round found the train had made an
> automated #2472 regression a mandatory GO gate while assigning no phase to
> write it. A gate nobody implements is not a gate.

## The defect as reported

A tool call returns success with no output at all — no stdout, no stderr, no
exit code — and the turn continues as though the command had run. The reporter's
proxy was on a pre-fix binary, which is why the original plan's first instinct
was "restart and re-measure."

## Why the original 100-call canary was the wrong instrument

Three findings, all verified:

1. The process on :10100 is PID 922, started 2026-08-23 — the **stale process
   from the bug report**, not a candidate build. Measuring it proves nothing
   about the code this train is assembling.
2. The failure needs Cursor native-shell/host-shell interleaving with duplicate
   call ids. Duplicates are already dropped at
   `src/adapters/cursor/protobuf-events.ts:1055`, and the two execution paths
   stay separate at `src/adapters/cursor/live-transport.ts:1445`. An ordinary
   prompt cannot deterministically produce that interleaving, so "100 calls,
   0 empty results" is a statement about luck.
3. It would restart the user's live proxy and spend real provider credits to
   produce that non-evidence.

## What this phase does instead

Drive the interleaving directly, in-process, with no provider spend.

`tests/cursor-zero-output-failover.test.ts` — **NEW**:

1. `interleaved native and host shell results with duplicate call ids do not
   silently succeed` — feed the event stream a native-shell result and a
   host-shell result carrying the **same** call id, in both orders. Assert the
   turn ends with either a typed error or a combo failover, never a success
   carrying zero semantic output.
2. `a turn that ends with zero semantic output is not reported as success` —
   construct `turnEnded` with no text, no tool output, and no reasoning. Assert
   the runtime classifies it as a typed failure rather than an empty success.
3. `duplicate-drop does not consume the only surviving result` — the drop at
   `protobuf-events.ts:1055` must not be the reason output disappears; assert
   the retained result is the one that reaches the turn.

Each test must be observed **failing against current `dev`** before any fix, or
observed passing with a recorded explanation of why the behavior is already
correct. A green test that was never red proves only that it was written after
the behavior.

## Terminal outcomes

- **Reproduced** → #2472 becomes a release blocker; the fix is a new work-phase
  appended to the goalplan, not a patch smuggled into another phase.
- **Not reproduced, tests green** → the primary zero-output defect is closed by
  the failover fix already on `dev`; #2472 is closed with the test as evidence,
  and the incorrect `wall_time_seconds` reporting is split into its own
  telemetry issue.
- **Cannot be driven deterministically in-process** → record exactly which
  interleaving could not be constructed and why, deregister #2472 as a GO
  criterion (per 000), and file it as a deferred known defect with the finding
  attached.

All three are acceptable closes. Silence is not.

## Accept criteria

| # | Criterion | Proof |
|---|-----------|-------|
| 1 | The regression file exists and runs | `bun test tests/cursor-zero-output-failover.test.ts` |
| 2 | Each test was observed red-then-green, or its green start is explained | captured output in the D record |
| 3 | A terminal outcome from the three above is recorded | this doc, updated at close |
| 4 | If deferred, 000's GO criteria are amended to match | 000 diff |

## Scope boundary

IN: the new test file and, if the defect reproduces, a recorded decision about
where the fix goes.
OUT: implementing that fix inside this phase; restarting or reconfiguring the
user's running proxy; any live provider call.

---

## Outcome (wp9 close, 2026-08-25)

**Terminal outcome: cannot be driven deterministically → #2472 deregistered as a GO
criterion and recorded as a deferred known defect.** This is the third of the three
outcomes this document allowed, and it is the honest one.

### What was attempted

The planned regression was written: `tests/cursor-zero-output-turn.test.ts`, seven
tests driving the native/host call-id dedupe, including three routes that each
produce a turn whose only event is the terminal `done`. It passed. It was then
**deleted**, because an independent review showed it pins the wrong mechanism.

### Why it was wrong

The dedupe lives on the **pre-execution announcement** side of the tool boundary.
`planMcpArgsHandling` deliberately ends turn 1 as `done` and cancels the Cursor run
without a result — `live-transport.ts:220-225` states outright that the real tool
result arrives on the NEXT `/v1/responses` request as structured history. #2472
reports output lost **after** the calling agent already produced non-empty text,
which is downstream of that boundary. A test that reproduced an empty-looking turn
on the announcement side would have looked like evidence while proving nothing.

The other two routes were equally unreachable: the empty-argument case only goes
silent under `allowEmptyArgs: false`, and the live bridge passes `true`
(`live-transport.ts:258`), where malformed shell arguments raise an explicit error.

### What is settled

- The bridge-version theory from the issue's own point 3 is closed: `88b7cc057`
  (zero-output combo failover) is an ancestor of `dev`, and the regression the issue
  asked for exists and passes — `tests/combo-stream-preflight.test.ts`, *"converts a
  zero-output failed terminal into a retryable HTTP failure"*, 4 pass / 0 fail.
- The dedupe is correct and stays. Without it every repeated `tool_call_start`
  becomes another Responses `function_call` item, i.e. a duplicate execution request.

### What remains open

There is no turn-wide semantic-output ledger. `finalizeTurnEvents` reports an error
for a call left OPEN at turn end but is silent for a turn that closed with zero
output, and the bridge emits `response.completed` with an empty snapshot. The
`empty-completion-guard` would catch it but is opt-in and defaults to false. The gap
is real **if a reachable producer exists**; none was constructible on current `dev`.

Settling it needs a reproduction at the `function_call_output`/next-request boundary,
not another adapter-level probe. The microsecond `wall_time_seconds` in the report is
the strongest remaining lead and deserves its own telemetry issue.

### Consequence for this train

Per 000's canary section, #2472 **stops being a GO criterion**. Criterion c-9 is met
by this recorded disposition rather than by a passing canary. Nothing about the six
merged runtime fixes depends on it, and the issue stays open with the investigation
posted at https://github.com/lidge-jun/opencodex/issues/2472#issuecomment-5402463174.

**LOOP-PESSIMIST-01.** The hypothesis that died is mine: that the zero-output symptom
could be reproduced from the adapter's event mapper. Two cycles in a row (wp7's
config-dir guard, wp9's dedupe theory) I built a plausible mechanism and had to
discard it against evidence. The pattern worth carrying: a reproduction that only
exercises code I chose to call is not a reproduction — it has to start from the
reported observable and work backwards to a path the runtime actually takes.

