## Status

Implemented Task 4 CCA request fidelity.

## Files changed

- `src/adapters/google-antigravity-tools.ts`
- `src/adapters/google.ts`
- `tests/google-antigravity-wire.test.ts`
- `tests/google-adapter.test.ts`
- `.superpowers/sdd/task-4-report.md`

## Test

`bun test tests/google-antigravity-wire.test.ts tests/google-adapter.test.ts tests/google-empty-content.test.ts` — 88 passed, 0 failed.

`bun run typecheck` — passed.

## Behavior

- Claude CCA sends the interleaved-thinking beta header.
- CCA requests include the system-instruction replacement preamble.
- Claude trailing model prefills are stripped while lone model turns remain.
- Orphan tool results and assistant calls without later results are removed before allocator prepass; valid parallel pairs remain intact.

## Concerns

- The full repository test suite was not rerun; validation used the requested focused adapter tests and strict typecheck.
- Task 5 transport behavior remains intentionally untouched.
