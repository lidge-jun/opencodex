# Phase 3 — one-time history migration + docs/SoT

After Design B, existing threads tagged `opencodex` would be invisible (codex lists by
current provider id = `openai`). Migrate them once, forward-sync never runs again on
the Design B path.

## Files

**MODIFY `src/codex-history-provider.ts`** — NEW export:
```ts
/** One-time Design-B migration: restore backed-up originals, then eject any remaining
 * opencodex-tagged threads to openai. Reuses restore machinery; recoverable-lock
 * behavior identical to syncCodexHistoryProvider("openai"). */
export function migrateHistoryToOpenai(stateDbPath = STATE_DB_PATH, backupPath = HISTORY_BACKUP_PATH): CodexHistorySyncResult {
  return syncCodexHistoryProvider("openai", stateDbPath, backupPath);
}
```
(Thin alias — restore path already does exactly this: manifest restore + eject
remaining + clear backup. Naming makes the inject call site self-documenting.)

**MODIFY `src/codex-inject.ts`** — Design B branch calls
`migrateHistoryToOpenai()` when `config?.syncResumeHistory !== false`; message:
- rows/ejected > 0 → "N opencodex-tagged thread(s) migrated back to openai (one-time)."
- failed → warning to close the Codex app and rerun (same wording family as today).
- 0 → "Codex resume history: no migration needed."
Legacy (non-loopback) branch keeps forward sync.

**MODIFY `tests/codex-history-provider.test.ts`** — migration: seeded opencodex rows
+ backup manifest → all openai, backup cleared; idempotent second run = 0 rows.

**MODIFY `README.md`** — How-it-works section: describe openai_base_url override,
note history is untouched under Design B, keep legacy note for remote/non-loopback.

**MODIFY `~/.codex/skills/opencodex/SKILL.md` + references** — OUT OF SCOPE for the
repo loop (user-level skill dir); flagged in D summary instead.

**SoT sync:** devlog/_fin/260702_codex-history-sync-hardening/ gets a closing note
pointing at this unit (Design B shipped on dev-B).

## Accept

- `bun test tests/codex-history-provider.test.ts` green; full `bun test` green (final gate).
- Fresh-run evidence in D doc.
