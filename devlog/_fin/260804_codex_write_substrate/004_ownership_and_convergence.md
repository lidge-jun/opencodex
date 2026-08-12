# Part 4 — ownership authority and the meaning of convergence

Research document. No implementation diff. The failure under examination is the
one the second WP4 audit exposed: an unattended start can decide that an unreadable
service record means "no owner", repair a dead-PID journal, and overwrite files that
an external provider or another OpenCodex home owns. The current code makes each
individual choice look reasonable, but it asks four different ownership questions
as though they were one (`007_audit_synthesis_wp4.md:25-64`,
`008_audit_synthesis_wp4_r2.md:31-41`).

The substrate must answer those questions separately. A persisted switch says what
the user wants. It does not prove which installation may write, whether another
provider owns `config.toml`, whether a journal writer is still alive, or whether the
bytes on disk are still the bytes OpenCodex wrote.

## The concrete failure

The dangerous fixture is not an exotic race:

1. an old, markerless version-1 journal exists with a dead PID;
2. `config.toml` now selects an external `model_provider`;
3. the journal has no `injectedConfigHash`, so `restoreJournalState` treats the
   current config as unchanged (`src/codex/journal.ts:109-123`);
4. startup currently avoids that write only because it checks
   `currentExternalCodexModelProvider()` before `reconcileJournal`
   (`src/cli/index.ts:169-177`, `src/cli/index.ts:358-365`);
5. replacing that check with service-home ownership deletes a different authority
   and lets the journal baseline overwrite the externally managed config.

The external-provider check must therefore precede journal parsing, PID recovery,
desired-state convergence, and lock creation. In this fixture the entire Codex
artifact set, including the old journal, must remain byte-exact. The current
`restoreNativeCodex` behavior of deleting the journal when an external provider is
active is not acceptable for unattended convergence (`src/codex/inject.ts:764-770`).

## Four kinds of decision, not one

The word “guard” hid the design error. The substrate has four decision classes:

- **authority** — who is allowed to mutate this Codex home;
- **intent** — whether the persisted target is ON or OFF;
- **serialization** — whether this operation is the one allowed to commit now;
- **capability** — whether the selected files and database can be read and written.

Only authority can answer “may this process touch these bytes?”. Intent answers
“which direction should it converge?”. A lock answers “when?”. A filesystem or
SQLite error answers “can it finish?”. None may be used as a fallback for another.

## Distinct authorities that can refuse a mutation

| Authority | Question it answers | Current owner and current failure | Interactive route | Unattended convergence |
|---|---|---|---|---|
| Service-home ownership | Does an installed OpenCodex service claim this canonical `CODEX_HOME` and `OPENCODEX_HOME` pair? | `assertServiceEnvironmentMatchesInstall` compares the recorded homes (`src/service.ts:216-234`). `readServiceInstallState` skips unreadable/corrupt mirrors and returns the same `null` used for absence (`src/service.ts:165-175`), while `assertNativeTeardownOwned` converts every non-mismatch error to success (`src/integrations/native/ownership-preflight.ts:21-35`). | Fail closed on `foreign`; fail closed on `unknown` for Codex file mutation and return an actionable refusal. An explicit future override would be a separate user-consent surface, not implicit fail-open. | Fail closed on both `foreign` and `unknown`; continue starting the proxy, but perform zero Codex writes. |
| External `model_provider` | Has the user delegated this Codex config to a provider other than native `openai` or `opencodex`? | `externalCodexModelProvider` resolves the effective project provider and treats any other value as external (`src/codex/inject.ts:28-36`). Start and ensure currently consult it before journal recovery, but the failed design removed it in favor of service ownership. | Fail closed for apply, restore, repair, journal deletion, catalog/cache cleanup, and history mutation. Report the external provider. | Same, with byte-exact preservation. External ownership is not “already converged”; it is a blocked/deferred state. |
| Journal validity and writer liveness | Is there a valid OpenCodex transaction to recover, and can its writer still be active? | The journal records only PID and timestamp (`src/codex/journal.ts:10-18`). `reconcileJournal` treats a live PID or `EPERM` as active and any other probe failure as dead (`src/codex/journal.ts:148-159`). `readJournal` deletes malformed or unknown-version bytes while merely trying to inspect them (`src/codex/journal.ts:97-105`). | A valid live/permission-unknown writer blocks. A valid dead writer permits recovery only after the higher authorities pass. Invalid/unknown-version journal bytes are `unknown`, preserved, and block automatic writes. | Identical fail-closed policy. PID reuse may delay recovery, which is safer than overwriting a live transaction. A future journal should add an instance token/process-start identity; PID alone is not proof of identity. |
| Artifact provenance and drift | Are the current bytes still OpenCodex’s post-image, or did another actor edit them after apply? | Journal hashes protect only config/profile, and missing hashes are interpreted as unchanged (`src/codex/journal.ts:114-129`). Catalog restore infers ownership from slash-qualified slugs and a backup (`src/codex/catalog/sync.ts:572-597`). Cache invalidation has no pre-image at all (`src/codex/catalog/sync.ts:600-616`). Managed-default marker ambiguity is already a local refusal (`src/codex/inject.ts:506-517`, `src/codex/inject.ts:683-709`). | Exact rollback is allowed only from a recorded baseline and matching post-image. A structurally owned fragment may be removed while preserving unrelated edits. Ambiguous markers, unknown provenance, or conflicting hashes fail closed and name the artifact. | Same. Unattended code may never turn “I cannot prove ownership” into deletion. |

