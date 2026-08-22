# Phase 2 — history-mode awareness in the Codex history integration

Closes G3, G4. One PABCD cycle. Independent of every other phase.

Audit history: `006_audit_round1.md`, `007_audit_round2.md`. This document is canonical —
all audit corrections are integrated below, not appended.

## Why this is a compat-break

Paginated rollouts (`6bb6e9045`, `4bb7ee347`) give every JSONL line a monotonically
increasing `ordinal` and set `SessionMeta.history_mode = "paginated"` (`ThreadHistoryMode`,
`codex-rs/protocol/src/protocol.rs:700`). Verified rejection —
`codex-rs/thread-store/src/local/thread_history_materialization.rs:170-186`:

```rust
            None => {
                return Err(ThreadStoreError::Internal {
                    message: format!(
                        "paginated rollout line for {thread_id} is missing an ordinal"
                    ),
                });
            }
```

opencodex appends an ordinal-less `session_meta` line unconditionally. Upstream's
equivalent branches on mode (`codex-rs/thread-store/src/local/update_thread_metadata.rs:74`) and skips legacy `SessionMeta`
persistence when paginated.

## Current state (verified this session)

| Location | Fact |
| --- | --- |
| `src/codex/history-provider.ts:518` | `parseThreadFieldsFromRolloutText` ALREADY reads `payload.history_mode` |
| `src/codex/history-provider.ts:401` | `historyMode?: string` on the parsed-fields type |
| `src/codex/history-provider.ts:179` | `interface ThreadRow` — no `history_mode` |
| `src/codex/history-provider.ts:165-176` | `CodexHistorySyncResult`: `rows`, `files`, `ejectedRows?`, `failed?`, `failureReason` (`:176`) |
| `src/codex/history-provider.ts:340` | `rememberOriginal` — backup entry serializer |
| `src/codex/history-provider.ts:523+` | `updateSessionMeta` — always appends |
| **three mutation paths** | sync `:705` (SELECT `:714`/`:722`, backup `:731`, bulk update `:750`); restore `:780` (loop `:801`, manifest clear `:815`); **ejection `:586`** (SELECT `:588`, writes `:599`, bulk update `:608-618`, reachable from `:786`) |
| `src/storage/cleanup.ts:631-655` | precedent: `columnExists` + conditional select |
| `src/storage/cleanup.ts:673` | precedent: refuses cleanup when any thread is `paginated` |

## Change 1 — shared `columnExists`

Three SQLite helpers are currently **private** to `src/storage/cleanup.ts` and are all
needed by the history provider:

| Helper | Current location | Currently exported? |
| --- | --- | --- |
| `columnExists` | `src/storage/cleanup.ts` | no |
| `SQLITE_ID_CHUNK` (= 200) | `src/storage/cleanup.ts:112` | no |
| `chunkIds` | `src/storage/cleanup.ts:123` | no |

Importing `cleanup.ts` into the history provider would drag unrelated heavy imports.
**Move all three** to `src/codex/sqlite-columns.ts` (NEW, ~20 lines), export them there, and
import them back into `cleanup.ts` so its existing call sites (`:631`, `:635`, `:2318`, and
every `chunkIds`/`SQLITE_ID_CHUNK` use) keep working unchanged. Cleanup's own exports and
tests are preserved. One definition each, no new dependency edge.

## Change 2 — carry `history_mode` on thread rows

`interface ThreadRow` (`:179`) gains `history_mode?: string | null`.

There are **three existing SELECTs**: `:588` (ejection), `:712` (openai/resumable rows),
and `:720` (opencodex exec rows). Each becomes column-guarded:

```ts
const hasHistoryMode = columnExists(db, "threads", "history_mode");
const cols = ["id", "rollout_path", "model_provider", "source", "has_user_event"];
if (hasHistoryMode) cols.push("history_mode");
```

The guard is required: an older `state_5.sqlite` predates the column and an unguarded
SELECT throws.

**A fourth, NEW SELECT is required for restore.** `restoreCodexHistoryProvider` (`:780`)
restores directly from manifest entries and issues **no row query at all**, so it has no
`ThreadRow` to resolve a mode from. Without one, a thread whose live DB mode is unknown
(e.g. `"sharded"`) while its rollout file lacks that mode would be treated as legacy —
violating fail-closed. Add a column-guarded batch lookup keyed by the manifest's thread ids
before partitioning:

