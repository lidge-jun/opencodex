# 020 — Verification evidence (morph_ultra_provider)

Recorded during B. The implementation itself landed before this cycle's B baseline was captured,
so this doc carries the check evidence that B produced rather than a second source delta.

## What was verified

- `bun run typecheck` -> exit 0.
- `bun run structure:check` -> exit 0 (structure/providers-and-adapters.md held at its 600-line budget).
- Focused suites with the pinned runner
  (`OCX_TEST_RUNNER_BUN=/Users/jun/ocx-batch-bun/bun`): morph-ultra-provider (14), provider-registry-parity,
  docs-provider-preset-counts (18), test-layout, test-layout-tooling, file-size-ratchet,
  structure-ssot, usage-cost -> 274 pass, 0 fail.
- Full `bun run test` -> 4 distinct failures, none in a file this change touches:
  - `release version line > the in-tree version is never behind a released one` — package.json is
    2.84.0 while the tag set reaches v2.100.2. Reproduced on an unmodified HEAD checkout.
  - `connected Desktop uses hub IDs across a cold restart (stored profile=false)` — model ordering
    differs from the expectation. Reproduced on an unmodified HEAD checkout.
  - `package tree integrity > ... the installed guard reads process.execPath as the runtime` and
    `live audio readiness ... cannot claim readiness` — 5s timeouts under the parallel suite; both
    pass standalone on this tree and on HEAD.

## Reviewer rounds

Round 1 (fail) found three blockers, all fixed and re-verified in round 2 (pass):
1. `reasoning_effort: "none"` was dropped, which Morph reads as reasoning on. Fixed with identity
   map entries for both models plus adapter-body tests.
2. Registering `morph` retargeted an existing custom provider of the same name. Fixed with
   `preserveCustomDestination: true` plus a routing regression.
3. `scripts/test-layout/layout.json` reached the 2000-line threshold. Fixed; back to 1999.