Two additional gates can refuse work, but they are not ownership authorities:

- the persisted desired flag is the **intent authority**. It must be freshly read;
  it never grants permission to cross one of the four authorities above;
- the per-home linearization transaction is **serialization**. Contention or an
  unopenable lock refuses the attempt, but owning the lock does not make foreign
  files ours. The current config mutation database is created when its path is
  resolved/opened (`src/config.ts:1757-1762`, `src/config.ts:1775-1800`), which is
  why an ownership decision must happen before a Codex lock path is opened.

History `SQLITE_BUSY`, `SQLITE_LOCKED`, `EPERM`, and `EACCES` are capability
failures, not evidence that another OpenCodex home owns the state
(`src/codex/history-provider.ts:511-548`). They make convergence unresolved; they
do not authorize a partial success.

## The service-home tri-state API

**INFERRED specification:** the ownership API must return evidence, not a boolean:

```ts
type NativeCodexOwnership =
  | { state: "owned"; codexHome: string; opencodexHome: string; evidence: "no-service" | "matching-install" }
  | { state: "foreign"; codexHome: string; opencodexHome: string; recordedCodexHome: string; recordedOpenCodexHome: string; message: string }
  | { state: "unknown"; codexHome?: string; opencodexHome?: string; reason: "service-state-missing" | "service-state-corrupt" | "service-state-unreadable" | "service-state-conflict" | "path-unresolvable"; message: string };
```

This is a research contract, not a proposed source diff. Its truth table is:

| Read-only evidence | Result |
|---|---|
| No service registration and no service-state mirror | `owned/no-service` — no installed service claims the target. |
| Service is installed and every readable mirror agrees with the canonical current homes | `owned/matching-install`. |
| A valid mirror names a different canonical Codex or OpenCodex home | `foreign`, even if a second path is missing. A valid foreign claim is not erased by absence elsewhere. |
| Service is installed but no valid mirror exists | `unknown/service-state-missing`. |
| Any required mirror is unreadable/corrupt, or two valid mirrors disagree | `unknown`; do not skip the bad mirror and accept the convenient one. |
| Current or recorded paths cannot be canonicalized safely | `unknown/path-unresolvable`. |

The truth table above is also **INFERRED** from the information the current service
reader collapses; no shipped function currently correlates manager registration,
all mirrors, and canonical paths. The probe must be read-only. It may inspect
service-manager registration and every
known state mirror, but it may not create a directory, harden an ACL, open SQLite,
delete a malformed mirror, or “repair” state. Current `loadConfig()` is unsuitable
for the admission read because it hardens paths and can write an invalid-config
backup (`src/config.ts:1503-1510`, `src/config.ts:1544-1549`). The existing
`readConfigDiagnostics()` path reads and validates without that backup side effect
(`src/config.ts:1679-1715`).

