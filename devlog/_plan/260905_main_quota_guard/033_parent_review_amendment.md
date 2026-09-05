# Parent review amendment: observed recovery, not a clock-only release

Maintainer Ingwannu requested changes on runtime headfe2e10e15. Accept the stricter interpretation of the owner's fresh0 recovery request. This supersedes the earlier expiry-retirement decision in013/031/032; do not retain contradictory user documentation.

## Runtime contract

MODIFY main-account-hard-lock.ts: a retained selected-window99..100 remains blocked after its reset timestamp. Do not turn it into unknown solely because time passed. Omit expired resetAt from the blocked DTO. A fresh observed value below99, including0, releases; missing/invalid readings retain existing protected evidence.5h priority remains unchanged and never falls back to weekly.

MODIFY auth-api.ts: add `runMainAccountHardLockRecovery(config)` to the EXISTING60s state-sweep afterTick registration. This creates no new periodic timer and is inert unless the flag is true and main is currently blocked. Skip existing reauth quarantine; coalesce concurrent calls in one bounded flight. Acquire the existing native-main runtime lease, obtain a valid stored token with the existing refresh machinery BEFORE acquiring the WHAM shared credential claim, then force a fresh owned WHAM read with `explicitRefresh:false`. Extend the private fetch attempt with an optional explicit-refresh override; normal/manual callers keep current defaults. Never acquire an exclusive token-refresh claim while holding the WHAM shared claim. Existing network bounds are30s credential refresh plus8s per WHAM attempt (at most one identity-change retry,46s total); native-claim setup retains its existing bounds. Release the runtime lease in finally and do not overlap a slow flight on a later tick.
Successful fresh quota updates release only the local99% policy; do not clear paused or unrelated cooldown state. A metadata200 must not clear a pre-existing reauth flag. Genuine terminal token-refresh failure may mark reauth to stop repeated bad-grant retries. Failed/unavailable quota reads retain the lock. No inference, credit consumption, new provider probing or account switching.

## Other review corrections

MODIFY quota.ts: hydrate before reading the existing merge base in both parsed and legacy writers. Reuse only the ordinary cache that survived its existing6h TTL; never repopulate it from policy-only evidence. Add cold partial-update regressions for both writer entrypoints.
MODIFY main-quota-provenance.test.ts: explicit fixture pending-timer clear/reset in afterEach, as requested. The production clearAccountQuota already cancels the same handle; this makes fixture ownership self-contained without changing production behavior.

## Verification and delivery

Update policy/window-observation expiry assertions to require retained block, followed by fresh0 release. Extend actual owned-WHAM tests for background recovery, disabled/no-block/reauth skip, coalescing, failed read retaining block, and preservation of other account restrictions. No local suites; source/test typechecks and exact-head CI.
Update structure and public English/Korean docs: while blocked, fresh quota is checked by the existing once-per-minute background cycle. Change prior expiry claims in unit notes to a superseded record, not an undocumented contradiction.
Commit this prerequisite on runtime PR3552, then cascade UI PR3560 and this unpushed Reserve plan branch with leases protecting remote heads. Run every resulting head's final CI before admin merge. Reserve implementation consumes this repaired base.
