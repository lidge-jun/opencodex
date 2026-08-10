# 045 — Fix #845: bound the blob-ID key channel (audit round 1 refuted the NOOP)

Date: 2026-08-02. Verdict after audit: **REAL FIX REQUIRED.** Payload-side is fully bounded (16 MiB/entry, 64 MiB aggregate, 4,096 entries, 15-min TTL, pins, typed errors — `native-exec.ts:79`/`:219`/`:351`/`:551`), but the audit found the key channel unbounded: a remote `blobId` of arbitrary length becomes an unbounded, uncounted `Map` key (`native-exec.ts:219`, `:551`). ~16 MiB raw ID → ~32 MiB hex-expanded key × 4,096 entries ≈ 128 GiB of pure key strings (audit round 2: hex doubles byte length).

Placement correction (audit round 2): `setBlob` receives the ALREADY-EXPANDED hex string — the huge allocation happens in `key(blobId)` (`native-exec.ts:331`) BEFORE admission. Validate/digest the RAW bytes before hex conversion, at the same boundary.

Accounting correction (audit round 2): do NOT fold key bytes into the existing `blobBytes` payload counter — that would silently shrink the promised 64 MiB payload cap and break exact-byte tests. Add a SEPARATE fixed key-bytes counter reported alongside (fixed per-entry key cost once IDs are bounded/digested), so the 64 MiB payload contract is preserved byte-for-byte.

## File map

- MODIFY `src/adapters/cursor/native-exec.ts`
  - Admission boundary (`key(blobId)` at :331, BEFORE hex expansion — audit round 2): validate the raw blob ID bytes before conversion. Contract: conforming content-hash IDs (hex, fixed length — confirm the exact shape Cursor emits at P) pass through unchanged; anything else is either (a) rejected typed (`blob_id_invalid`/`blob_id_too_large`) or (b) stored under a fixed-size derived key `sha256(id)` with the raw ID never retained. DECIDE at P by checking what IDs the live protocol actually carries — prefer (a) reject when IDs are provably always content hashes (fail-closed, no aliasing); fall back to (b) digest only if arbitrary IDs are legitimate. Either way, retained key bytes become fixed-size and counted.
  - Lookup paths (`getBlobArgs`, hydration, scope pins) apply the SAME key derivation, or lookups miss (audit: key-derivation asymmetry between store and lookup is the primary regression risk).
  - Account key bytes in the store's byte accounting (snapshot `bytes`/`evictableBytes`), so the framework sees them.
- MODIFY `tests/cursor-blob.test.ts`: new regressions (below).

Scope OUT: the payload-side design (unchanged), true access-LRU (policy nicety, not a leak), the accepted residual (remote post-seal `setBlobArgs` TTL-only protection — matches PR's own limitation).

## Acceptance + activation scenarios

1. Oversized/non-conforming blob ID with tiny data: the ID is validated/digested from RAW bytes before hex expansion; retained key bytes stay fixed; the raw ID string is NOT reachable from the store's internals. Activation: fixture with a ~1 MiB ID asserting rejection (or fixed internal key) + no hex-expanded key allocation (red on pre-fix tree — raw ID is hex-expanded into the key).
2. Aggregate: 4,096 oversized-ID admissions cannot grow retained key bytes beyond the fixed bound; the 64 MiB PAYLOAD cap and its exact-byte tests are unaffected (separate counter). Activation: loop fixture with key-bytes ceiling assertion + existing exact-byte tests green.
3. Store→lookup symmetry: a conforming (or digested) ID round-trips: set then getBlobArgs returns the data. Activation: round-trip test for every accepted ID class.
4. Existing pin/scope/rollback suites stay green (`cursor-blob.test.ts:731-1141`, `cursor-live-transport.test.ts:164`).
5. Red-green: #1 red on the pre-fix tree.
