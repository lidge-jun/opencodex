# 050 — delivery record (post-2.49 round)

Every scoped item landed on `dev`. Fifteen pull requests merged; fourteen issues closed.

## Landed

| PR | Issue | Lane | What landed |
|---|---|---|---|
| #4128 | #4122 | T3 | Spark 5h header windows attribute to the model limit, not the account short slot |
| #4132 | — | T3 | moved the closed Spark unit out of the product PR into _fin |
| #4114 | #4110 | T1 | client-compaction status compares the operator-owned root URL instead of inferring from a missing marker |
| #4127 | #4112 | T2 | non-streaming provider input overflow reaches the terminal context-overflow mapping |
| #4138 | #3573 | T2 | configurable inbound body admission limit, default 256 MiB, hard-ceilinged |
| #4133 | #4073 | T8 | SECURITY.md private follow-up path, no SLA published |
| #4136 | #4121 | T8 | documents the opencode-free Zen lock-in instead of forging x-opencode-session |
| #4084 | #4083 | T1 | 90s Codex WebSocket response prelude |
| #4068 | #3926 | T1 | Google AI Studio native models[] envelope accepted by catalog discovery |
| #4134 | #4057 | T6 | routed account label surfaced in Logs and an --account CLI filter |
| #4135 | #4089 | T5 | agentTaskRecovery runs on a mid-thread native-to-routed switch |
| #4140 | #4120 | T4 | terminal validation verdict persists for a revoked credential |
| #3848 | #3846 | T4 | quota-exhausted registration saved as validation-pending |
| #4146 | #3777 | T4 | explicit account plan field; Anthropic lands plan: null with the upstream gap recorded |
| #4142 | #3761 | T7 | opt-in provider-level webSearchBridge for key-auth passthrough destinations |

Also closed by decision: #4076 (transient overlay; the registration half is #3848).
#3506 received a direction comment: translation fidelity, not a proxy-side progress cutoff.
#2495 was dropped after a feasibility study found it needs its own cycle rather than
riding on #4089.

## What the parallel structure actually bought

Three findings would not have surfaced from a single serial pass.

T4 found that a textually clean git auto-merge of #3848 against `dev` produced two
`const needsReauth` declarations in one scope — valid text, invalid TypeScript — and a
collision on positional slot 5 of `fetchPoolAccountQuota` where taking either side alone
silently passes the wrong value at the other call site. That is the concrete reason the
account work was a chain and not two lanes.

T1 found that #4084 and #4068 sat 106 commits behind `dev`, which the readiness gate
unticks past a 10-commit threshold, so neither could stay non-draft without a branch
update. It brought them current by merge rather than rebase, preserving contributor
authorship.

T7's own audit of its diff caught four real defects before the final head: tool-call
leakage on a failed turn, search-cell ordering, abort handling, and the continuation
body ceiling.

## Evidence standard held

No local product suite, typecheck, build, or install was run in any lane. Every merge
cites exact-head remote CI. Cancelled runs were never counted as passing: where a
concurrency group cancelled a gate with no successful counterpart at the same SHA, the
run was re-triggered and a real conclusion waited for.

#3848's readiness checklist was cleared by the maintainer rather than by author
attestation, because the local-CI box is an attestation the gate cannot disprove and
repository CI at the exact head is stronger evidence. The delivering lane declined to
tick it rather than assert a run it had not made.

T2 disclosed that it did not drive the orchestrate FSM, because the C-to-D edge requires
a test receipt it could not honestly produce under the no-local-runs rule. It left the
session at IDLE rather than fabricate one.

## Not done

Probes #3782, #3765 and #3719 remain open; they need live client observation rather than
a code change. #3978 stays deferred until the compaction status contract settles.