## One admission order for start, ensure, and routes

The invariant is stronger than “check before commit”:

> Before all relevant authorities answer, do not create or modify a lock file,
> SQLite database, journal, catalog backup, catalog, cache, config, profile,
> history row, or rollout line.

The common admission sequence is:

1. Resolve the effective paths without creating them. Canonicalize the existing
   `CODEX_HOME`, `OPENCODEX_HOME`, active config, active catalog, cache, journal,
   history DB, and provenance paths. A path-resolution failure is `unknown`.
2. Inspect service-home ownership. `foreign` or `unknown` stops Codex mutation.
3. Read `config.toml` without mutation and resolve external `model_provider`.
   External ownership stops every Codex mutation, including journal cleanup.
4. Inspect the journal without deleting or rewriting it. Validate schema, then
   classify the recorded writer as `alive | dead | unknown`. `alive` and `unknown`
   stop recovery and new apply. Invalid bytes are preserved and stop mutation.
5. Inspect provenance for every artifact that either direction could touch.
   Unknown or conflicting provenance stops that artifact and therefore prevents a
   full-convergence claim.
6. Read the persisted desired flag from disk with the pure diagnostic reader. Do
   not consult a server-captured `config` object.
7. For ON only, gather provider models and calculate candidate catalog/config bytes
   outside the lock. Gathering may await network I/O, but it writes nothing.
8. Only now open the per-canonical-`CODEX_HOME` lock outside `CODEX_HOME`. Part 3
   places the full-hash SQLite database in the private real-user-home namespace,
   explicitly rejecting both `tmpdir()` and either configurable home
   (`003_lock_protocol.md:35-47`, `003_lock_protocol.md:246-260`). Even that external
   lock artifact is forbidden before steps 1-6 answer.
9. Inside the lock, re-run steps 1-6 from disk. This is the authority and intent
   linearization point. A changed answer aborts with no native write.
10. Recover a valid dead-writer journal first, then commit the desired ON or OFF
    artifact transition. Recovery never runs past an external-provider veto.
11. Read observed state while still serialized. Release the lock before logging,
    app-server handling, network work, or retries.

`startServer()` currently invalidates `models_cache.json` unconditionally before
listen (`src/server/index.ts:362-403`). That is a Codex write and therefore belongs
behind this admission sequence; moving only `reconcileJournal` is insufficient.

### Startup

`handleStart` currently reconciles the journal before it checks the existing proxy
and later calls `syncModelsToCodex` after listen (`src/cli/index.ts:169-177`,
`src/cli/index.ts:312-321`). Startup should run the read-only authority sequence
before either journal repair or `startServer` cache invalidation. A refusal does
not prevent the proxy from listening for other clients. It suppresses all Codex
recovery/apply/remove work and records a specific unresolved reason.

After the proxy is live, desired ON may gather and enter the locked commit. Desired
OFF enters the same lock and restores. A crash after intent persistence but before
restore is ordinary: the next startup sees OFF, observes residue, and retries.

### Ensure

Ensure uses the same order before its current journal call
(`src/cli/index.ts:358-369`). The already-live and spawn-a-child branches must both
admit Codex separately; successful proxy health does not imply Codex convergence.
The parent’s post-spawn sync at `src/cli/index.ts:398-412` must receive the same
fresh authority and desired-state answer as the child.

### Route entry

Management authentication and request-body validation may happen first because
they do not touch Codex artifacts. Immediately after that, every Codex-mutating
route performs the common read-only admission. A status GET remains inspection-only
and never repairs.

For `POST /api/sync`, the fresh desired-state read happens before gather, then all
authorities and intent are re-read under the lock before commit. The route currently
passes the server’s startup-captured `config` into `syncModelsToCodex`
(`src/server/management/config-routes.ts:261-268`); that object cannot be an
admission source.

For an explicit toggle, `unchanged` means only that the desired flag already had
the requested value. The route still inspects and converges native artifacts under
the same lock. OFF intent is committed before removal so a crash is recoverable.
ON intent may remain persisted if apply later fails; observed state then reports
partial and startup/ensure retries it. Explicit native restore does not silently
change desired state.

