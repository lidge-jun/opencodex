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

/** Exact selectors or a provider-qualified trailing wildcard; never a global wildcard. */
export function validCompactionSourceModels(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && new Set(value).size === value.length
    && value.every(entry => typeof entry === "string" && entry.length > 0
      && entry === entry.trim() && !/\s/.test(entry)
      && (!entry.includes("*") || /^[^/*]+\/\*$/.test(entry)));
}
