# wp5 revalidation — account policy and runtime settings

Previous D: wp4 at 728677beaf passed 1,016 focused tests, 25 actual CLI fixture scenarios, typecheck/structure/privacy/docs and final functional/security reviews. It is PR #6535, based on #6528; the first two layers passed exact-head hosted CI and are review-ready. wp5 uses the existing managed checkout on codex/cli-parity-accounts-settings.

Fresh source confirms distinct account-pool support/null semantics, per-account versus pool thresholds, paid-credit one/all shapes and the separate quota window dialect. Identity decisions must use the selected runtime's validated rows. Login options are flow-specific; ordinary OAuth, Codex device/browser and native Kiro method paths cannot share an assumed flag contract. Reset-grant status can read upstream status but does not consume a grant.

Settings PUT exposes catalogRefreshPending rather than a full catalog disposition; ultraFastTier requires same-target read-back because it is omitted from that reply. Injection and sidecar apply receipts differ again. Memory/compaction clear removes custom routing overrides; it does not stop either pipeline. Web reasoning is supported at the existing server assignment; only max-descriptions is vision-only among the previously shared optional parser fields.

Local v2 retains its actual action graph: mode/keep-native and changed on/off invoke sync even without a discovered port; threads and hints do not. Structured output must distinguish changed local state from sync evidence, including unknown injected results. Literal reserved hint text uses an explicit terminator.

Baseline: account-pool management, memory settings and credit settings tests passed 52 cases/279 assertions in isolated fixtures. This is baseline server proof, not verification of the forthcoming CLI additions. The bounded architect proposal and separate security consultation are in `.tmp/cli-parity/wp5-architect.md` and `wp5-security-plan.md`; concrete reflection and independent A precede B.
