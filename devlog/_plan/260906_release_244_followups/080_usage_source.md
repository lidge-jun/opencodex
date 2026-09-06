# Canonical xAI usage-attempt provenance

Depends on routing/replay changes; class C4 due credential-derived logging. Carry #3642 head 146ed679c9633e5d68726217fcadc8e0b107339b, preserving Co-authored-by: olddonkey <olddonkeyblog@gmail.com>. Refresh source head before carry.

## Exact map / field chain
- MODIFY src/server/request-log.ts after sealRequestAttemptIdentity: recordAttemptCredentialSource clears stale value and derives only grok-oauth or xai-api-key from resolved canonical xAI transport and authMode. Require https, correct host/path policy and no userinfo/query/custom port; unknown/custom/provider mismatch omits.
- MODIFY src/server/responses/core.ts after initial identity seal and every reseal that can change selected transport. Inspect later seals individually: OAuth retry same physical attempt retains source; new transport clears/rederives it.
- MODIFY src/server/chat-native.ts buildActiveRequest: record from activeProvider at initial build and key-pool rebuild, after resolution.
- MODIFY src/usage/log.ts: UsageCredentialSource union, optional persisted attempt field, normalizeUsageAttempt sanitizer accepts only fixed enum for xai attempts; unknown/historic/non-xai values omitted.
- MODIFY docs-site/src/content/docs/reference/adapters.md and docs-site/src/content/docs/reference/management-api.md, plus directly contradictory translated rows if any.
- MODIFY tests/usage/request-log.test.ts, tests/usage/usage-log.test.ts and tests/server/server-xai-oauth-401-replay.test.ts, retaining original behavioral tests and adding any uncovered reseal case.

Creation resolved runtime provider -> attempt helper; serialization usage append; deserialization normalizeUsageAttempt; consumers request history/management JSON/CodexBar integration read optional per-attempt value. No top-level combo attribution and no backfill from today's config. No UI enum interpretation added in this PR.

## Activation / verifier
Remote tests prove canonical OAuth Responses 401/replay source with sendCount=2, native Chat API-key source, pool rebuild, combo mixed attempts, stale label clearing, unknown enum/custom host/query/userinfo/port/non-xai/historic omissions, privacy canary excluded. All schema fields existing default behavior retained. Run ci.yml runtime+gates and explicit security review; no local tests or xAI live traffic required. Proof records final PR head and source identity, not fork author attestation alone.

