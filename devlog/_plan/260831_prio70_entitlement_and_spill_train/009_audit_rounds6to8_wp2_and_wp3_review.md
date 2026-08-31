# 009 — audit rounds 6-8: wp2 plan, and the wp3 implementation review

Two independent sol-high reviewers, both read-only. Recorded together because they
ran concurrently.

## wp2 plan — rounds 6, 7 and 8 (all FAIL, all folded into `020`)

**Round 6.**

1. The whole-ensure flight was underspecified: a bare `{ startedAt, promise }` can
   cross-answer different candidate sets, client versions or credential epochs, while
   the per-entry dedup it wraps is keyed by account, identity and version
   (`:524-552`). Fixed by giving the flight a real key.
2. The mutation-hook set was still incomplete: `native-profile-manager.ts:1307`,
   `:1335`, `:1449` write canonical `auth.json` during switch, rollback and recovery
   (transitions at `:1318`, `:1453`). These are OpenCodex's own writes, so they belong
   in the epoch.
3. The two wait policies could not be expressed by `ensureCodexEntitlementFreshness(config)`
   as written, because sidecar reaches the same `listManagementModelRows`
   (`src/sidecar/candidates.ts:40`). Needs an options path.
4. The credential-read regression was **false-green**: "zero token refreshes and zero
   fetches" is already satisfied today while the full credential snapshot still runs
   (`:592-601`). Must assert zero `accountCredentialSnapshot` calls.
5. The negative-memo TTL was never pinned, and "converges within one 5s cycle"
   contradicted the acknowledged 30s credential refresh.

**Round 7.**

1. The epoch alone cannot fence external `auth.json` writers — the document says so
   itself — so a caller holding a new identity could still join an old-identity
   flight. The flight key now carries the identity vector
   `(accountId, credentialIdentity | null)`.
2. The negative memo could still be published against a login that landed mid-flight.
   Publication is now fenced on the captured identity vector, and expiry is measured
   from the **absence observation**, not from settlement — a flight that spent 30s in
   a credential refresh must not hand out evidence that is treated as 5s fresh.

**Round 8 (final).**

The key still omitted the **workset**. Candidate set, version, epoch and identities
can be unchanged while an entry expires mid-flight: a flight that started when B was
fresh refreshes only A, B expires, a second caller computes the same key and joins,
and the resolver's `now` is fixed from flight start (`:586`) so B stays a cache hit
(`:517-522`). `ocx export` — the surface #3023 actually reported — then returns short
rows having refreshed nothing. The key now includes normalized
`needsRefreshAccountIds`, or joining requires a subset relationship.

wp2 is planned but **not implemented**. The document is now implementable; the work
itself is the next cycle.

## wp3 implementation review — FAIL, one high finding

Reviewed commit `135f22932` (on top of Ingwannu's `aec717722`).

**Confirmed correct, no change needed:** drain ordering before the 2 MiB snapshot
exclusion (`state.ts:1236-1247` vs `:1133`); the stable-fixed-point loop with no bare
`Promise.race` (`:443-450`); the budget split `B=5000`/`R=4000` with the fallback
receiving `R`; the shared ACL deadline reaching both the directory and temp hardeners
(`spill-store.ts:197-227`, `:440-452`); test 2c's six `icacls` calls and its
max-timeout assertion, which would genuinely detect a fresh 30s window. No
MUST-NOT-CHANGE violation, no payload or token logging.

**HIGH — the abandoned writer can still publish, and can orphan a temp.** The async
writer creates and fills its temp *before* awaiting file ACL hardening
(`spill-store.ts:505-511`). At cap expiry the fallback marks the job cancelled and
drops its tracking (`state.ts:417-422`) but takes no ownership of that temp; the drain
returns (`:446-448`) and shutdown exits (`management-api.ts:278-280`,
`cli/index.ts:365-370`). A resuming writer publishes *first* (`spill-store.ts:515-529`)
and only then hits the cancellation check (`state.ts:257-260`). State overwrite
prevention is airtight; filesystem publication and cleanup are merely narrow. The
commit's own test encoded the violation as expected, asserting **two** publications
(`tests/responses-state.test.ts:999-1000`).

**MEDIUM — the fixed point has no regression behind it.** The shutdown tests queue a
single job (`:823-891`), so a one-shot tail await would pass them. The loop is right;
nothing proves it stays right.

Both sent back for repair before wp3 lands.

## Residual risk carried

A real Windows host is still needed to prove NTFS inheritance, `icacls` timeout
behaviour, and unlink semantics while `icacls` holds a path. Everything above was
exercised through the repository's injected Windows/ACL runners.
