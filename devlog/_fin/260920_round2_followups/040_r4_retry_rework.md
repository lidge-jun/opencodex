# R4 — #4942 and #4989 as one ambiguous-resend gate

Status: OPEN. Branch `codex/260920-r4-retry-rework`, cut from `origin/dev` at `d6d87440b7`.

## Why the two pull requests are one change

#4942 (FredAmartey) replays a native Responses send whose connection died before any response
head, behind a per-provider opt-in. #4989 (lidge-jun) replaces a native Responses SSE stream that
died after the head while the body had carried only control events. Written apart they read as two
features. Against the stage table #5266 landed in `src/lib/request-failure-model.ts` they are one
row: a stage whose `stageCommitment` is `nothing-observed`, with a cause whose
`causeEvidence` is `unknown`. `resendPermission` answers `refused-ambiguous` for both, and
the module already names the only thing that may override it — "a narrowly scoped, explicitly
opted-in recovery that a maintainer reasoned about and bounded".

Two overrides is one too many. #4942 spreads `replayResets: 2` into every dispatch leg of the
request and #4989 takes `Math.min(1, remaining)` of the transient budget at the stream boundary,
so one logical request that reset before the head and again after it would buy a replacement on
each. The rework gives the override a single per-request allowance and makes both stages claim
from it.

## Shape

- `src/lib/request-resend-gate.ts` — the one gate. Pure table lookup for the stages the caller
  already observed something at, plus the operator override for the ambiguous row. It never
  restates the table: stage, cause, permission and send class all come from
  `request-failure-model.ts`, and the cause comes from the `AttemptRecoveryKind` that will be
  recorded, so the reason in the log and the send it authorised cannot disagree.
- `src/lib/request-execution-budget.ts` — the allowance lives on the shared send ledger, which is
  what a combo child inherits through `deriveRequestExecutionBudget`. Parent and child therefore
  cannot each hold one.
- `src/server/responses/reset-replay.ts` — the provider opt-in and the body judgment from #4942,
  plus the per-request authority both call sites use.
- `src/lib/upstream-retry.ts` — the pre-header claim, as a callback rather than a number.
- `src/server/responses/combo-stream-preflight.ts` — the preflight reports the stage it observed
  instead of a boolean, so the gate rather than the preflight decides.

## Stage classification at the stream boundary

#4989 gated on `responseCreated && !outputCommitted && !terminal`. That is `protocol-prelude`.
A read error before any parsed event is `headers-only`, which the table gives the same
commitment and therefore the same answer; the rework admits it rather than refusing a row the
table permits. Everything else the preflight can see is `semantic-output` or `terminal`, and
those refuse regardless of cause.

## In scope from the remainders

#4191 and #5180 only to the extent the resend gate reaches them. Recorded in 050.

## Verification

Static review plus exact-head hosted CI. Local suites, individual tests, typecheck, build,
install and live `ocx` execution are NOT RUN by lane policy.
