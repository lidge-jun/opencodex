# 050 — Fix #843: Antigravity replay fixed-size key identities + transient canonicalization bound

Depends on: 001 root-cause delta. Caps/TTL/sweeper already landed (`034d320b8`); this closes unaccounted key bytes and the transient canonical-JSON allocation.

## File map

- MODIFY `src/adapters/google-antigravity-replay.ts`
  - `replayKey` (:57): SHA-256 hex over LENGTH-PREFIXED UTF-8 components (`len + ":" + model`, `len + ":" + sessionId` concatenated) — fixed 64-char outer key regardless of input length. (Audit round 1: NUL separators are collision-ambiguous — `("a\0b","c")` vs `("a","b\0c")`.)
  - `functionCallKey` (:61/:70): same treatment for `functionName` + canonical args.
  - Transient bound: bounded recursive/streaming canonicalization that rejects over-budget input DURING the walk (audit round 1: a `JSON.stringify` size precheck would itself allocate the temporary we are avoiding). Preserve canonical-form equality semantics the existing tests rely on.
  - Test seam: expose a test-only key-derivation hook (audit round 1: `snapshot.bytes` excludes outer keys, so the fixed-key regression cannot go red through that metric — assert on derived keys directly).
  - PRESERVE: `ReplayCall.touchedAtMs` LRU, exact deletion accounting, `antigravityReplayRetainedStoreSnapshot`, centralized sweeper registration, shared-budget call, TTL-refresh-on-duplicate-observation (native semantics, recorded decision in 001).
- MODIFY `tests/google-antigravity-replay.test.ts`: new regressions (below).

Scope OUT: TTL value (1h), the existing numeric caps (10,240/256/2 MiB/64 MiB/64 KiB — PR #843's 32 MiB global is SMALLER than native 64 MiB counted; keep native since keys become fixed-size and counted bytes already cover payloads), Claude bypass behavior.

## Acceptance + activation scenarios

1. Enormous model/session identities (e.g. 1 MiB strings): the derived outer key is exactly 64 hex chars and the raw identity strings are not retained as keys — assert via the test-only key-derivation seam, NOT `snapshot.bytes` (audit round 1: that metric already excludes outer keys, so a bytes assertion cannot go red). Activation: fixture with 1 MiB model + session IDs asserting derived-key shape and internal map keys (red on pre-fix tree — raw strings ARE the keys).
2. Worst-case pinned-cap accounting (audit round 1): the pinned-cap test must cover KEY storage, not payload constants alone — after fixed keys, worst-case key bytes = 10,240 sessions × 64 chars (+ 256 calls × 64 chars/session) and fits the documented ceiling. Activation: updated worst-case test.
3. Functional matching unchanged: observe-then-apply with identical calls still replays; nested canonicalization equality preserved. Activation: existing :23 tests stay green (hash mismatch between observe/apply would break these).
4. Length-prefix unambiguity: `("a\0b","c")` vs `("a","b\0c")` derive DIFFERENT keys; equal inputs derive equal keys. Activation: collision-fixture test.
5. Oversized arguments rejected typed DURING the canonicalization walk — no full-size temporary string materializes. Activation: large-argument fixture with allocation-guard assertion.
6. Eviction still returns exact released bytes (shared-budget eligibility preserved). Activation: existing budget-eviction tests stay green.
7. Red-green: #1 and #4 red on the pre-fix tree.

## Regression risks (watch in C)

- Any hashing mismatch between observe and apply breaks replay → upstream signature errors (covered by #2, but watch e2e-style replay tests).
- Do not change duplicate-observation TTL refresh (recorded decision).

## Implementation-phase accepted residuals (2026-08-02, wp6)

- Canonicalization transient is O(total key count + cap), not O(cap): `Object.keys` materializes the full key array of a wide object before the count check can reject it (there is no streaming key API in JS). Sorting and value-walking past the 16,384-key guaranteed-overflow bound ARE eliminated. Recorded after three audit rounds; the cap still bounds every RETAINED byte.
- Key hashing is injective at the ENCODING level (length-prefixed UTF-16 code units); SHA-256 collision space is cryptographic, not deterministic — stated for precision after reviewer correction.
