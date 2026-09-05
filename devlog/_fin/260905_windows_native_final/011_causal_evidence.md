# 011 — Causal probes before Windows verification

No production fix was required; both source mutations below were temporary
test ablations and were restored with an empty `git diff -- src`.

| Probe | Observed result |
|---|---|
| Original local status row | 1pass; does not negate Windows short-name red |
| Original local12-scenario case | 1pass/72assertions in5.31s; not used to size Windows |
| Old15s readiness +16s publication delay | Timeout15004ms, childExit=null; cleanup exit0, actual publication16214ms |
| New spawn readiness +same16s delay | 1pass/6assertions, publication/readiness16215ms, case16.50s |
| Old15s deadline +delay +stall-on-stop | Both readiness and cleanup errors retained; child killed/joined;25.04s |
| New budget +stall-on-stop only | Assertions pass, cleanup fails/kills/joins at10.34s with both drains finished |
| Early child failure | Actual exit1/stderr reported in0.26s instead of waiting45s |
| Admission predicate forced false | Pre-recovery request becomes200; expected>=400 fails |
| API returns unresolved alias | Expected canonical other home; alias spelling fails |
| Normal two focused files | 55pass,0fail,287assertions,8.79s |

Typecheck and diff check pass. No fault environment setting is used in normal
tests or CI. The production gate and path resolver are unchanged. Independent
gpt-6-astra/high implementation review: PASS, no blockers; Windows full-suite
verification remains mandatory before closing the stabilization goal.

A temporary indentation rewrite accidentally removed two callback delimiters;
the focused check caught `port is not defined`. Delimiters were restored with
an explicit patch and typecheck before the final delayed probe. This was a local
editing error, not evidence about Windows readiness and not a shipped change.
