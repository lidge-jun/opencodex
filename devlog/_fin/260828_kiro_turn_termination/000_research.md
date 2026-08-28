# Kiro turn termination — residual defect research

Observed 2026-08-28 21:20 KST by the user in a Codex desktop session routed
`kiro/claude-opus-5` through the local proxy on port 10100.

## Symptom

1. A plain question ("근데 코드 모드가 뭐임") produced the final answer TWICE in
   one turn, the second a near-duplicate rewrite of the first.
2. The user reports the "answer finishes, then continues like a goal" loop is
   still present after `cf1a5720c`.

## Live-state evidence

- Listener PID 3653, started 2026-08-28 21:17:50, running the checkout at
  `/Users/jun/Developer/new/700_projects/opencodex/src/cli/index.ts start --port 10100`.
- `cf1a5720c` committed 21:09:50 — the running process DID load that fix.
  Confirmed independently: a probe that produced no stdout in this session
  returned the new empty-exec wording added by that commit.
- HEAD advanced to `60537f067` at 21:26:53 (a different session's commit), so
  the running proxy is stale relative to HEAD but not relative to `cf1a5720c`.

So the residual behaviour is a real defect, not a stale process.

## Mechanism 1 — duplicate final answer (rendering)

Kiro emits answer-like ordinary text, then calls the private completion tool in
the SAME inference. The adapter releases the prose as `phase: "commentary"` and
the completion `answer` as `phase: "final_answer"`. `src/bridge.ts` closes the
commentary message on the phase change and opens a new assistant message, so the
client renders two assistant messages whose text is nearly identical.

This is pinned by the existing suite, so it is verified behaviour rather than a
hypothesis — `tests/kiro-stream.test.ts` asserts exactly:

```
{ type: "text_delta", text: "Done.", phase: "commentary" },
{ type: "text_delta", text: "Done.", phase: "final_answer" },
```

## Mechanism 2 — non-terminating turn (upstream fetch)

When replayed history ends in a delivered final answer, `buildKiroPayload` still
appends a synthetic trailing user turn carrying `KIRO_ANSWER_DELIVERED_MESSAGE`
and performs a real upstream inference. Neutral wording removes the instruction
to resume but does not remove the prompt: the model is asked again and answers
again. `60537f067` additionally suppresses the completion contract for that
shape, which narrows the loop, but there is still no terminal boundary that
avoids the fetch.

## Hypotheses tested

| id | claim | verdict | evidence |
|----|-------|---------|----------|
| H1 | the completion TOOL CALL never sets the phase flag | refuted | the proxy consumes the completion tool; a replayed history containing it throws at `src/adapters/kiro-wire.ts:88` (reproduced directly) |
| H2 | any synthetic trailing user turn re-invokes the model | confirmed | `src/adapters/kiro.ts` trailing-turn append still yields an upstream inference |
| H3 | another layer replays the answer | partial | the generic Responses guard is not involved; the Kiro-owned bounded completion fallback does perform a second fetch |
| H4 | commentary is the last recorded component | confirmed | ordinary text is forced to commentary; the completion answer is a separate final message, split at `src/bridge.ts:922` |

## Verification baseline

`bun test tests/kiro-adapter.test.ts tests/kiro-stream.test.ts tests/server-kiro-completion-e2e.test.ts`
-> 180 pass, 0 fail at `60537f067`.