```ts
// Restore has no live rows of its own; the manifest is a snapshot that may predate a
// migration. Resolve the CURRENT mode per id before deciding how to restore.
const liveRows = new Map<string, ThreadRow>();
for (const chunk of chunkIds(entries.map(e => e.id), SQLITE_ID_CHUNK)) {
  const placeholders = chunk.map(() => "?").join(",");
  for (const row of db.query<ThreadRow, string[]>(
    \`SELECT \${cols.join(", ")} FROM threads WHERE id IN (\${placeholders})\`
  ).all(...chunk)) liveRows.set(row.id, row);
}
```

**An entry with no live row (thread deleted since backup) is terminally resolved, not
skipped:** there is nothing left to restore, so its manifest entry is REMOVED and it is not
counted as skipped work. This keeps the partial-work invariant honest — only
`skippedUnknownMode` (work we refused to do) blocks `converged`, while a deleted thread is
genuinely done. Do not conflate the two.

## Change 3 — resolve the mode

```ts
type HistoryMode = "legacy" | "paginated" | "unknown";

function resolveHistoryMode(row: ThreadRow, rolloutPath: string): HistoryMode {
  const fromRow = (row.history_mode ?? "").toLowerCase();
  if (fromRow === "paginated") return "paginated";
  if (fromRow === "legacy") return "legacy";
  if (fromRow) return "unknown";                    // future mode: fail closed
  const fromFile = (readThreadFieldsFromRollout(rolloutPath)?.historyMode ?? "").toLowerCase();
  if (fromFile === "paginated") return "paginated";
  if (fromFile === "legacy" || fromFile === "") return "legacy";  // absent == legacy (serde default)
  return "unknown";
}
```

Absent means legacy: `ThreadHistoryMode` derives `#[default] Legacy` (`protocol.rs:700`).

## Change 4 — partition ALL THREE mutation paths

Sync and ejection currently select rows and then bulk-update them; restore has no query of
its own and obtains its rows from the new Change 2 lookup. All three must partition BEFORE
mutating, with **id-scoped statements only** — never a table-wide UPDATE:

```ts
const partitioned = { legacy: [] as ThreadRow[], paginated: [] as ThreadRow[], unknown: [] as ThreadRow[] };
for (const row of rows) partitioned[resolveHistoryMode(row, row.rollout_path)].push(row);
```

| Path | Legacy rows | Paginated rows | Unknown rows |
| --- | --- | --- | --- |
| sync `syncCodexHistoryProviderUnsafe` `:705` | append `session_meta` + line-1 patch; `UPDATE ... WHERE id = ?` | **no rollout write**; DB update only | excluded from every statement |
| restore `restoreCodexHistoryProvider` `:780` | current restore behavior | DB update only | skipped, backup entry retained |
| **ejection `ejectRemainingOpencodexHistory` `:586`** | current write at `:599` | **no rollout write**; DB update only | excluded from `:608-618` |

The `unknown` partition must never appear in any **mutating** `WHERE id IN (...)` list (it is
necessarily READ first — that is how its mode is discovered) — that is the
difference between the claimed contract and today's bulk update.

`updateSessionMeta` gains a mode parameter and returns false for anything but `legacy`, so
no caller (including ejection) can reach a paginated file through it.

## Change 5 — backup discipline

`rememberOriginal` (`:340`) currently runs for **every** selected row before mutation
(`:731`). Call it ONLY for rows about to be mutated — otherwise restore would later
"restore" a row that was never touched.

**Do not add a `historyMode` field to the backup entry.** Restore must resolve the live
mode regardless (a thread can migrate after the backup was taken), so a stored mode would
be a ghost field with no trustworthy consumer. The manifest shape is unchanged.

Restore clears the whole manifest at `:815`. It must clear exactly the entries that are
**done** — either successfully restored, or terminally resolved because no live row exists
(deleted thread) — and **retain** entries refused for unknown mode. Otherwise an
unknown-mode thread silently loses its backup and can never be restored.

## Change 6 — `skippedUnknownMode` and its full transport chain

The count crosses a Worker boundary, so a result field alone is invisible:

