# wp3 — MiMo runtime fixes (diff-level)

1. `src/adapters/mimo-free.ts` (A-01, A-02):
   - The shared bootstrap runs with the timeout only (`fetchJwt()` without a caller signal).
   - `getMimoJwt(signal?)` returns `abortable(inFlightJwt, signal)`: a per-caller race that rejects with the caller's
     abort reason without cancelling the shared promise; cache still written only on success.
   - `buildRequest(parsed, incoming)` passes `incoming.abortSignal`.
   Tests (`tests/providers/mimo-free-provider.test.ts`): abort during initial bootstrap rejects promptly and sends no
   inference; two concurrent waiters, abort the first, the second still receives and caches the JWT. Both red before.
2. `src/adapters/command-code.ts:600` (A-03): gate becomes `/^xiaomi\/mimo-/i` on the canonical id.
   Test (`tests/providers/command-code-tool-text.test.ts`): captured order on `xiaomi/mimo-v2.5-pro` drops the echo
   (red before); a non-MiMo model keeps markup text untouched.
3. Cold-start decode (B-CAT-01): add a red test in `tests/providers/command-code-provider.test.ts` that routes
   `command-code/xiaomi-mimo-v2.6-pro` with an empty discovery cache. Only if red: seed the five MiMo ids in the Command
   Code registry entries through an existing model-keyed or `models` field; otherwise record "not reproducible".
4. Docs sync for these behaviours happens in wp4.

## Audit fold (gpt-6-sol 01a0cca0, NEAR-PASS)

- Abortable wait: reject immediately when the caller signal is already aborted; attach one `abort` listener and remove it
  when either the shared bootstrap or the abort settles; the shared promise always has a rejection handler so a bootstrap
  failure after every waiter left is not unhandled; cache is written only on success.
- Replace the existing test at `tests/providers/mimo-free-provider.test.ts:273` that asserts the caller signal reaches the
  bootstrap `fetch`; add cases: already-aborted caller, every caller aborts then the bootstrap fails (no unhandled
  rejection, next call bootstraps again), and a later successful retry.
- Cold-start decode, if red: seed decode ids through `modelContextWindows` on both Command Code entries with the live
  fixture's 1,048,576 windows for the V2.6 ids (a verified model-keyed fact), never the `models` roster; test the
  degraded catalog (no static roster rows appear) together with routing.