## Artifact inventory and absence restoration

Filename is not provenance. A path called `opencodex-catalog.json` may predate the
current operation; a file at a custom `model_catalog_json` path may be user-owned;
and a missing file may be created later by either OpenCodex or Codex. The substrate
needs a durable per-operation artifact ledger that records, before the first write.
This ledger is an **INFERRED requirement**; the current journal and backup files do
not carry enough pre-image/post-image evidence for the full inventory. It records:

- canonical path and artifact kind;
- baseline state: `absent` or `present` with exact bytes/hash and relevant metadata;
- the OpenCodex post-image hash after each successful write;
- structural ownership facts where byte identity is expected to drift, such as
  exact routed slugs and history row originals;
- transaction identity and completion state.

The ledger belongs in the Codex integration’s owned record under
`OPENCODEX_HOME`, not in `CODEX_HOME`; Part 2 selects that same record for desired
state plus durable history convergence (`002_history_off_the_loop.md:298-335`). It
is created only after pre-lock authority passes and while the native-write lock is
held.

An artifact is “created by us” only when the ledger says its baseline was absent
and records the successful OpenCodex post-image. A familiar filename, slash in a
slug, marker comment, mtime, or presence in `OPENCODEX_HOME` is supporting evidence,
never sufficient by itself.

| Artifact | Current behavior | Restore when baseline was present | Restore when baseline was absent |
|---|---|---|---|
| `config.toml` root routing | Injection journals only when the file exists (`src/codex/journal.ts:60-81`) and later writes routing/profile/default fragments. Fallback restore strips structurally owned fragments (`src/codex/inject.ts:688-740`). | If current bytes match the recorded post-image, restore exact baseline bytes. If unrelated edits occurred, remove only unambiguous owned fragments and preserve edits; report historical restore as partial. Ambiguous markers or unknown provenance block. | If current bytes exactly match our post-image, delete the file. If another actor added content, preserve that content while stripping only owned fragments; absence is no longer safely reproducible, so report a preserved-drift conflict rather than deleting the user’s edits. |
| Embedded `[profiles.opencodex]` profile in `config.toml` | Removed as part of the config transform (`src/codex/inject.ts:696-705`). | Covered by the config baseline/post-image; never treat it as independent permission to overwrite the rest of the file. | Remove the owned section only. Delete the whole config only when the baseline was absent and the whole current file still equals our post-image. |
| `opencodex.config.toml` generated profile file | Journal stores either exact profile bytes or `null`; restore writes bytes or unlinks (`src/codex/journal.ts:71-90`, `src/codex/journal.ts:125-131`). `removeCodexConfig` otherwise unlinks by filename (`src/codex/inject.ts:723-742`). | Restore exact baseline only if current hash equals our post-image. Drift is a conflict unless an owned subsection format exists. | Unlink only when the ledger records baseline absent and the current hash equals our post-image. A same-named untracked file is not ours. |
| Active catalog (`opencodex-catalog.json` or custom path) | The active path comes from root `model_catalog_json`, else the default (`src/codex/catalog/parsing.ts:167-176`). Sync may materialize an absent catalog (`src/codex/catalog/bundled.ts:213-234`) and later overwrites it (`src/codex/catalog/sync.ts:507-569`). Restore uses backup plus native additions or removes routed rows (`src/codex/catalog/sync.ts:572-597`). | Exact post-image permits exact baseline restore. On drift, restore the baseline’s native fields and preserve verified post-apply native additions while removing the exact routed entries recorded by the ledger. Unknown JSON/provenance blocks. | Delete only if the current file is still the recorded OpenCodex post-image. If Codex or the user added native rows, remove recorded routed rows and preserve native rows, but report that baseline absence could not be restored without data loss. |
| Hashed and legacy catalog backups | Backups are created once and best-effort; both hashed and legacy paths may be written (`src/codex/catalog/parsing.ts:419-445`). Restore reads them but does not consume them. | Preserve exact pre-existing bytes. A collision between an existing backup and the operation’s expected baseline is `unknown`, never replacement authority. | Backups created by this transaction are internal rollback artifacts: delete them only after every dependent catalog/cache restore is complete. A ledger entry, not the backup filename, proves they were created by us. |
| `models_cache.json` | Apply rewrites it with an expired wrapper containing the current catalog (`src/codex/catalog/sync.ts:600-613`); `restoreNativeCodex` never calls a cache restore (`src/codex/inject.ts:770-794`). Errors are swallowed into `false`. | Restore exact baseline when current hash equals our post-image. If Codex refreshed it meanwhile, preserve native cache data and remove only ledger-recorded routed rows when parseable; unreadable or ambiguous cache is unresolved. | This is the audit’s invalidation/restoration distinction: if apply created it and it still matches our post-image, delete it. Rewriting an expired native wrapper is not restoration of absence. If a native process changed it, preserve the changed file, remove only proven routed residue, and report preserved drift. |
| Injection journal | Current version stores config/profile pre-images, optional post hashes, PID, and timestamp (`src/codex/journal.ts:8-18`). Complete restore deletes it (`src/codex/journal.ts:133-140`); malformed reads also delete it (`src/codex/journal.ts:97-105`). | A pre-existing valid journal represents an earlier transaction and must be recovered or explicitly superseded under its own rules; it is not overwritten merely because a new apply starts. Pre-existing invalid bytes are preserved and block. | A journal created for this operation is deleted only after every artifact it protects reaches its terminal restore state. Partial restore retains it. |
| Resume history database (`state_5.sqlite`) | Apply changes selected `threads` rows after recording row originals (`src/codex/history-provider.ts:581-650`). Restore writes original fields, then ejects leftover `opencodex` rows (`src/codex/history-provider.ts:656-699`). | Restore each recorded row’s exact provider/source/user-event fields. Do not claim completion while any selected row remains `opencodex` or its backup entry remains. SQLite/WAL bytes are not expected to be byte-exact. | Apply already checks DB existence and returns without opening when absent (`src/codex/history-provider.ts:581-583`); it must not create the DB. Absence therefore remains absence. |
| History backup manifest | Missing manifest is treated as an empty map; apply records each original only once, and an empty manifest is unlinked (`src/codex/history-provider.ts:204-237`). | Preserve unrelated/pre-existing entries and consume only transaction-owned entries after their DB and rollout observations agree. Corrupt or wrong-DB manifests are `unknown`, not silently empty. | Create only after at least one row is selected. Delete when all owned entries are restored; a zero-entry file must not remain. |
| Rollout JSONL files | OpenCodex never creates them on this path. It patches line one when length permits and appends a last-writer-wins `session_meta` (`src/codex/history-provider.ts:52-100`, `src/codex/history-provider.ts:412-457`). Current restore catches per-file failure and can still consume the manifest (`src/codex/history-provider.ts:667-695`). | Restore semantically, not byte-exactly: latest metadata and the first-line provider reader must both resolve to the native target. Keep the backup entry until that observation passes. Concurrent Codex turns remain untouched. | Apply must not create a missing rollout (`src/codex/history-provider.ts:419-423`). If a recorded rollout disappears, do not recreate it from partial metadata; resolve only when the corresponding DB row is also gone, otherwise report unresolved. |

