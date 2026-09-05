# Roadmap audit synthesis

Independent reviewer Kuhn returned FAIL with three high blockers. Accepted all three; no rebuttal and no production edits.

1. Outbound enforcement: the plan described intent but the actual materialization APIs lacked config. Added explicit options.config threading through core/compact, post-await recheck and race tests. The old unused assertion is explicitly insufficient. Follow-up source search also found legacy `headersForCodexAuthContext` paths in core/compact/ws-bridge; implementation must carry the same config or a live policy closure there rather than treating them as harmless wrappers.
2. Durable evidence: the old cache expires after six hours, contradicting missing-reset retention. Added independent identity-tagged `mainPolicyQuota` envelope member, retained across rotation TTL and unrelated persistence, with one shared partial merge rule and restart tests.
3. Workspace identity: credential equality alone does not imply the selected workspace matches. Added both-token-and-selected-identity matching, conflicting-header exclusion, zero-new-auth-read tests and explicit unmatched-keyring limitation.

Cross-blocker consistency: final materialization reads the same current policy/status getter; its retained evidence is identity-bound and never recovered by trusting an unsigned caller claim. Maintenance reads remain allowed. Legacy routing reads retain their original semantics.

Baseline checks actually observed by main: root typecheck exit0; GUI build exit0 (existing large-chunk advisory); GUI lint:i18n exit0. No local suites. Source-level findings refer to base d6b457462.
