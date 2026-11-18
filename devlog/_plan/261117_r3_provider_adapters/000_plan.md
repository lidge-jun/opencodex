# R3 provider adapters — triage-to-merge round 2026-11-17

Lane R3-provider-adapters, branch `triage/r3-provider-adapters`, base `origin/dev`
`c36793a9336b70cfe5bc3b7f6e6f751e730fb6fc`. One lane PR to `dev`; the coordinator merges.

## Triage (verified against the base above)

| Item | Class | Evidence | Reason |
|---|---|---|---|
| #8792 | MERGE-READY | head `fd12d96ea11c`, approved, `ci`/`gates`/`test changed` green on that head; merged with #8756 onto the base: 203 focused tests, typecheck, structure:check pass | Narrow wording change; fixes #8772 |
| #8756 | MERGE-READY | head `ab44461d3fcf`, approved, `ci` green on that head, mergeState CLEAN; same union check | Measured Kiro keyword list |
| #8703 | CARRY | draft, no `ci` run on head `378118c182`; applies clean on the base (the #8590 conflict was already resolved by the author) | Needs CI and readiness; Closes #8558 |
| #8827 | CARRY | draft by its author only because the local docs build timed out; `ci` (including docs site build) green on head `f5dd31fa73`; applies clean | Closes #8702 |
| #8591 | CARRY | no `ci` run on head `7e10e16aed`; earlier change requests addressed and dismissed; applies clean | Needs a CI run on current dev |
| #8861 | CARRY (partial scope) | no `ci` run on head `6261164137`; applies clean | Continuation-effort bug fix carried; the catalog-ladder hunk (removes the effort control from a JEV Combo row) is a UX change and stays out, as the author offered |
| #8856 | DEFER | 21 files, protocol switch for every generated OpenCode config, no CI, touches `config-export.ts` | Product decision: move OpenCode Connect from Chat to Responses per model |
| #8829 | DEFER | draft, two open CodeRabbit findings (audio attachments) | Superseded by #8856 by its own author; same product decision |
| #8702 | CARRY via #8827 | — | — |
| #8772 | MERGE-READY via #8792 | — | #8792 does not say `Closes #8772`; the coordinator closes it after merge |
| #8558 | CARRY via #8703 | — | — |

## Constraints

- `structure/providers-and-adapters.md` sits at exactly the 600-line structure budget; any edit there must be line-neutral.
- `tests/codex-integration/codex-catalog.test.ts` is 7977 lines against a cap of 7985; the excluded #8861 catalog case would add 20, and the carried scope does not touch the file.
- New test files need `scripts/test-layout/layout.json` and `tests/fixtures/test-layout-expected.json` entries.
- Each carried PR keeps its author as `Co-authored-by` on its commit.

## Audit

Roadmap audit round 2 (Morph DeepSeek, `morph/morph-dsv41flash-1017`, high): GO-WITH-FIXES, one blocker (the #8591 `$ref` composition loss), folded as amendment A1 in 030. Round 1 stalled on a provider call and was cancelled.

## Work phases (dependency order: disjoint files, smallest risk first)

1. wp1 — [010_devin_8703.md](010_devin_8703.md)
2. wp2 — [020_opencode_go_8827.md](020_opencode_go_8827.md)
3. wp3 — [030_command_code_8591.md](030_command_code_8591.md)
4. wp4 — [040_jev_8861.md](040_jev_8861.md)
5. wp5 — [050_verify_publish.md](050_verify_publish.md)

The carries touch disjoint files, so order only matters for commit history.