The config/catalog/cache “baseline absent plus later native edit” case has no
lossless automatic answer. Deleting restores absence and destroys new data;
preserving new data means historical byte restoration is incomplete. The substrate
must prefer preservation and expose the conflict. That is the hardest ownership
problem in this part.

## Observed state is not desired state

The persisted flag is one boolean with an absent key in a valid file meaning ON.
An unreadable or invalid config is desired-state `unknown`, not default ON; treating
parse failure as intent would recreate the fail-open ownership bug. The flag answers
only the target direction. Observed state is a read-only projection over the actual
Codex artifacts and authorities.

The projection must read:

1. service-home ownership and external provider;
2. `config.toml` root `model_provider`, owned `openai_base_url`, active
   `model_catalog_json`, embedded profile, root routed model, and managed defaults;
3. `opencodex.config.toml` existence, hash, and provenance;
4. the active catalog’s parse state and all ledger-recorded routed slugs;
5. `models_cache.json` in both wrapper and raw-catalog shapes, including routed
   slugs and provenance;
6. journal absence/validity, writer liveness, transaction identity, and whether
   its post hashes match current config/profile;
7. history DB rows still tagged `opencodex`, remaining backup entries, and each
   touched rollout’s latest and first-line provider observations;
8. catalog backup/provenance residue whose baseline was absent.

