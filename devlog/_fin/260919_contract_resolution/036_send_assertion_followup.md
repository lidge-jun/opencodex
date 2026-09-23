# PR 5170: exact send-budget refusal assertions

PR #5170 is a test-only follow-up to merged #5152, at head `825d4ed9c72233bc862668fec6010862bcddadea`, targeting dev. It captures the actual adapter rejection and requires `SendBudgetExhaustedError`, while preserving zero executor calls and zero spent permits. The outer request case now asserts its existing HTTP 200 buffered-failure contract explicitly, alongside the refusal code and zero send counts.

Both changed files were inspected and independent review was assigned. No production behavior changes, assertions removed, or limits raised. Local tests, typecheck, build and runtime execution were NOT RUN. Exact-head hosted CI remains required; the campaign follow-up task stays open until verified landing.

Independent two-file review PASS at825d4ed9: actualtypedrefusal, presentouterattempt, explicitHTTP200 failedbody andzerocount/executors areallpreserved. No productionchange or weakenedassertion. Exactheadhostedproofstillrequired.

Controlcheckinspection: samehead825d4ed9 has successfulenforce-target35443894094 andcancelledduplicate35443954318. No rerunnecessaryforthisduplicate; currentruntime/macOS proofstillpending.

Merged as `49c79f366c571bad47a59faca230164b9da40d88` at 2026-09-19T13:38:58Z. Exact-head hosted run [35443894116](https://github.com/lidge-jun/opencodex/actions/runs/35443894116) passed all applicable jobs and aggregate; target enforcement passed in 35443894094. Current actor, dev base, empty native-stack membership, absence of open review threads, and clean merge tree were checked before integration. The merge is an ancestor of refreshed origin/dev. The remaining review thread on merged #5152 was resolved, and the campaign follow-up task is complete. Original issue count remains 10/16; #5122 was already closed.
