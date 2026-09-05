# wp1 — roster defaults, one-time upgrade, delivery

## File change map

- NEW `src/config/subagent-models.ts`: own the default constant, version constant
  (1), and pure mutating `migrateSubagentModels(config): boolean`; version >=1
  short-circuits, unset seeds defaults, otherwise prepend Astra/deduplicate/cap5;
  move retained bare gpt-5.5 to the last slot after truncation; assign marker and
  return true. No I/O here. User explicitly amended 5.5 to lowest position.
- MODIFY `src/config.ts`: import/re-export the existing default constant from the
  leaf; remove its old declaration; add the positive-integer optional version
  schema (malformed marker degrades independently), and seed version 1 in fresh
  defaults. Existing export stays compatible. Both loadConfig's repair merge and
  mergeConfigDefaults must override the inherited marker with the raw marker so
  repaired legacy configs are not falsely marked migrated.
  Add `subagentModels: z.array(z.string().min(1)).optional().catch(undefined)`:
  null/scalar/mixed/empty-string-element hand edits degrade only the optional roster to
  unset before migration; unrelated provider settings remain intact.
- MODIFY `src/types/config.ts`: `subagentModelsVersion?: number` next to roster.
  Chain: fresh builder/migration -> saveConfig JSON -> optional schema on load ->
  startup migration guard. Future positive versions skip the v1 transform.
- NEW `src/server/subagent-models-startup.ts`: use `mutatePersistedConfig` to
  transform the fresh disk roster under the existing mutation lock, then adopt
  only roster/version into live config. On unavailable persistence, warn and use
  the in-memory projection for this run; never overwrite stale unrelated fields.
- MODIFY `src/server/index.ts`: replace unset-only block with the startup helper
  before catalog use. Remove unused default import.
- MODIFY existing `tests/server/config.test.ts`: fresh exact order; old five and
  partial/empty lists; Astra-present duplicate handling; missing list; save/load
  marker and later user reorder/removal; future marker; invalid marker isolation.
- MODIFY existing startup integration tests if needed: verify the real startup
  calls migration and persists before catalog publication. No new test runner.
- MODIFY `structure/03_catalog-and-subagents.md`, directly affected configuration
  tables and how-it-works pages across locales: new defaults and one-time upgrade;
  preserve examples that illustrate custom lists rather than defaults.

## Activation matrix

| Precondition | Observable result |
| --- | --- |
| getDefaultConfig | Astra, Sol, Terra, Luna, 5.5; version 1 |
| legacy five entries, no marker | Astra + old first four; fifth removed |
| retained 5.5 among old first four | move it to last; other relative order preserved |
| unset, no marker | exact fresh defaults; version 1 |
| explicit empty, no marker | Astra only; version 1 |
| Astra in old list | one Astra first; relative non-Astra order preserved |
| saved v1, then reordered/empty/removed Astra | unchanged after next migration |
| future positive version | unchanged |
| malformed version | unrelated config survives schema load |
| null/scalar/mixed/empty-string-element roster, no valid marker | load normalizes to unset; migration seeds valid defaults |
| missing providers triggers defaults repair | raw legacy marker remains unset; roster migrates |
| disk roster changes after live load | transform latest disk roster; unrelated disk edits survive |
| persistence unavailable | no stale disk overwrite; live projection with warning |

## Review and delivery

Independent read-only plan audit and implementation audit, no local suites.
Local typecheck (tsconfig includes src only) plus whitespace gate; GitHub
cross-platform tests execute the changed test target. Fill PR Summary,
Verification, Checklist; disclose no-local-tests and user-authorized admin bypass.
Push with --no-verify. Do not merge failing exact-head CI. Fetch dev and prove
merge ancestry. Close the FSM with receipt/evidence and archive this unit.
