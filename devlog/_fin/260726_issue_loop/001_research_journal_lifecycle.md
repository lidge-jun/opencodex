# 001 — Research: the Codex config journal lifecycle

Research notes behind WP1. No diffs here; the implementation design lives in
`010_wp1_journal_transaction_477.md`.

## Call graph on `b4485706`

`writeJournal()` has exactly two direct callers:

| Caller | Process | When |
|--------|---------|------|
| `src/cli/index.ts:201` | server process (`ocx start`, service mode) | after the server binds, before any injection |
| `src/codex/inject.ts:532` | whichever process injects | first thing `injectCodexConfig` does after rejecting external providers |

Everything that injects reaches the second one: `ocx sync`, `ocx ensure` (both
the spawned child at `src/cli/index.ts:333` and the parent at `:357`), `ocx init`,
`ocx provider add --sync`, `ocx models add`, the V2 commands, and the daemon's
`POST /api/sync` at `src/server/management/config-routes.ts:227`.

`markJournalInjectedState()` has one caller, `src/codex/inject.ts:577`, always
in the same process and the same function body as the `writeJournal()` at 532.

`restoreJournalState()` is reached from `restoreNativeCodex()`
(`src/codex/inject.ts:714`), which runs on foreground `syncCleanup`
(`src/cli/index.ts:212-222`, skipped when `OCX_SERVICE` is set), `POST /api/stop`
(`src/server/management-api.ts:151`), `ocx stop`, `ocx uninstall`, and
`ocx restore`. `reconcileJournal()` runs at the top of `ocx start`
(`src/cli/index.ts:153`) and `ocx ensure` (`:307`).

## The two frozen returns

`src/codex/journal.ts:32` preserves an existing journal; `:51` preserves an
existing `injectedConfigHash`. The journal is deleted only on a *complete*
two-file restore (`:98`), and a partial restore is normal and tested
(`tests/codex-journal.test.ts:208` and `:232`). So once a user edits
`config.toml` while routing is live, the journal outlives every later session.

## Why the guard at line 32 is load-bearing

`ocx start` calls `writeJournal()` twice — once directly, once through
injection — and injection over an already-injected config is a supported,
tested path (`tests/codex-inject-integration.test.ts`, "re-inject over a Design
B config is idempotent"). Without the guard the second call captures the
*injected* config as `originalConfig`, and a later restore replays opencodex's
own routing into the user's config as if they had written it. Deleting the line,
which the issue suggests, converts a recoverable staleness bug into permanent
unremovable injection.

## Which restore actually destroys settings

`restoreJournalState` guards the overwrite with a hash check (`journal.ts:80`),
so a config carrying newer user edits normally fails the check and survives.
Two paths bypass that:

1. **Hashless journal.** `!journal.injectedConfigHash` counts as *unchanged*, so
   a pre-hardening journal replays wholesale. `tests/codex-journal.test.ts:49`
   locks this in deliberately as legacy recovery.
2. **Snapshot-to-inject race.** The snapshot at `src/cli/index.ts:201` and the
   injection at `:274` are separated by the whole server startup. Anything Codex
   writes in between — plugin install, model switch, newly trusted project — is
   read by `injectCodexConfig` at `inject.ts:516` and hashed as the injected
   state at `:577`, while the journal still holds the pre-change baseline that
   `writeJournal` refused to refresh. The hash then matches on the next unclean
   start and the interval's changes are replayed away.

Path 2 matches the reported symptom and is what the frozen snapshot enables.

## Rejected fix shapes

- **Delete line 32.** Permanent injection, as above.
- **PID-based transaction ownership** (`journal.pid !== process.pid`). Rejected
  during audit: `ocx sync` and the `ocx ensure` parent legitimately inject in a
  process that did not write the journal, so the guard would suppress hash
  refresh exactly when it is needed. It is also unnecessary — a refreshed
  journal is rebuilt from scratch and therefore has no hash to protect.
- **Timestamp staleness bound.** An arbitrary threshold discards valid recovery
  for a long-running service and still permits destructive replay inside the
  window. Recorded as a possible later defence, not this unit's fix.
