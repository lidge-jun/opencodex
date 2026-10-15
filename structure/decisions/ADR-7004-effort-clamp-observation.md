# ADR-7004: decision recorded under "Effort-clamp observations"

- Purpose: make repeated unchanged syncs preserve effort-clamp observations instead of producing
  fresh timestamps, disk replacements and repeated warnings (#7004).
- Prior constraint: the catalog rebuilds unclamped rows each time; clamping them again is correct,
  but unconditional logging and persistence mistake that deterministic projection for a change.
- Alternatives: process-local notice memoization, suppressing all warnings, or comparing the existing
  persisted diagnostic. Process memory cannot deduplicate separate CLI invocations; suppressing all
  warnings hides new runtime/catalog incompatibilities.
- Choice: reuse the existing diagnostic loader/persister and compare runtime path/version plus
  order-independent effort/model sets before writing. Return change information to the caller so
  notification and persistence cannot disagree. Preserve every observation callback.
- Consequences: no new files or schema, unchanged observations keep their original timestamp, and
  real changes or recurrence after clearing still notify. The existing atomic writer is retained;
  this read/compare/write is not cross-process transactional notification deduplication. Remove only
  the misleading sync clamp's doctor hint; runtime-selection diagnostics are unchanged.
