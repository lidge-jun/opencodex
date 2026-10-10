# Runtime recovery review follow-up

Averroes found that successful getValidMainAccountToken clears reauth even when a concurrent request marks quarantine during background refresh. The later explicitRefresh:false WHAM gate is too late.

Expand the parent repair narrowly into main-account.ts: add an optional preserveReauth dependency option, default false for existing callers. The metadata-only recovery caller passes true, so successful refresh cannot clear a concurrent quarantine. Its existing post-refresh check skips WHAM when quarantine appeared. Ordinary/manual refresh semantics remain unchanged. Add a deferred token-refresh regression that marks reauth before success, requires the flag to remain set, zero WHAM calls, retained block and zero remaining runtime leases.

This is a prerequisite correction within the approved fresh-recovery contract, not a new subsystem. Re-review before pushing. Root and focused-test TypeScript checks, privacy scan and diff check passed before this follow-up; rerun affected static checks after it. No local suites have run. Behavioral verification remains exact-head CI.

Stable follow-up: Averroes re-reviewed all three changed files and the deferred token-endpoint regression, VERDICT PASS, blocking_issues0. Root typecheck and focused recovery-test TypeScript check passed again; privacy scan and diff check passed. Earlier focused TypeScript check also covered policy, provenance, raw evidence and actual WHAM/header observation tests. The tests were typechecked, not executed. No CI success is claimed for this new commit before push.