| Stage | Location | Change |
| --- | --- | --- |
| producer | `src/codex/history-provider.ts:165-176` `CodexHistorySyncResult` | add `skippedUnknownMode?: number` |
| worker DTO | `src/codex/history-worker.ts:69` `HistoryWorkerResult` | add to the `done` variant |
| worker construction | `src/codex/history-worker.ts:184` | populate it |
| message validation | `src/codex/history-job.ts:152` | accept/validate it |
| job outcome | `src/codex/history-job.ts:107` `CodexHistoryJobOutcome` | add to `converged` |
| classification | `src/codex/history-job.ts:282` | carry through |
| consumers | `src/codex/inject.ts:1023`, `:1515` (restore), `src/codex/history-migration-guardian.ts:49` | surface it |
| durable state | `src/codex/history-transition.ts:28` `classify` | see below |

**Decision on `classify` (SETTLED — do not redesign).** Reusing `skipped` is wrong:
`history-transition.ts:42` maps `skipped` to `status: "converged"` precisely because a user
opting out is a completed decision. Unknown-mode rows are the opposite — work we refused to
do and must retry after a Codex upgrade teaches us the mode.

`CodexHistoryState.status` (`src/codex/convergence-types.ts:36`) has no `partial` member and
its `reason` union has no fitting value. The settled design adds **one reason, not a new
status**:

| Element | Change |
| --- | --- |
| `CodexHistoryState.reason` (`convergence-types.ts:36+`) | add `"unknown-history-mode"` to the union |
| `classify` (`history-transition.ts:28`) | for a `converged` outcome carrying `skippedUnknownMode > 0`, return `{ status: "pending", reason: "unknown-history-mode", attempts: 1, nextRetryAt: <schedule> }` instead of `converged` |
| retry semantics | `pending` already carries the durable retry schedule — a later run re-attempts those rows, which is exactly right: a Codex upgrade may make the mode known |
| `skipped` | UNCHANGED — still `converged` (user opt-out) |

`pending` is chosen over `blocked` because nothing is broken: the rows are simply not
understood yet, and the existing retry path will revisit them. Do NOT add a `partial`
status: it would require every `status` consumer to learn a new state, whereas a new
`reason` on the existing `pending` status is inert for consumers that do not inspect it.

**Durable persistence requires a schema migration — the type change alone is rejected.**
`src/codex/transition-state.ts` enforces the reason vocabulary in THREE places, and a
literal implementation of the type change would make the transition write fail with
`unavailable/database`:

| Layer | Location | Content |
| --- | --- | --- |
| runtime allowlist | `transition-state.ts:42` `DURABLE_HISTORY_REASONS` | `db-busy, permission, unreadable, schema, timeout, shutdown-cancelled, worker-died, overtaken, record-write-failed` |
| write validation | `transition-state.ts:249` `validateHistoryWrite` | rejects any reason outside that set |
| **SQLite CHECK constraint** | `transition-state.ts:70-72` | the same list embedded in the table DDL (line 69 is the *status* CHECK) |

Updating only the table-creation SQL is insufficient: an **existing** database already
carries the old CHECK, and `COORDINATOR_SCHEMA_VERSION` is `1` (`:40`) with
`PRAGMA user_version` gating at `:284-285` — a mismatched version is refused outright.

Settled migration plan:

1. Add `"unknown-history-mode"` to `DURABLE_HISTORY_REASONS` (`:42`) and to the CHECK list
   in the DDL (`:70-72`).
2. Bump `COORDINATOR_SCHEMA_VERSION` to `2` (`:40`).
3. Add a v1→v2 migration. SQLite cannot alter a CHECK constraint in place, so the migration
   is the standard table rebuild: create the new table under a temporary name with the
   widened CHECK, `INSERT INTO ... SELECT` the existing single row, drop the old table,
   rename, then set `PRAGMA user_version = 2` — all inside the existing `BEGIN IMMEDIATE`
   transaction discipline (`:424`, `:578`).
4. The version gate at `:284-285` must accept a v1 database and migrate it rather than
   refusing it.

**Alternative if the migration is judged too heavy for this phase:** reuse the existing
`"schema"` reason with `status: "pending"` and no vocabulary change at all. It is a
defensible fit (we do not understand the on-disk shape) and costs zero migration. Decide at
P and record which was chosen — but do NOT implement the new reason without steps 1-4.

Affected files/tests: `src/codex/convergence-types.ts`, `src/codex/history-transition.ts`,
`src/codex/transition-state.ts`, `tests/codex-transition-state.test.ts` (real, anchor `:61`),
plus the suite covering `classify` (confirm its filename during P and record it).

## Tests (`tests/codex-history-provider.test.ts`, anchor `:98`)

1. **Paginated rollout byte-identical after sync** — hash before/after; assert unchanged
   AND that the `threads` row provider changed. Today the file grows by one ordinal-less
   line — activation evidence.
