# 020 — Fix #841: Responses state admission boundary (direct-spill oversized, bounded snapshot read, bounded replay)

Depends on: 001 root-cause delta. NOT a redo of wave-1 (`d1408b92f` hard cap + spill already landed).

## P re-verification note (2026-08-02, wp2 cycle — supersedes details below where they conflict)

- `byteCap()` (64 MiB default, `MAX_STORED_RESPONSE_BYTES`) is the TOTAL resident-map cap, not per-entry. "Oversized candidate" = `candidate.sizeBytes > byteCap()` — it can never fit as resident even alone.
- `expected?.kind === "spill"` already direct-spills atomically via `replaceSpillEntryAtomically` (`state.ts:212`) with deferred old-generation unlink — the new branch REUSES it for oversized candidates; scenario 8b's machinery exists.
- Single constant decision: `MAX_RESPONSE_SPILL_PAYLOAD_BYTES = 256 MiB` in `spill-store.ts`, used BOTH as direct-spill admission ceiling and replay read ceiling (candidates above it are tombstoned at admission with `admissionCounters.oversizedDrops` — retaining an unreadable spill would be write-only waste). 256 MiB bounds the replay transient under the 512 MiB `APP_OWNED_WORST_CASE_PINNED_BYTES` ceiling. This replaces the earlier "recommend the same 64 MiB" line, which contradicted direct-spill preservation.
- `readResponseSpill` already verifies `stat.size === ref.payloadBytes`; the new `too_large` reason is checked on `ref.payloadBytes` BEFORE any read. Wire-safe: `core.ts:1188` maps every replay failure to the same 400 `previous_response_not_found`; the internal reason union gains `spill_too_large`.
- Snapshot file ceiling: `SNAPSHOT_FILE_MAX_BYTES = 32 MiB` (> 24 MiB write bound), checked via `statSync` before parse; refusal recorded in a test-visible counter.
- Test hooks available: `setResponseStateByteCapForTests`, `setSpillIoForTest` (write-failure injection), `noteStubSwapForTest`. A payload-ceiling override for tests is added alongside the new constant.

## File map

- MODIFY `src/responses/state.ts`
  - `setResidentEntry()` (~:243): before `replaceMapEntry()`, when `candidate.sizeBytes > byteCap()`, write the candidate DIRECTLY to spill and atomically install only its measured stub. Never insert the oversized candidate as resident; never demote unrelated residents to make room for it.
  - `ensureLoaded()` (~:453): bound the snapshot file read — `statSync` first, refuse (or truncate-refuse with typed error + quarantine) a `responses-state.json` above an explicit ceiling (recommend 32 MiB, above the 24 MiB write bound). Enforce direct-spill/reject for oversized resident rows BEFORE map admission in `loadSnapshotEntry()` (~:301).
  - `writeBoundedSnapshot()` (~:485): use `Buffer.byteLength(value, "utf8")` instead of `.length` for the 2 MiB/24 MiB limits.
- MODIFY `src/responses/spill-store.ts`
  - `readResponseSpill()` (~:307): reject `payloadBytes` above an explicit replay ceiling BEFORE read/parse (recommend the same 64 MiB as the store cap), typed error `spill_payload_too_large`; the continuation then fails as a structured `previous_response_not_found`-class miss rather than an unbounded allocation.
- MODIFY `tests/responses-state.test.ts` — new regressions (below).

Scope OUT: changing TTL (1h), count cap (1,000), stub/tombstone semantics, Windows ACL/fsync behavior, `previous_response_not_found` wire shape.

## Acceptance + activation scenarios

1. Oversized candidate (sizeBytes > cap) with two unrelated small residents present: candidate lands as spill stub only; both unrelated residents remain resident (not demoted). Activation: test asserting map contents + stub presence + spill file exists; replay of the stub still works.
2. At-cap-minus-epsilon candidate: admitted resident as today. Activation: boundary test.
3. Externally oversized snapshot file (> ceiling): load refuses with typed error, process starts with empty state, no giant parse allocation. Activation: fixture writing a >ceiling `responses-state.json` in a temp config dir.
4. Oversized spill payload on disk: replay rejects typed before read; no unbounded allocation; error surfaces as structured continuation miss. Activation: fixture spill file over the replay ceiling.
5. Multibyte snapshot: entries whose UTF-8 bytes exceed 2 MiB but whose `.length` does not are now correctly excluded from snapshot output. Activation: multibyte fixture + byte-length assertion.
6. Red-green: each new test fails on the pre-fix tree (verify at least #1, #3, #4 red first).
7. Direct-spill WRITE FAILURE for an oversized candidate: bounded tombstone installed, candidate never resident, unrelated residents untouched. Activation: fault-injected spill write (chmod/readonly dir or mock) asserting tombstone + resident map unchanged (audit round 1 gap).
8. Same-ID replacement: an oversized candidate replacing an existing resident ID installs the stub and unlinks the old generation in the existing deferred order. Activation: replace-then-crash-ordering fixture (audit round 1 gap).

## Typed observability (audit round 1 blocker — current contracts swallow the new outcomes)

- Snapshot load errors are swallowed today (`state.ts:453` catch-all) and spill reads expose only `missing | corrupt` (`spill-store.ts:48`). The new outcomes need INTERNAL reason seams, not wire changes: extend the spill-read reason union with `too_large` (still surfaced upstream as the existing structured continuation miss), and record snapshot-load refusal as a typed metric/log (`snapshot_oversized`) plus a test-visible reason. No response-shape changes.

## Regression risks (watch in C)

- Continuation misses if direct-spill breaks same-ID crash consistency or deferred old-generation unlink ordering.
- Stubs must stay NON-evictable in `responseContinuationRetainedStoreSnapshot()` (counted as pinned) or the shared budget spins.
- v1/v2 snapshot compatibility; provider continuation metadata replay.
