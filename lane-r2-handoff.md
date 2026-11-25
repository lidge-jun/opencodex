# Lane R2 handoff — catch-up phase 040a (G-013, G-016, G-012)

Worktree: /home/ubuntu/.goat/worktrees/opencodex/lane-r2-phase040a-0a9ea431d3d748c6
Branch: lane/r2-phase040a (base dev 9e0e298ef, same commit the 040 spec was written against). Not pushed.
Spec: devlog/_plan/261123_proxy_upstream_catchup/040_pool_scheduling_egress.md (on dev since #9106, 49554a1221).

## Status

- Source changes: none yet. This branch has only this note.
- G-013: design finished and anchors checked on current dev; implementation not started.
- G-016: not started.
- G-012: not started. It is security-boundary: open the PR, get a Terra security review, report it, do not merge.

## Verified (read-only, on 9e0e298ef)

Nothing was built or tested. These anchors were read and confirmed:

- src/providers/api-key-cooldowns.ts (49 lines): a process-local Map keyed by provider\0keyId holding {cooldownUntil}.
  It exports setKeyCooldown, isKeyInCooldown, getKeyCooldownUntil, sweepExpiredApiKeyCooldowns, clearKeyCooldowns(provider?).
- setKeyCooldown is called only from src/providers/key-failover.ts, at :841 (recordDistributedKeyFailure, where entry.key is in
  scope) and :939 (rotateKeyAfterFailure, where failedKey is in scope as the key reference).
- clearKeyCooldowns (manual key management) is called from provider-routes.ts:1015,1121, api-key-pause.ts:78 and
  oauth-account-routes.ts:1293,1350,1382.
- src/lib/state-store-registrations.ts:131 registers "api-key-cooldowns" with sweepExpired only. Its setLiveStateStoreConfig (:84)
  is the one place the live config is installed and has a single caller, src/server/index.ts:237. index.ts is at its
  file-size cap, so do not add lines there. reconcileLiveStateStores runs on provider writes and reload.
- tests/oauth/state-store-sweeper.test.ts:130 pins the registration name list. Adding a reconcileGeneration to the existing
  entry does not change that list.
- Precedent store: src/combos/cooldown-store.ts (PersistedCooldownMap, file combo-cooldowns.json). It loads lazily per config
  dir, flushes after a 250 ms debounce under withConfigMutationLockSync, merges with the disk copy keeping the later expiry,
  writes tombstones only for explicit clears, backs off on a busy lock, and has a bounded flushForShutdown.
- The key fingerprint precedent is in src/adapters/anthropic/per-message-effort.ts:41: an API key's only generation is a hash
  of the key itself.
- The KEY_GENERATION and cache-affinity-identity HMAC keys are random per process, so they cannot serve as a persisted
  generation.

## G-013 design (ready to implement)

1. src/providers/api-key-cooldowns.ts
   - Map value becomes {cooldownUntil, generation?}.
   - Add apiKeyCooldownGeneration(provider, keyId, credential): sha256 over "ocx-api-key-cooldown/v1\0provider\0keyId\0credential",
     truncated to 24 hex characters. It is unsalted on purpose: a per-file salt races between processes sharing a home.
   - setKeyCooldown(provider, keyId, until, credential?) computes the generation. A different generation replaces the prior
     hold instead of max-merging with it. When persistence is attached and a generation exists, it records the row.
   - Expiry checks and sweeps are local-only and never write.
   - clearKeyCooldowns(provider?) also calls persistence.clear(provider?). This matters: without it, a manual clear
     comes back after a restart.
   - Add attachApiKeyCooldownPersistence(p), restoreApiKeyCooldowns(rows, currentGeneration) and
     reconcileApiKeyCooldownGenerations(providers). The reconcile drops an entry when its stored generation no longer
     matches the current key of that pool entry.
   - Import only types from the store module, to avoid an import cycle.
2. New src/providers/api-key-cooldown-store.ts
   - File api-key-cooldowns.json: {version:1, rows:[{provider, keyId, generation, cooldownUntil}]}, nothing else.
   - Mirror the combo store's semantics: debounced flush under withConfigMutationLockSync; dirty rows overlay the disk copy
     (same generation keeps the later expiry); provider clears and clear-all are applied to the disk rows first; on a
     busy lock, back off and retry; flushForShutdown registered through registerOptionalShutdownHook("api-key-cooldowns", ...).
   - installApiKeyCooldownPersistence(config) binds the store to getConfigDir(), loads rows that have not expired, and keeps
     only those whose generation matches config.providers[p].apiKeyPool entry {id,key}.
3. key-failover.ts: pass entry.key at :841 and failedKey at :939. Also fix the ANTHROPIC_BILLING_COOLDOWN_MS comment
   ("The hold is in memory"). key-failover.ts is 1084 lines; check tests/fixtures/file-size-baseline.json before
   adding lines.
4. state-store-registrations.ts: call installApiKeyCooldownPersistence(config) inside setLiveStateStoreConfig, and add
   reconcileGeneration: () => reconcileApiKeyCooldownGenerations(liveServerConfig?.providers) to the existing entry.
   The store is installed only by a running server, so unit tests that use the bare functions stay in memory.
5. Tests: new tests/providers/api-key-cooldown-store.test.ts covering:
   - restart restores an unexpired cooldown;
   - an expired row is ignored;
   - a replaced key under the same id is not cooled;
   - a manual clear persists;
   - two processes sharing a home merge their rows.
   Register the file in scripts/test-layout/layout.json (or its domain shard) and a tests/fixtures/test-layout-expected*.json
   shard. Regressions to run: tests/adapters/key-failover.test.ts, tests/server/server-key-failover-e2e.test.ts,
   tests/oauth/state-store-sweeper.test.ts.
6. Docs:
   - structure/providers-and-adapters.md (owner of src/providers/) needs a key-cooldown persistence paragraph.
   - In docs-site/src/content/docs/reference/configuration/providers.md, near the apiKeyPool row (:369) or the round-robin
     paragraph (:512), state that API-key cooldowns survive a restart until expiry while the key is unchanged.
   - Leave :1365 alone; it describes generic OAuth, which stays process-local.

## Remaining

- G-013: implement the design above, then run typecheck, test:changed, structure:check and privacy:scan. Get a Terra review,
  open the PR, wait for green CI, then merge through the maintainer-integration path (assert-mergeable-review.sh
  --maintainer-integration, an evidence comment, gh pr merge --squash --admin --match-head-commit).
- G-016: new src/server/management/account-diagnostics-routes.ts returning per-account {eligibleModels, lastRefresh{at,ok,reason},
  cooldownUntil, inFlight}, with no email or tokens. Use the same auth gating as its sibling routes. API-key cooldownUntil is
  already available through getKeyCooldownUntil (see provider-key-pacing-routes.ts:15). Not yet investigated: the
  OAuth refresh-result source and the inFlight source.
- G-012: account egress through resolveProviderEgress (src/lib/provider-egress.ts:160), egressFor
  (src/server/responses/fetch-helpers.ts:362), and refresh/quota outbound. Also a new src/types/pool-account.ts.
  src/types/config.ts is at 1939 lines with 60 lines of headroom. Not investigated. Security review plus a report;
  do not merge.

NOT RUN: typecheck, any test, structure:check, privacy:scan. No source code changed.
