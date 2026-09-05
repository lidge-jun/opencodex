# 001 — Remaining restore-child deadline failure

Repaired-head run33947540953/job101256273618 failed
codex-restore-app-rewrite.test.ts:156: the first real inject/rewrite/restore child
was terminated at the15000ms case budget. The helper maps a null status to1
and drops signal/error, so the thrown Error had an empty message. Siblings
completed in4.6–8.4seconds; no assertion failure from restore itself is recorded.

H1: the case-level15s limit kills an otherwise healthy cold child. Falsifier:
instrumented result reports a substantive failure before that deadline, or a
controlled16s child completes under the old15s case bound. Test with a normally
disabled delay fault before the child script; retain the five real child cases.

H2: actual injection/restore logic fails. Falsifier: same script completes after
the delay with every config/catalog/user-value assertion intact, and ablating
restore behavior still turns the test red. Preserve result.error/signal rather
than throw an empty string; do not call this environmental.

H3: shared or invalid fixture state. CODEX_HOME is unique per case and all work
is sequential, but OPENCODEX_HOME is inherited. No evidence currently points to
cross-fixture corruption. If diagnostics expose state contention, repair that
boundary rather than accept a retry or keep increasing budgets.

The earlier native status/alias assertions passed on Windows in shard3/6. The
goal stays ACTIVE: a red restore shard is remaining repair work, not completion.
