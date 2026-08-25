# 010 — wp2/wp3 merge train remainder

Landed already (verified locally, focused suites green, admin-squashed onto dev):
#2528 (7cf041cf7), #2555 (70eb01d19), #2532 (fea4538d5), #2515 (6c4556cfb),
#2474 (b33d82dc3), #2550 (e42778adc).

## Remaining in this decade

### #2563 — Cursor ref-less checkpoint ownership
Head moved to `f7892785` after the lane report and the PR returned to draft, which
resets the contributor readiness checklist by design. The code at head `93057665` was
verified locally: `bun test tests/cursor-request-builder.test.ts` → 49 pass.
Action: re-verify the NEW head, then merge. The one unresolved CodeRabbit thread asks
for broader ja/ translation parity on a pre-existing doc and is not a correctness
blocker.

### #2503 — xAI verbosity
53 commits behind dev, and the lane found the fix incomplete: an explicit
`supportsVerbosity: false` is lost through combo derivation
(`src/codex/catalog/aggregation.ts:173`) and trusted replacement rows
(`src/codex/catalog/provider-fetch.ts:2147`), and live-discovered xAI/Kiro ids can
still advertise verbosity because `modelRecordValue` has no provider-wide fallback
(`src/reasoning-effort.ts:83`).
Action: rebase onto dev, add the conservative false through both derivation paths plus
a provider-wide fallback, extend `tests/codex-catalog.test.ts`.