**INFERRED projection:** the aggregate is not a boolean:

| Observed state | Meaning |
|---|---|
| `applied` | Config routing is active and every required profile/catalog/cache/history artifact agrees with the ON transaction. History expectation is mode-dependent: loopback Design B remains `openai`, while legacy non-loopback routing may use `opencodex` (`src/codex/inject.ts:57-63`, `src/codex/inject.ts:775-783`). |
| `absent` | No OpenCodex routing/profile/routed catalog or cache row/pending journal/history residue remains, and transaction-created rollback artifacts whose baseline was absent are consumed. |
| `partial` | Some ON or OFF artifacts match and others do not; this includes crash residue and missing ON artifacts after `ocx restore` or stop. |
| `external` | Another `model_provider` owns Codex. No mutation is allowed, even if OpenCodex residue is visible. |
| `blocked` | Service ownership is foreign/unknown, a journal writer is live/unknown, provenance is ambiguous, or an artifact cannot be inspected. |

“Converged” is the relation between fresh desired and observed state:

- desired ON + observed `applied` = converged;
- desired OFF + observed `absent` = converged;
- every other pair is not converged, with `external`/`blocked` carrying the
  authority that prevents repair.

This definition is why `unchanged` must still converge. A no-op desired-state
commit says only that the boolean already matched. OFF may still have routed cache
rows after a crash; ON may still have missing config/catalog/profile after restore
or stop. The route must inspect, execute the appropriate transition, and re-inspect
before reporting convergence (`008_audit_synthesis_wp4_r2.md:36-41`).

Operational convergence and historical restoration should be reported separately.
An OFF transition that removes every owned routed fragment while preserving a
post-apply native edit can be operationally absent but historically
`preserved-drift`; it must not claim byte-exact restoration.

## Fresh desired-state admission for a long-lived server

Recommend **re-read at every Codex mutation admission**, not a watcher and not a
process-local version counter.

The route should use the pure persisted-config diagnostic reader, require a valid
file-backed result, and extract only the Codex desired flag. It repeats the read
inside the linearization lock. The long-lived `config` object may still serve
unrelated request routing, but it is not authority for Codex mutation.

Cost per Codex-mutating request: one file open/read, JSON parse, and schema
validation before gather, plus the same bounded read under the commit lock. This is
O(config-file bytes), normally two local reads on an infrequent management/startup
path. It adds no resident watcher, debounce/rearm behavior, cross-platform rename
edge cases, or sidecar version file. A watcher can be an optimization later, but its
cache must never replace the admission read. A version counter cannot detect a CLI
or manual edit unless every writer participates, which is the exact stale-object
assumption that failed here (`src/server/management/config-routes.ts:261-268`,
`src/server/index.ts:362-364`).

## Tests that prove the authority and convergence contract

All cases use temporary `CODEX_HOME` and `OPENCODEX_HOME`; none starts, stops,
syncs, restores, or ensures the live proxy on port 10100.

### Ownership and ordering

- `tests/codex-ownership-authority.test.ts` — `service ownership distinguishes
  owned, foreign, and unknown without side effects`: cover no service, matching
  mirrors, foreign canonical home, installed-with-missing-mirror, corrupt,
  unreadable, conflicting mirrors, and unresolvable paths. Hash every fixture and
  assert no lock/database/journal path was created.
- `tests/codex-ownership-authority.test.ts` — **`dead-PID markerless journal plus
  external provider preserves every byte`**: seed a version-1 journal with no
  injected hashes and a dead PID; set an external `model_provider`; include config,
  generated profile, catalog, both backup forms, cache, history manifest, DB, and
  rollout sentinels. Run startup admission and ensure admission independently.
  Assert byte-exact equality, unchanged mtimes where supported, journal still
  present, zero lock artifacts, and an `external` refusal. This strengthens the
  current dead-PID test, which presently expects markerless overwrite and journal
  deletion (`tests/codex-journal.test.ts:53-75`).
