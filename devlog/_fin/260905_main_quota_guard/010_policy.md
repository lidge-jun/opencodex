# Identity-bound main-account 99% policy

Depends on wp0. C4 care for quota/credential boundary; existing authentication and upstream grants remain authoritative.

Review amendment (033/034 in the Reserve plan layer) supersedes all expiry-retirement statements below: retained99 remains blocked after resetAt until a fresh valid lower reading arrives. Expired resetAt is omitted from the DTO. The existing60s sweep performs bounded/coalesced owned quota refresh; no inference, reset credits or new periodic timer. Raw negative readings are rejected as policy evidence before legacy clamping. Both quota writers hydrate before reading merge bases.

## Contract and complete field chain

NEW config `codexMainAccountHardLock?: boolean` in `src/types/config.ts`; `src/config.ts` parses optional boolean with malformed input treated as off. Persist through existing `saveConfigPreservingClaudeCode`; GET and PUT `/api/settings` return `codexMainAccountHardLock: config.codexMainAccountHardLock === true`. PUT rejects nonboolean input, captures presence/value, deletes when false, and restores exactly on save failure. Creation: settings PUT/hand-edited JSON; serialization: existing atomic config writer; deserialization: Zod loader; consumers: policy helper, account usability, native auth resolution, settings/main DTO, GUI in wp2. No new endpoint.

NEW `src/codex/main-account-hard-lock.ts`: shared policy leaf with named threshold 99 and status `{enabled:boolean, state:'off'|'unknown'|'ready'|'blocked', resetAt?:number}`. Read identity-bound quota only; never auth files, management imports or Lab. Owner steering in 013: use the 5h/short tuple when present, otherwise weekly, otherwise monthly-only; do not take the maximum across windows. Ignore the selected reading when its valid seconds-or-milliseconds reset is in the past, without falling back to another window. A finite >=99 observation with no reset remains blocked until a fresh observation lowers it; unknown/nonfinite data does not create a block. Additional model-specific windows do not become a global-main quota. No time-based expiry that silently admits still-exhausted main.

Status chain: creation in policy helper -> main DTO `mainAccountHardLock` in `auth-api.ts` and settings GET/PUT -> ordinary JSON -> optional typed `CodexAccountEntry.mainAccountHardLock` in wp2 -> main badge and setting description. Never include raw account IDs, credential fingerprints or secrets in status DTOs.

## Provenance, before/after

Existing `StoredAccountQuota` and its public DTO spreads remain unchanged. Extend the version-1 private quota disk envelope with optional main identity ownership, NOT each public quota object. Existing untagged snapshots remain usable by legacy rotation, but never by the new hard-lock getter. Avoid broad quota-scoring behavior changes in this feature.

MODIFY `src/codex/main-account-cache.ts`: add memory-only observed physical-main identity and credential equality observation, derived exclusively from token material already read under native ownership. Credential comparison uses a process-local keyed equality tag, never raw token retention/logging/persistence. Reuse the existing identity generation. Publish identity observation during existing `reconcileMainCodexAccountRuntimeState` read and confirmed native transition in `account-lifecycle.ts`; credential equality observation is captured only at existing owned token materialization/WHAM reads. No request-owned path reads the physical credential.

MODIFY `src/codex/quota.ts`:
```diff
-setAccountQuotaFromParsed(accountId, quota, writerGeneration)
+setAccountQuotaFromParsed(accountId, quota, writerGeneration, mainWriter?)
-applyAccountQuotaFromUpstreamHeaders(accountId, headers, writerGeneration)
+applyAccountQuotaFromUpstreamHeaders(accountId, headers, writerGeneration, mainWriter?)
```
`mainWriter` captures physical identity key and identity generation BEFORE the asynchronous request. For main, reject stale explicitly tagged writers; only merge ownership-matching main windows. Untagged writes cannot create or preserve policy trust. Hydrate before comparing/persisting ownership. Persist owner alongside quota. A new identity cannot bless old untagged windows through credits-only updates. New identity-bound getter returns null on missing/mismatched provenance without credential I/O. Pool writes/readers remain unchanged.

Durability is independent of the legacy six-hour rotation-cache TTL: use an optional envelope member `mainPolicyQuota: {identityKey:string, quota:StoredAccountQuota}` retained separately from the ordinary `quotas` map. Hydrate its bounded known window fields without the six-hour age discard. Retain it on unrelated persistence even if legacy main dropped from `quotas`; only an identity-matched new observation, explicit quota clear/identity transition, or untrusted main write can replace/invalidate it. Its getter still requires current observed identity equality. Reuse the existing window merge rule as one pure merger if necessary rather than maintaining two divergent partial-update algorithms. Do not carry untagged legacy values into `mainPolicyQuota`. Never persist credential equality tags. Future reset and missing-reset 99% observations remain protected across a restart beyond six hours; passed reset timestamps are ignored per-window by the policy predicate.

