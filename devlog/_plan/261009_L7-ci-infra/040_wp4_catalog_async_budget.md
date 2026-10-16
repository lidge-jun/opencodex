# 040 — wp4: #6723 runtime — async catalog probes and budget release on abort

PR title: `fix(runtime): keep catalog probes async and release aborted translator budgets`
Branch `codex/l7-catalog-async-budget`, worktree `.tmp/lanes/L7-ci-infra-4`, after wp1.
Credit: `Co-authored-by` mashfromband (commit identity from the source PR). Refs #6671.

## File change map (from #6723 head `9149843fc6`)

| Path | Change |
| --- | --- |
| src/codex/runtime.ts | cancellable bounded subprocess executor (:493), selection identity (:839), guarded async persistence (:1159) |
| src/codex/catalog/bundled.ts | async bundled loader (:357), 45 s flight deadline (:413), same-selection snapshot, single flight, backoff |
| src/codex/catalog/effort.ts | observed clamp reads the runtime snapshot (:564-568) |
| src/codex/catalog/retained-sync.ts, src/codex/catalog-auto-refresh-sources.ts | consumers of the async API |
| src/lib/translator-budget.ts | disposed guards against late reservations/calls/charges (:194, :214, :227, :249, :287); shared finalizer with abort observer |
| src/server/chat-completions.ts, src/server/claude-messages.ts, src/server/responses/core-lifetime.ts, src/server/responses/core.ts | pass the request signal to the shared finalizer; `core.ts` must not grow (cap 210) |
| tests/codex-integration/catalog-auto-refresh-scheduler.test.ts, catalog-slug-uniqueness-boundary.test.ts | adapt to the async API |
| tests/providers/kiro/kiro-leased-responses.test.ts, tests/responses/responses-compaction-recovery.test.ts | #6723 timing adaptations, kept only if the focused run shows they are required |
| structure/catalog.md, structure/data-planes/inbound-compat.md, structure/runtime.md, structure/transports/byte-accounting.md, structure/transports/responses.md | product hunks only; no workflow sentences and no `async_contracts.rs` references (both go to wp5); three of these docs are exactly at their 600-line budget |
| docs-site/src/content/docs/troubleshooting/windows-memory.md | catalog liveness wording; do not claim #6671 is solved |

## Regression coverage (Bun, so CI runs it without the wp5 workflow)

#6723's reviewer accepted Rust contracts in place of Bun suites. Since the Rust crate lands
only with wp5, wp4 must carry Bun equivalents for the behaviors those contracts check:
abort before/after wrapping, unread body abort, held producer cancellation, late
reservation/charge after disposal (counters stay zero), selection change rejects late
persistence, shared-flight cancellation isolation, bounded retries. P of wp4 decides
whether they extend `tests/adapters/translator-budget.test.ts` and the catalog runtime tests
or need a new sibling file (then register it in both layout tables). The list must also
cover: prepared 200/499/504 responses keep status and headers; EOF, metadata and response
markers are preserved; catalog input/epoch invalidation, the 45 s flight deadline and
bounded backoff. Each new assertion gets old-code activation proof (red on dev) in B.

## Risk

#6723's full fork CI at `9149843fc6` failed six jobs (macos control, macos 2/2, test 2/4,
windows 3/9, 5/9, 9/9; run mashfromband/opencodex 37863222160). P of wp4 must reproduce the
failing tests on the carry branch before building and treat any product-caused failure as a
blocker.

## Acceptance

- Focused: the translator-budget, catalog scheduler/slug/runtime, Responses/Chat/Messages
  abort tests touched, `tests/lab/core-lab-boundary.test.ts`, typecheck, structure, privacy.
- Hosted: exact-head CI green on all platforms.