- `tests/codex-ownership-authority.test.ts` — `invalid journal inspection is
  read-only`: corrupt and unknown-version journals remain byte-exact and block;
  this intentionally reverses the current deletion expectation
  (`tests/codex-journal.test.ts:77-89`).
- `tests/codex-ownership-authority.test.ts` — `authority precedes lock creation`:
  instrument every lock/path factory and artifact writer; foreign, unknown,
  external, live-journal, and unknown-journal cases must hit none.

### Artifact absence and drift

- `tests/codex-artifact-provenance.test.ts` — `baseline absence is restored for
  config, profile, catalog, backups, cache, journal, and history manifest`: apply
  into an empty isolated home, verify the ledger records `absent`, restore without
  drift, and assert every transaction-created artifact is absent again.
- `tests/codex-models-cache-restore.test.ts` — **`cache absent before apply is
  absent after OFF`**: begin with no `models_cache.json`, apply routed catalog data,
  assert apply creates the cache, then OFF must unlink it rather than rewrite an
  expired native wrapper. A second OFF is a no-write success. This is distinct from
  the existing invalidation test that proves creation (`tests/codex-models-cache-invalidate.test.ts:41-55`).
- `tests/codex-artifact-provenance.test.ts` — `absent baseline plus native drift is
  preserved and reported`: after apply creates config/catalog/cache, add native
  content through an independent fixture writer. OFF removes only ledger-owned
  routing, preserves native additions, and returns operational `absent` plus
  historical `preserved-drift`, never byte-exact success.
- `tests/codex-artifact-provenance.test.ts` — `pre-existing same-named files are not
  owned by filename`: omit the ledger or give it a conflicting transaction/hash;
  restore refuses rather than unlinking.
- `tests/codex-artifact-provenance.test.ts` — `pre-existing catalog backups survive`:
  exact backup bytes remain after apply/restore, while transaction-created hashed
  and legacy backups are consumed only after catalog and cache restore.

### Observed state and unchanged convergence

- `tests/codex-observed-state.test.ts` — table-drive `applied`, `absent`, every
  one-artifact `partial`, `external`, unreadable/invalid `blocked`, stale first-line
  rollout metadata, and a non-empty history manifest with no matching DB row.
- `tests/codex-convergence.test.ts` — `desired OFF unchanged still removes crash
  residue`: persist OFF first, seed each routed artifact one at a time, invoke the
  setter again, and prove every case converges rather than returning after
  `unchanged`.
- `tests/codex-convergence.test.ts` — `desired ON unchanged rebuilds removed
  artifacts`: persist ON, remove config/profile/catalog/cache independently, and
  prove the no-op flag commit still applies and re-inspects.
- `tests/codex-sync-api.test.ts` — `server observes CLI desired-state change at
  admission`: construct the server with a stale ON object, persist OFF from a
  subprocess, call `POST /api/sync`, and assert refusal plus zero gather/write;
  then persist ON from the subprocess and assert the same running server admits.
- `tests/codex-convergence-order.test.ts` — startup, both ensure branches, explicit
  route, sync route, restore, stop, and uninstall all emit an ordered trace proving
  `path -> service ownership -> external provider -> journal -> provenance -> fresh
  intent -> gather -> lock -> recheck -> commit -> observe`. Foreign/external traces
  end before `lock`.

The final oracle is artifact state, not a green return envelope: cache absence,
journal preservation, first-line rollout provider, and no-created-lock assertions
are each read back after the operation.

## Decision

Service-home ownership, external provider ownership, journal writer ownership, and
artifact provenance are independent vetoes. The common admission path consults
them in that order before intent, gather, and lock creation, then rechecks them
inside the lock. Desired state is freshly read for every mutation, and convergence
is proved from config, profile, catalog, cache, journal, history, and rollouts — not
from whether the desired-state write happened to change one JSON field.