2. **Ordinals stay contiguous** after a sync.
3. **Legacy path unchanged** — existing append/line-1 assertions still pass.
4. **Missing `history_mode` column** — syncs as legacy, does not throw.
5. **Unknown mode** (`"sharded"`) — the row's provider value is unchanged in the DB (not
   merely "no file written") and `skippedUnknownMode === 1`. Activation scenario for the
   fail-closed branch.
6. **Mixed batch** — legacy + paginated + unknown in one sync.
7. **Restore after migration** — backup captured as legacy, thread now paginated; DB only.
8. **Ejection path** — `ejectRemainingOpencodexHistory` with a mixed set: paginated files
   byte-identical, unknown rows untouched in the DB.
9. **Backup scoping** — an unknown-mode row is not written to the backup manifest.
10. **Partial restore** — a manifest with one restorable and one unknown entry keeps the
    unknown entry after restore.
10b. **Backup legacy, live row unknown** — the manifest entry says legacy but the current
    `threads` row is `"sharded"`: restore must skip it (fail-closed) and retain its backup
    entry. This is the activation scenario for the new restore SELECT; without that query
    the row would be restored as legacy.
10c. **Manifest entry with no live row** — thread deleted since backup: its manifest entry
    is REMOVED, it is NOT counted in `skippedUnknownMode`, and the job outcome may still be
    `converged` (nothing remained to restore).
11. **Transport** — `skippedUnknownMode` survives the Worker round-trip into the job
    outcome, and a run with skips is not classified `converged`.
11b. **Durable persistence** — the chosen reason actually WRITES: exercise a real transition
    state write and read it back. If the new reason was chosen, also assert that an
    EXISTING v1 database migrates and accepts it (the old CHECK constraint would reject it).

Must stay green: `tests/codex-history-job.test.ts`, `tests/codex-history-worker.test.ts`,
`tests/codex-history-writer.test.ts`, `tests/codex-native-residue.test.ts`,
`tests/storage-cleanup.test.ts` (re-exported `columnExists`).

## Verification

```bash
bun install                      # REQUIRED: this worktree has no node_modules
bun test tests/codex-history-provider.test.ts tests/codex-history-job.test.ts tests/codex-history-worker.test.ts tests/codex-history-writer.test.ts tests/codex-native-residue.test.ts tests/codex-transition-state.test.ts tests/storage-cleanup.test.ts
bun x tsc --noEmit
```

**Receipts (measured 2026-08-16, dependency-less worktree).** Each row is the exact command
named above:

| Command | Exit | Observed |
| --- | --- | --- |
| the 7-file `bun test` command | 1 | `0 pass, 7 fail; Ran 7 tests across 7 files` — `Cannot find module 'zod/v4'` (the 5-file form reproduced 5/5) |
| `bun x tsc --noEmit` | 1 | `TS2688: Cannot find type definition file for 'bun-types'` |

Environmental — `ls node_modules` → absent. B runs `bun install` and re-records.
`package.json:41` defines `"test": "bun scripts/test.ts"`; use `bun run test` for a full run.

Target observation: `tests/codex-history-provider.test.ts` imports
`src/codex/history-provider.ts` directly.

## Accept criteria

1. A paginated rollout is byte-identical before and after sync, restore, AND ejection.
2. Its `threads` row still receives the provider/source change.
3. An unknown-mode row is absent from every **mutation** statement (it is necessarily READ, to discover its mode) and counted in `skippedUnknownMode`.
4. Legacy rollouts keep current append + line-1 behavior exactly.
5. A `threads` table without `history_mode` does not throw.
6. Backups cover only mutated rows; restore clears entries that were restored OR terminally
   resolved (no live row), and retains only entries refused for unknown mode.
6b. Restore resolves each thread's mode from a LIVE row query, never from the manifest.
7. `skippedUnknownMode` reaches the job outcome, and partial work is not `converged`.
8. `columnExists`, `chunkIds`, and `SQLITE_ID_CHUNK` each have exactly one definition, in `src/codex/sqlite-columns.ts`.
9. A deleted thread's manifest entry is removed and does not block `converged`; only refused work does.

## Out of scope

Writing ordinals; maintaining `thread_history_1.sqlite`; changing `src/codex/paths.ts`;
relaxing the `src/storage/cleanup.ts:673` paginated refusal (G10 — that refusal stays).