MODIFY `auth-api.ts` successful main WHAM path: derive writer from already-read `requestAccountId` and credential, capture before fetch, pass after existing identity revalidation. Its main DTO consumes the same status helper. Keep refresh/reauth semantics unchanged.
MODIFY `auth-context.ts` main-pool variant: carry captured `mainQuotaWriter` as internal request state; capture before async refresh/materialization, validate returned identity; never serialize it publicly. Stored Direct substitution must check policy after its existing identity-owned operation. No independent auth read is introduced.
MODIFY `src/server/responses/core.ts` existing writers at first quota rejection and ordinary upstream response, plus `src/server/responses/compact.ts` alternate-response writer: pass the captured main writer without recreating it from mutable global state.

## Routing and refusal

MODIFY `account-usability.ts`: before a physical main is selected, return false if the identity-bound policy blocks. This preserves ordinary alternate-account selection and prevents pins/fallback scores admitting blocked main. Do not add this to native-main-admission: maintenance must remain possible.

MODIFY `auth-context.ts`: enforce at every selected-main exit and immediately before credential use, including fixed selector, stored Direct substitution and request-owned main pin/fallback when the supplied bearer is positively matched to an already observed native credential. Unrelated/opaque/unmatched caller-owned credentials must not inherit physical-main quota; document that observation boundary. An unsigned account-id claim alone is not credential equality proof.

Use an actionable policy error that existing HTTP/WebSocket/sidecar error mapping preserves. Prefer a dedicated `CodexMainAccountHardLockError` compatible with the current cooldown hierarchy, with explicit main-policy message rather than falsely telling the user to clear upstream cooldown. It must not mint a recovery probe, auto-redeem a credit, mark reauth, or change paused state. Verify all catch sites via `CodexAccountCooldownError` search; special-case formatting once in its canonical formatter. Do not use the unused `assertCodexAuthContextNotCooled` as the only enforcement call site.

Actual final materialization seam: extend the existing options of `materializeCodexUpstreamAuth` and `materializeCodexUpstreamAuthAsync` with optional `config?: Pick<OcxConfig,'codexMainAccountHardLock'>`; supply the shared live config at all production calls in `src/server/responses/core.ts` and `src/server/responses/compact.ts`. Check after stored identity observation and immediately before returning the selected headers, including refresh replays. Legacy public callers that omit config retain compatibility; normal production call sites must never omit it. Sidecar resolvers already call `resolveCodexAuthContext` and are covered there; inspect whether they capture credentials across an await and require an additional pre-send guard.

Caller-owned positive matching requires both the process-local credential equality tag and the selected account identity to match the already observed native credential. A conflicting `chatgpt-account-id` header must not be treated as matching even with the same bearer. No unsigned JWT/header by itself creates a policy identity or writes a quota owner.

The equality observation tuple is `{bearerHmac,effectiveUpstreamAccountId,identityGeneration}`. WHAM provenance describes the actual account header sent with the owned token, not a conflicting JWT-derived account ID. If owned identity derivation and effective sent identity disagree or are unknown, do not publish hard-lock provenance; never fix this by trusting arbitrary incoming headers. The retained legacy rotation getter is intentionally out of scope: the no-cross-account guarantee here applies to the NEW hard-lock policy, not a claim to have redesigned all prior rotation state.

## Bypass statement

Tier: runtime local admission; executing surface: authenticated native forwarding and account selection. Known bypass: already admitted requests, direct upstream traffic, and an unmatched caller-owned credential that cannot be proved to belong to stored main without violating isolation. Residual: observed 99% does not reserve the remaining 1%. Wording: hard-lock of newly admitted identity-matched main requests, not an account-wide reservation. Final upstream enforcement: OpenAI remains authoritative; this patch does not claim to change its allowance or Reserve grants.

## Regression matrix (CI only)

Extend existing `tests/codex-integration/codex-auth-context.test.ts`, quota/parser or account lifecycle tests and an existing settings route test where practical; if a new focused file is clearer, register it in both layout manifests.

- Off/absent/invalid flag; 98.99 vs exactly99 vs100; short-only99; unknown/NaN; monthly-plan windows; custom-only window; seconds/ms expired reset; missing reset.
- A99 restart/B does not block B; same-A restart only trusts tagged ownership after observed identity; legacy untagged data is unknown; stale A writer after A->B->A rejected; partial/credits-only cannot cross provenance.
- Restart after six hours with same account and missing/future reset retains the block; unrelated pool persistence cannot delete retained policy evidence. Quota/config changing between selection and materialization is rechecked before a send. Same bearer with a different explicit workspace header is not classified as stored main.
- Eligible pool alternative continues; all-blocked/exact-main/Direct fail before upstream send; a same-token request-owned main is protected with zero physical reads; unrelated/spoofed bearer is unaffected and cannot taint policy provenance.
- Fresh lower quota/reset releases only policy; pause/cooldown/reauth survives toggle changes; quota refresh remains admissible.
- Settings GET/PUT acknowledgment, type rejection, false deletion, persistence rollback and no unrelated config loss.
- main DTO exposes status but never identity/equality tags.
- Existing core-Lab boundary remains intact.

## Verification

`bun run typecheck` already ran baseline exit0 after locked dependency install; tsconfig includes src. No local suites are authorized. Use exact-head CI for the above behavioral matrix and full regression suite. Main may use an isolated non-test-runner runtime scenario to inspect actual threshold activation only if it is not a disguised suite. Persist static/CI outputs in the unit evidence record before D. Update `structure/08_openai-provider-tiers.md` with the admission and caller-isolation contract.
