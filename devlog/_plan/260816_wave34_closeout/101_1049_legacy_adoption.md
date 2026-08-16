# 101 — #1049: adopt pre-substrate Codex homes into the coordinator

One PABCD cycle. Runs AFTER `100` — both touch `src/codex/inject.ts`.

## Verified state

Legacy homes bypass the write lock entirely: injection calls `applyNativeArtifacts()` directly for `legacy-uncoordinated` (`src/codex/inject.ts:901`) and restore calls `restoreCodexConfigInline()` (`:1504`). The eligibility layer says so explicitly (`src/codex/inject-coordination.ts:36`, `:84`), and `tests/codex-inject-write-lock.test.ts:144` currently PINS that bypass.

Already satisfied: residue detection, invalid-record refusal, unversioned/rowless refusal (`src/codex/transition-state.ts:269`, `:288`).

The roadmap's unified `clean/routed/recoverable/ambiguous/invalid` classifier does not exist. What exists is three separate results: residue `clean|residue|indeterminate` (`src/codex/native-residue.ts:46`), integration record `missing|ready|invalid` (`src/codex/integration-record.ts:98`), coordinator `ready|legacy-ambiguous|unavailable` (`src/codex/convergence-types.ts:298`). Adoption eligibility is a FUNCTION of those three, not a fourth enum to replace them.

## Required shape

The `adoption-pending` design already exists in the archived contract (`devlog/_fin/260804_codex_write_substrate/005_contract.md:709`, crash boundary at `:735`) but runtime `transition-state.ts` does not accept that status. Implement it there:

1. Derive adoption eligibility from the three existing classifiers. Routed + no coordinator + valid record + clean-or-explainable residue is adoptable; indeterminate residue or an invalid record refuses.
2. Write a pending adoption row with an exact-byte fingerprint of the artifacts being adopted, BEFORE publishing anything.
3. Publish under the lock, then clear the row.
4. On startup, a pending row whose fingerprint still matches disk is recoverable and resumes; one whose fingerprint does NOT match refuses and leaves the home legacy-operable rather than guessing.

Preserving legacy operability on refusal is the non-negotiable part: a failed adoption must never leave a home that neither the legacy path nor the coordinator will touch.

## Tests

`tests/codex-inject-write-lock.test.ts:144` asserts the bypass being removed — update it. Add per-state fixtures: adoptable home adopts and then uses the lock; indeterminate residue refuses; invalid record refuses; unversioned/rowless database refuses; a kill at each I/O boundary leaves either the pre-adoption state or a resumable pending row, never a half-published home.

---

## Audit correction (independent read-only audit at `ba456bdcf`)

The plan above was written against a mid-run snapshot and is materially stale. A parallel
audit checked every symbol, path, and line it names against the tree. Adopting it as written
would produce uncompilable or vacuous work in four places.

### Confirmed accurate

`applyNativeArtifacts()` (`src/codex/inject.ts:883`, legacy branch at `:901`),
`codexWriteCoordinationEligibility()` (`src/codex/inject-coordination.ts:46`, `legacy-uncoordinated`
returned at `:84`), `assertInitialStateCanBeCreated()` (`src/codex/transition-state.ts:269`,
unversioned refusal at `:288`, rowless at `:295`), `NativeRoutedResidueResult`
(`src/codex/native-residue.ts:46`), `readIntegrationRecordUnlocked()`
(`src/codex/integration-record.ts:98`), and the archived contract at
`devlog/_fin/260804_codex_write_substrate/005_contract.md:709` / `:735`.

Two anchors drifted: the bypass-pinning test is at `tests/codex-inject-write-lock.test.ts:150`
(line 144 is now the `describe`), and the `ready | legacy-ambiguous | unavailable` union moved to
`src/codex/convergence-types.ts:319-322`.

### Wrong in substance

- **"Write a pending adoption row before publishing anything" is dangerous as written.** Read as
  an insert into the final coordinator database it is wrong: the archived contract's publication
  unit is a COMPLETE temporary SQLite database, validated, fsynced, and published atomically
  without replacement, with `EEXIST` treated as a lost race that reopens the winner under strict
  validation. An insert-then-publish sequence has a crash window the contract exists to remove.
- **The exact-byte fingerprint has no schema field and contradicts the recovery contract.** Byte
  equality cannot distinguish "callback never started" from "partially completed" from "completed
  then externally rewritten". Resumption must idempotently rerun the requested apply/restore.
- **"Clear the row" is incompatible with the singleton model.** Normal transitions update the
  durable singleton to a terminal state; they never delete it.
- **"Routed + valid record" is narrower than the archived contract**, which admits a missing OR
  valid v1 record with no legacy transition fields. "Clean-or-explainable residue" has no defined
  predicate and would be vacuous policy language if implemented literally.

### Vacuous as written

Implementing adoption in `inject.ts` alone changes nothing: `withCodexWriteLock()`
(`src/codex/codex-write-lock.ts:249`) always calls `openCodexCoordinatorTransaction()`, which
refuses routed residue before any callback runs. Adding `"adoption-pending"` to
`transition-state.ts` alone does not compile meaningfully either — `CodexHistoryState`
(`src/codex/convergence-types.ts:36`), the runtime status set (`transition-state.ts:41`), and the
SQL `CHECK` (`:69`) all have to move together.

### What the plan missed

Call-time home resolution (`src/codex/paths.ts:32`), WSL home selection (`src/codex/home.ts:135`),
canonicalization and identity-derived database location (`src/codex/user-identity.ts:355`), and the
zero-byte first-use race already handled in
`tests/codex-transition-state-first-use-regression.test.ts:54`.

Also worth recording: today's eligibility deliberately lets an `indeterminate` home keep writing
directly rather than refusing it. The plan's required shape contradicts that, and the change would
be user-visible.

### Corrected shape

1. `convergence-types.ts:36` — add `adoption-pending` plus the authority/intent fields needed to
   resume an authorized apply or restore. A bare fingerprint is not sufficient.
2. `transition-state.ts:40` — extend the status validator and SQL schema together, and add a
   compatibility-adoption publisher that builds a complete v1 database at a unique same-directory
   temp path and publishes it atomically without replacement.
3. `inject-coordination.ts:41` — replace the broad legacy verdict with `adoptable |
   legacy-uncoordinated | refused`, derived from the three existing classifiers.
4. `codex-write-lock.ts:249` — add the adoption-capable entry path, without which nothing above
   is reachable.
5. `inject.ts:860` / `:1431` — route authorized legacy apply/restore through adoption, then the
   normal N-protected transition.
6. Tests — new `tests/codex-transition-state-adoption.test.ts` for publication and crash/race
   boundaries; end-to-end cases in `tests/codex-inject-write-lock.test.ts`; and update the
   bypass-pinning test at `:150`, which currently asserts the very behavior being removed.

### Disposition

**Deferred, not attempted.** This is a crash-safe durable-state change across five files with a
publication protocol whose failure mode is an unusable Codex home — larger than the remaining
work-phases in this loop and not safely compressible into one. #1049 stays OPEN with this
corrected plan recorded; the audit above is the deliverable of this cycle.

