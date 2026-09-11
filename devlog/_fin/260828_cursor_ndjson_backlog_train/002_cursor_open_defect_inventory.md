# 002 — cursor open-defect inventory (re-verified vs origin/dev 50e955604)

Sol-high lane verdict, cross-checked against devlog 260826 docs 080-150.
Gap-campaign fixes 1-11 are ON origin/dev (checkpoint continuation,
empty-result explanation aee1cbd94, repetition breaker 35667bb7f,
envelope-echo 6503602c1/db37bc2fb/4433b7d19, routing-commentary a48f933e3/
ab54fe6b0, desktop stdin 83cf732a5). PR #2769 (16cb875b8) is orthogonal
error-classification work — NOT the stack base.

| # | Defect | Status | Fix surface | Evidence needed |
|---|---|---|---|---|
| 1 | Empty tool result in deep multi-round sessions | OPEN, boundary unknown | checkpoint suffix (request-builder.ts:472-478, protobuf-request.ts:915), inherited checkpoint state, tool-name aliases (tool-result-normalize.ts:108), native exec frames | correlated ingress -> normalization -> blob -> getBlobArgs -> SSE trace of one affected round |
| 2 | Flattened external replay loses structured agentic state | OPEN, partially mitigated | protobuf-request.ts:276 (reasoning/tool-call drop), request-builder checkpoint eligibility | deep-session probe proving checkpoint reuse without replay priming |
| 3 | Native shell zero-stdout reaches Cursor unexplained | OPEN, narrow | native-exec-shell.ts:125/:214 (ShellSuccess stdout:"", no stdout frame) | unsafe-enabled native session transcript |
| 4 | Blob "mar" token corruption | WATCH, unconfirmed | blob assembly if digests implicate | blob-integrity-mismatch repro |
| 5 | Double-batch echo | MODEL-class (W3 ruled out wire) | none | only if duplicate call IDs on wire |
| 6 | App-session image loop | APP-class/UNKNOWN | Codex app side | app-session capture |
| 7 | Shell-redirect instead of apply_patch | OPEN mixed policy | independent PR, own risk review | false-positive corpus |
| 8 | Fresh-conversation zero-output timeout | WATCH | transport only if reproduced | raw SSE trace |
| 9 | Premature final / strict N-call batch misses | MODEL-class | none | n/a |

## Stack plan implication

Adapter-fixable now: #1 boundary via instrumentation (wp4 phase 1), then the
proven fix (wp4 phase 2); #3 is a concrete small fix eligible for wp4
regardless of #1 outcome. #2 replay fidelity stacks only if #1 implicates
replay. Everything else is disposition-with-evidence in wp5.
