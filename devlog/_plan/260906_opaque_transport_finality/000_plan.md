# Opaque preflight transport and terminal outcomes

Class C4. Mandatory parent-PR review repair under the existing authorized release
chain; work phase opaque-transport-finality, criterion c-2. Parent #3753 remains
open/draft at b73809f7e, child #3754 remains open/draft at f5c88beb9 with its parent
base restored. No parent merge occurred. The original #3535 was briefly closed
by an out-of-order follow-up, immediately reopened, and its comment corrected.
No completion, approval or release gate is waived.

Public review references: PRRT_kwDOS-0Gi86fqEUo (preflight read failure escapes)
and PRRT_kwDOS-0Gi86fqEUq (tee EOF reports incomplete despite failed client tail).
The earlier full CI and independent reviews did not cover these paths. The
unfinished combo cycle is preserved and must consume the repaired parent before
its final verification. All execution remains hosted; no local suite/typecheck/
build or live Kiro request.

Implementation is one bounded failure-contract unit in 010_failure_boundaries.md.
Update the existing parent PR, run exact-head CI, cascade its commit into #3754,
and require fresh composed CI and review before bottom-up integration. Do not
close an original or retarget a child as a side effect of an unverified merge:
verify each preceding command and actual merged state before dependent actions.
