/**
 * The `compaction.trigger` values Codex labels a compaction turn with (`CompactionTrigger`
 * in codex-rs: a manual `/compact` versus automatic compaction). `compactionRouting.triggers`
 * selects which of them an override applies to.
 *
 * This is its own leaf module and imports nothing on purpose. The request path reads it from
 * `src/server/responses/compaction-routing.ts`; importing `leaf-validators.ts` there instead
 * closes a cycle with `config-schema.ts` that survives typecheck and then fails at run time
 * with "Cannot access 'runtimeRoleSchema' before initialization".
 */
export const COMPACTION_TRIGGERS = ["manual", "auto"] as const;
