# wp1: evidence-driven effort-family grouping

Depends on existing AntigravityAvailableModel and generation-fenced mapping contracts; no new persisted schema.

## File change map

- MODIFY `src/providers/antigravity-models.ts`: replace bundled-membership requirement for low/medium/high triples with validated complete-family evidence; use the same predicate for parsing and effort map construction. Keep explicit irregular maps and known single `-tiered` handling. Choose stable medium default for a newly discovered complete family; preserve saved suffix IDs and legacy Gemini/4.6 rules.
- MODIFY `src/codex/catalog/provider-models.ts`: derive discovery reasoningEfforts from the exact effort wire map instead of always `[]`, preserving provider hints and cache behavior.
- NEW focused regression in `tests/adapters/google/` and catalog integration in `tests/providers/`; register each in `scripts/test-layout/layout.json` and `tests/fixtures/test-layout-expected.json`.
- MODIFY `structure/providers-and-adapters.md`, `structure/catalog.md`, and canonical `docs-site/src/content/docs/guides/providers.md` for the precise grouping contract; review mapped dependent docs.
- Selection/new-model-policy treatment will be fixed in the plan after architect review before A; no configuration rewrite is authorized by this provisional line.

## Acceptance scenarios

1. Both 5.5 families and synthetic future version triples collapse to exactly one base row each, regardless of label or order; mapped low/medium/high route to matching wire IDs without thinkingLevel.
2. Partial families and standalone `gpt-oss-120b-medium` remain separate/direct; unrelated IDs and unknown single `-tiered` models retain existing behavior.
3. Saved explicit `-low` with high reasoning continues to send the low wire ID without contradictory thinkingLevel.
4. Catalog publishes exact discovered efforts plus context/image metadata; cached rereads and forced refresh retain grouping; old discovery mapping is invalidated with cache generation.
5. Existing 4.6 and Gemini cases remain passing. Selection/new-model-policy cases are finalized before independent audit.

Verification uses focused tests, `bun run typecheck`, `bun run structure:check`, `bun run privacy:scan`, layout guards, docs build, and final-head hosted suite. Full local suite may use the repository resource exception if disproportionate; document the executed scope and coverage left to hosted CI.

## Final D04 refinement and delegation

Replace the provisional selection line above with these concrete changes:
- MODIFY `src/codex/catalog/parsing.ts`: optional `antigravityEffortWireModelIds` on CatalogModel, containing low/medium/high wire IDs. Creation: parser map -> provider-models. Serialization/deserialization: in-memory model-cache retains typed rows unchanged; no config schema or disk cache addition. Consumers: pure Antigravity family helper, public-list projection and new-model-policy reconciliation. Public Codex serialization continues its explicit field selection.
- NEW `src/providers/antigravity-effort-families.ts`: dependency-light pure helpers over structural rows; validate complete exact family maps. Deduplicate retained suffix rows only when the same provider/base evidence exists. Compute selected alias matches and inherited disabled state without modifying provider configs.
- MODIFY `src/providers/new-model-policy.ts`: before applyNewModelPolicy, normalize prior suffix baseline to base for evidence-backed families and transfer all-disabled state once; keep suffix disable entries. Existing base evidence has precedence. Only authoritative live providers participate; genuinely new families still obey new-model policy.
- MODIFY `src/codex/catalog/model-visibility.ts`, `src/codex/catalog/aggregation.ts`, `src/server/management/model-rows.ts`: reuse shared family helper for selected/disabled/public dedupe behavior. Internal retained combo evidence remains available until public projection.
- NEW `tests/providers/provider-antigravity-effort-families.test.ts`: pure projection and reconciliation scenarios. Dedicated worker may own this helper, policy hookup, and this test only; main owns parser/catalog/type/callers/docs/registration. No overlapping writers or worker Git operations.

D05: for a collapsed family use conservative context (minimum only when every tier provides it) and image support (true only when every tier says true, false when any explicitly false, otherwise unknown); use medium default independent of discovery ordering. Explicit caller/provider reasoning override still wins. Avoid inventing single-wire future -tiered semantics.

Additional acceptance: old suffix baseline + policy off + high enabled -> base enabled and not a new arrival; all disabled -> base disabled exactly once; later user re-enable stays enabled; suffix allowlist selects base; retained/combo suffix stays internally routable but appears once publicly; genuinely new family remains off under policy off; unrelated providers/custom rows never inherit family rules. Tests exercise actual cache and management projection paths. Same architect reflection and independent audit required before Build.

Architect reflection D04 gap accepted: before applyNewModelPolicy, normalize BOTH prior baseline and policy-only discovered IDs through the same observed family mapping. Retained/combo suffix rows remain internally available but never reappear as new policy arrivals. Repeated reconciliation must be a no-op with such retained rows present.

Existing contract expectation update: `tests/adapters/google/google-models-listing.test.ts:133` currently expects complete future-flash low/medium/high separately. Replace with one future-flash plus exact effort map assertions; this is the requested behavior change, not weakened coverage. Add adapter-level request body checks for 5.5.

Independent A blocker accepted: final catalog merge has another raw selectedModels consumer. MODIFY `src/codex/catalog/retained-sync.ts` and `src/codex/convergence.ts` to pass the same evidence-backed allowlist projection into final merge, keeping persisted selection unchanged. Add a regression that uses the projected allowlist with the actual `mergeCatalogEntries` final filter, proving base survives suffix-only selection. This adds consumers of D04's existing projection, not a new data contract or persistence flow.
