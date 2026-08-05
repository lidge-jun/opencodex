# WP10 — history isolation: one client turning off cannot freeze every client

Research: `002_history_off_the_loop.md`. Shared contract: `005_contract.md`.

Today every history mutation is synchronous on its caller. Apply opens
`state_5.sqlite`, writes the manifest and rollouts, then commits the DB transaction
(`src/codex/history-provider.ts:585-653`). Restore reads the manifest, writes
rollouts, commits the DB, removes the manifest, and then performs the residual
ejection (`src/codex/history-provider.ts:656-698`). SQLite serializes only the DB
portion; it does not serialize the manifest and rollout files around it.

The path is also not one operation. `injectCodexConfig` deliberately does nothing
when `syncResumeHistory === false`, forward-tags history to `opencodex` only in
legacy mode, and otherwise migrates history back to `openai`
(`src/codex/inject.ts:602-604`). Native restore invokes the manifest-consuming
`openai` restore/eject path (`src/codex/inject.ts:765-800`), while
`ocx recover-history --legacy-openai` invokes the manifest-independent legacy ejection
(`src/cli/index.ts:711-724`). A Worker request containing only a caller-selected
provider cannot preserve those distinctions.

This plan was previously based on a false landing premise. WP9 did **not** supply a
working full `convergeCodex`: the executable export is catalog-only
(`src/codex/convergence.ts:421-440`), management rejects every non-catalog request
(`src/codex/management-convergence.ts:89-106`), and full admission remains only the
`AdmissionSnapshot` type (`src/codex/convergence-types.ts:495-520`). Native apply and
restore still execute directly (`src/codex/inject.ts:482-654,765-800`). WP10 therefore
cannot consume a full authority snapshot, native receipt, or `CommitExpectation`
without implementing WP11/WP12 work.

## Phase boundary — history isolation now, full convergence in WP12

WP10 takes the reviewer's second option.

Every **current high-level history operation** enters `history-job` and H in this
phase. Existing apply, restore, explicit recovery, startup retry, CLI, service, and
management roots keep their current native/catalog semantics, but none may call a
history DB/manifest/rollout writer inline. WP10 persists the contract-owned typed
`CodexHistoryOperation`, dispatches its identity to the Worker, and records its result.

The latest review exposed one ordering gap that cannot wait for WP11. Current apply
writes config/profile/journal before history (`src/codex/inject.ts:594-604`), and
restore changes config plus K-serialized catalog state before history
(`src/codex/inject.ts:765-789`). If compatibility authorization runs only after that
native root returns and refuses an older running schedule, a newer opposite native
mutation can be committed without any durable history repair operation. WP10 therefore
brings forward one narrow native exclusion: each retained native mutation and its
compatibility history authorization execute in one N-backed synchronous handoff.
N is acquired before the native callback, the newer schedule is published through the
same open transaction before the callback returns, and N is released before Worker
spawn/await.

The desired-state-driven `convergeCodex({ scope: "full" })` caller rewire is deferred
to WP12. WP12 changes the producer of the durable history operation after full
admission and native coordination exist; it reuses the same `history-job`, Worker, H,
typed operation, writer split, and terminal-state protocol delivered here. WP10 does
not add a temporary convergence implementation, fake admission snapshot, synthetic
native receipt, or placeholder that a later phase replaces.

This boundary is independently landable: WP10 typechecks while full convergence still
rejects non-catalog requests, and current user-visible high-level operations preserve
their distinct history semantics through the Worker. It consumes the already-landed N
path/transaction owner; it does not pre-implement WP11's full native lock.

All current-code citations in this document were rechecked on 2026-08-05 at
`8a8323f7885da957120218495715cab8593a5d66`.

## IN / OUT

IN:

- `src/codex/convergence-types.ts` (MODIFY) — materialize the
  contract-owned `CodexHistoryOperation`, closed compatibility-native intent, typed
  manifest-read result, and durable history-operation schedule/result shapes from
  `005_contract.md`; do not define a WP10-local provider/direction union.
- `src/codex/user-identity.ts` (MODIFY) — add
  `resolveCodexHistorySerializationDatabasePath` beside the existing N and K
  resolvers. It keys H by effective user, canonical `CODEX_HOME`, and canonical
  state-DB path; consumers append no path segment.
- `src/codex/transition-state.ts` (MODIFY) — persist/read the typed history operation
  and its operation identity, expose the history-specific schedule/claim/terminal CAS
  used by current roots, retain the operation for guardian restart, and expose the
  narrow synchronous N-backed compatibility handoff plus its private routed-install
  adoption mode. Replace the current `lstat`-then-SQLite-`create:true` absence flag with
  a complete v1 temp coordinator created exclusively in the final directory and
  atomically published by no-replace link/rename before native mutation. The singleton
  is generation-zero/null-txId `adoption-pending` with the exact non-recovery operation,
  fresh job/authority identity, null reason/timer/probe counts, and
  `wp10-compatibility` authority. `EEXIST` always takes the strict existing-database
  path; an existing unversioned or rowless database is never adopted. This is an opener
  behavior change, not a new public `openCodexCoordinatorTransaction` parameter. The transaction-bound,
  one-shot
  compatibility authorizer may supersede an older terminal, pending, or running
  schedule after the newer retained native mutation and receives no caller-supplied
  expected row; this is not a producer of native generations or full authority
  snapshots.
- `src/codex/history-lock.ts` (NEW) — H: one cross-process,
  canonical-`CODEX_HOME`/effective-user keyed SQLite exclusion primitive using the
  contract resolver, finite acquisition, and no stale PID/mtime takeover.
- `src/codex/history-provider.ts` (MODIFY/SPLIT) — retain read/probe behavior and the
  typed manifest parser; remove all DB/manifest/rollout writers and module-global
  execution policy.
- `src/codex/internal/history-writer.ts` (NEW) — the exhaustive implementation of
  every `CodexHistoryOperation`, including manifest-consuming restore and manifest-independent
  legacy ejection. Only `history-worker.ts` may reach it.
- `src/codex/history-worker.ts` (NEW) — acquire H, resolve and validate the durable
  operation through N, mutate all three surfaces, run the typed post-probe, publish the
  terminal CAS, release H, and close.
- `src/codex/history-job.ts` (NEW) — resolve explicit paths/options, schedule the
  typed operation durably as the sole root of the WP10 compatibility/explicit-recovery
  authorizers, derive the closed retained-apply/retained-restore adoption intent,
  enter the N-backed compatibility handoff before invoking a retained synchronous
  native callback, recover a valid `adoption-pending` row only by re-running a real
  current retained callback, spawn/watch/join the Worker only after N releases and
  the row is dispatchable `pending`,
  classify IPC/death, and expose one async entry point to every current high-level
  root.
- `src/codex/inject.ts`, `src/codex/sync.ts`,
  `src/codex/history-migration-guardian.ts` (MODIFY) — preserve current native/catalog
  behavior but replace inline history calls with `history-job`; the guardian reads and
  retries the durable operation instead of calling the provider.
- `src/cli/init.ts` (MODIFY) — `ocx init` and its `setup` alias retain the history
  migration currently inherited from `injectCodexConfig`
  (`src/cli/init.ts:194-198`; `src/cli/index.ts:727-732`).
- `src/cli/index.ts`, `src/cli/models.ts`, `src/cli/provider.ts`, `src/cli/v2.ts`,
  `src/service.ts` (MODIFY where async propagation is required) — await the existing
  high-level operation through `history-job`; no command imports a history writer.
- `src/server/management-api.ts`, `src/server/management/config-routes.ts`,
  `src/server/lifecycle.ts` (MODIFY) — await the same high-level operation and join
  live history Workers during drain.
- `src/cli/doctor.ts` (MODIFY) — combine durable history state with a typed live
  read-only probe; unavailable evidence remains unknown.
- `tests/codex-history-provider.test.ts`,
  `tests/codex-transition-state.test.ts`,
  `tests/codex-native-residue.test.ts`,
  `tests/codex-convergence-contract.test.ts`,
  `tests/history-migration-guardian.test.ts`,
  `tests/codex-sync-api.test.ts`, and `tests/shutdown-drain.test.ts` (MODIFY), plus
  `tests/codex-history-worker.test.ts`,
  `tests/codex-history-worker-responsive.test.ts`,
  `tests/codex-history-process-routing.test.ts` (NEW).

OUT:

- A full `convergeCodex`, `AdmissionSnapshot` capture, desired-state observer,
  provenance authorization, or the WP12 caller rewire.
- WP11's full `codex-write-lock.ts` mechanism: uid/SID lock-namespace mechanics,
  canonical target/admission validation, finite async acquisition/retry and typed
  result API, `CommitExpectation`, provenance coordination, and broad adoption by
  every native writer. WP10 takes only the already-owned N transaction as a
  synchronous exclusion from each retained native mutation through compatibility
  authorization.
- Any claim that WP9 handed WP10 a working full funnel. It did not.
- Replacing current native/catalog orchestration. In particular,
  `src/codex/inject.ts:775-780` is WP9's K-serialized catalog restore; it remains a
  catalog operation and is not copied into the history Worker.
- `/api/sync` response-contract redesign; WP10 only preserves the current route while
  moving its inherited history operation off-thread.
- GUI, traversal chunking, release/deploy work, or touching the live proxy on 10100.

## Durable operation, not caller-selected provider

The shared contract's `CodexHistoryOperation` is the only executable direction. It
must distinguish at least these existing semantics without flattening them:

| Durable `CodexHistoryOperation` | Existing evidence | Worker behavior |
|---|---|---|
| `skip` | `syncResumeHistory === false` at `src/codex/inject.ts:602-604` | Enter the job/H validation path, perform no manifest/rollout/history-DB read or write, and record `converged` with null counts because no zero/zero claim is made. |
| `apply-opencodex` | legacy branch at `src/codex/inject.ts:602-604` | Manifest-backed forward-tag to `opencodex`. |
| `migrate-openai` | non-legacy branch at `src/codex/inject.ts:602-604` | Manifest-consuming restore followed by residual ejection to `openai`. |
| `restore-openai` | `src/codex/inject.ts:781-800` | Generic native removal: consume the matching manifest and eject residual routed rows, with the current no-op-probe policy retained. It stays distinct from migration because authorization/retry cause differs. |
| `recover-legacy-openai` | `src/cli/index.ts:711-724` | manifest-independent legacy ejection; it must not read, consume, delete, or replace the backup manifest. |

The operation is DERIVED by the caller-facing convergence path from what it already
admitted, never chosen at the Worker boundary. `history-job` does not decide it: the
module mechanically persists the derived operation through the contract-owned history
scheduling API and receives an opaque durable job identity. A serialized Worker
message accordingly contains no `targetProvider`, no caller-chosen `direction`, and no
`CommitExpectation`.
The Worker request carries the job id, operation, and `CodexHistoryAuthority` copied
from the row, plus structured-clone-safe explicit paths and invocation-local execution
options.

After acquiring H, the Worker reads N and obtains the durable schedule. It executes
only when native pair, job id, operation, and authority are current and well-formed.
The durable value is authoritative: the Worker validates the IPC copy against it and still
dispatches from the durable value. A missing,
superseded, malformed, or mismatched operation produces the typed non-success outcome
and performs no history write. A caller can therefore neither turn generic restore
into manifest-independent recovery nor bypass `syncResumeHistory: false` by choosing a provider.

WP12 later schedules the same type from admitted desired state. That is a caller-root
change, not a history-mechanism replacement.

### Contract bridge for the chosen WP10 boundary

WP10 consumes `AuthorizeCodexCompatibilityHistory` for current `skip`,
`apply-opencodex`, `migrate-openai`, and `restore-openai` roots. It conditionally
publishes job id + typed operation +
`CodexHistoryAuthority { kind: "wp10-compatibility", id }` without advancing or
inventing a native routing generation and without pretending to possess WP12's
`AdmissionSnapshot`. `recover-legacy-openai` uses
`AuthorizeCodexLegacyHistoryRecovery` and
`{ kind: "explicit-legacy-recovery", id }`. WP12 alone uses
`BeginCodexTransition` with `{ kind: "admission-snapshot", id }`.

`history-job.ts` is the sole WP10 compatibility adapter. The existing owning
apply/restore function derives the semantic operation from its internal branch and
passes that type plus its synchronous native mutation callback to `history-job`, not
a user-controlled provider/direction. `history-job` acquires the transition-state
owner's N-backed handoff before invoking that callback and authorizes through the
one-shot `authorize(next)` closure bound to the complete row read from the same open
transaction after N acquisition. The closure has no `expected` parameter, performs no
read, and opens no second connection. This shape is mandatory: a pre-N expected row
can become stale before N is acquired, while `readCodexTransitionState()` opens
another `BEGIN IMMEDIATE` (`src/codex/transition-state.ts:473-489`) and would
self-contend against the handoff. Explicit recovery has no native callback and retains
its separate terminal-only authorizer. CLI, server,
`inject.ts`, guardian, and other helpers never import either transition-state
authorizer directly. The handoff rejects zero or multiple authorization calls and
use after callback return. Compatibility authority ids are fresh opaque nonces, never
config/credential digests and never logs. WP12 dispatches already-admitted schedules
through the same job/Worker code and stops using the compatibility-handoff branch.

The compatibility handoff's CAS matches the complete row observed at N acquisition
and writes a fresh pending job/operation/authority even when the replaced state is
`pending` or `running`. Because N excluded both retained native callbacks, this is the
newer native operation by construction. Refusing non-terminal work here would recreate
the reviewed loss: B's opposite native bytes would already exist with no B schedule.
An older Worker remains free to finish its in-memory mutation under H, but its terminal
CAS includes the replaced identity and changes zero rows; B's pending schedule remains
for the guardian. `AuthorizeCodexLegacyHistoryRecovery` stays terminal-only because it
has no native mutation whose ordering would justify superseding unresolved native
repair.

The eleventh recurrence of this unit's absence-as-guarantee defect is at installation
adoption. No production caller currently initializes N: the exported transaction/read/
begin implementations are at `src/codex/transition-state.ts:348-385,473-518`, while
the production tree has no external reference to them. The strict initializer refuses
all routed residue before inserting the singleton
(`src/codex/transition-state.ts:263-303`), and the real routed-catalog fixture proves
that a missing coordinator is `legacy-ambiguous`
(`tests/codex-native-residue.test.ts:213-242`). Existing routed installations would
therefore fail before apply or restore reached their retained callback.

The twelfth recurrence is creation ownership itself. The current owner remembers
`ENOENT` from `lstatSync` (`src/codex/transition-state.ts:356-373`), later opens with
SQLite `create:true`, and initializes from that stale boolean
(`src/codex/transition-state.ts:374-385`). Another process can create an
unversioned/rowless coordinator between those steps. Row absence after
`BEGIN IMMEDIATE` does not distinguish that partially initialized existing database
from one this process created.

The thirteenth recurrence is the process-death disposition of the proposed fix. An
exclusive empty final-path claim survives kill even though its descriptor closes;
the next process receives `EEXIST`, and the strict initializer rejects the surviving
version-zero file at `src/codex/transition-state.ts:282-303`. `finally` cleanup proves
only caught-failure recovery. With no committed transition row or history schedule,
the guardian has no authority from which to repair the installation.

WP10 preserves that general guard. Ordinary reads, Worker/guardian paths, explicit
recovery, `BeginCodexTransition`, and direct transaction opens may initialize only a
native-clean, non-legacy installation. They continue to refuse invalid/legacy JSON,
routed or indeterminate native evidence, unsupported/unversioned coordinator files,
and existing databases with no row. The compatibility handoff alone receives a
private adoption mode. “Positively authorized” means its sole permitted graph root is
`history-job.ts`, it is paired with the real retained synchronous native callback,
and its closed intent is exactly `retained-apply` with
`skip | apply-opencodex | migrate-openai` or `retained-restore` with
`restore-openai`. Mere residue detection, observation, retry, history-only recovery,
or an arbitrary operation cannot request adoption.

The ordinary clean initializer uses the same complete-database publication mechanism
as adoption: a unique same-directory temp receives the full v1 schema and authoritative
generation-zero/null-txId `unknown` singleton with null schedule/reason/timer/probe
fields and zero attempts, then is atomically published no-clobber. No initializer
opens a missing final path with SQLite `create:true`; every coordinator first visible
at the final name is already versioned and row-bearing.

For a truly absent coordinator, the handoff must publish a complete valid database
before any native callback. It exclusively creates a unique mode-`0600` temp in the
final directory, opens SQLite at that temp path, commits the full contract schema and
`user_version = 1`, closes with no live journal/WAL sidecar, reopens through the
ordinary validator, and fsyncs the database. Its singleton contains exactly
generation zero/null current txId; `history_status='adoption-pending'`; null reason,
retry time, and probe counts; zero attempts; the exact intent-derived non-recovery
operation; and fresh non-empty job plus `wp10-compatibility` authority ids. This is a
typed durable native-handoff state, not a dispatchable history schedule.

Publication uses a same-directory exclusive hard link or platform
rename-without-replace equivalent, followed by parent-directory fsync. Ordinary
replacing rename is forbidden. `EEXIST`, including a file created after an earlier
`ENOENT`, scrubs only the unpublished temp and takes the strict existing-database
path. A hard-link temp alias is removed only after the complete final name exists.
No SQLite handle opened on the temp crosses publication. A preliminary `lstat`
remains path-safety evidence only; row absence and path absence are never authority.
Cooperating processes never open a published or stale temp alias as SQLite; after a
crash they may only unlink an alias whose non-symlink regular-file identity matches
the validated final database.

The residue classifier evaluates every surface and gives any indeterminate result
precedence (`src/codex/native-residue.ts:520-556`). Only the private positively
authorized high-level handoff, together with a missing/valid non-legacy integration
record and positive routed classification, may construct and publish the initial
`adoption-pending` database. The state is never inserted into an existing database
and never inferred from residue. Existing malformed, unsupported, unversioned, or
rowless coordinators remain strict refusals, and no `OPENCODEX_HOME`-local pair is
imported.

After publication, the handoff opens the final path with
`{ readwrite:true, create:false }`, takes N, and reads the complete row. Only a new
positively authorized real retained apply/restore handoff may move
`adoption-pending` in WP10. It re-runs its current closed-intent native callback, then
the same transaction-bound `authorize(next)` conditionally replaces the observed row
with the current exact generation-zero/null-txId `pending/wp10-compatibility`
schedule. Its operation may match or supersede the interrupted operation; N makes the
resulting schedule order equal the retained native-mutation order. WP12 full admitted
native convergence may later supersede it through `BeginCodexTransition`.

Ordinary read/doctor returns the valid typed state; Worker/guardian claim and terminal
paths, explicit legacy recovery, and residue observation cannot transition or dispatch
it. Startup's real apply/restore path recovers automatically. If a bounded explicit
attempt cannot complete, it returns the actionable ready state
`history.status='adoption-pending'` with “rerun the same requested apply/restore.” A
callback throw, authorization failure, or process death leaves the durable row
unchanged rather than unlinking the final database.

Crash behavior is complete: death before publication leaves the final path absent and
at worst a non-authoritative unique temp; death during the atomic no-replace operation
leaves the final path either absent or a complete valid v1 row; death after publication
or during the retained callback leaves recoverable `adoption-pending`. Caught
pre-publication cleanup may exact-identity-unlink only its unpublished temp. Among
**cooperating** processes that cleanup never unlinks a committed valid final-path row;
a foreign in-place writer can retain identity, so identity protects against path
substitution but does not prove unchanged content.

The Worker claim/terminal CAS matches native pair, job id, operation, and complete
authority. A compatibility authority can never be relabeled as admission authority.
This is one contract row and one terminal protocol, not a WP10-private store.

The graph guard consumes the contract's `wp10-history-isolation` inventory version:
`history-job.ts` may reach only the compatibility and explicit-recovery authorizers,
while `history-worker.ts` may reach only the transition reader/terminal updater plus H
and the history writer. The WP12-final version removes the job authorizer root when
full convergence becomes the producer; it retains the Worker root.

## Worker boundary and explicit process state

The Worker owns the whole mutable unit:

1. apply captured `CODEX_HOME`/`OPENCODEX_HOME` before dynamically importing any
   history module;
2. acquire H from the final path returned by the H resolver;
3. read N and resolve/validate the current durable `CodexHistoryOperation`;
4. perform the typed manifest read only for operations that consume/update the
   manifest; `skip` and `recover-legacy-openai` do not read it;
5. open, query, transact, and close `state_5.sqlite` within the invocation;
6. perform every manifest write/delete and rollout line-one patch/append/fsync;
7. run the final typed DB + manifest post-probe while H remains held;
8. publish the operation-identity-conditioned terminal update through N;
9. release H and close the Worker in `finally`.

Moving only `Database` calls is insufficient: apply writes manifest and rollouts before
its DB transaction (`src/codex/history-provider.ts:606-648`), and restore writes
rollouts, DB, manifest deletion, and residual ejection in sequence
(`src/codex/history-provider.ts:656-695`). Moving only server callers is also
insufficient because CLI/service/management paths currently share the same inline
helpers.

The Worker is a separate process context. The current module binds
`STATE_DB_PATH`/`HISTORY_BACKUP_PATH` at module load
(`src/codex/history-provider.ts:16-22`) and stores busy timeout in mutable module state
(`src/codex/history-provider.ts:31-49`). WP10 replaces both with absolute request paths
resolved before spawn and invocation-local options applied to each DB open. This is
feasible without connection transfer: apply, restore, legacy recovery, and the probe
open and close their DB handles per invocation
(`src/codex/history-provider.ts:585-653,656-698,701-710,757-770`).

The request parser rejects blank operation ids, non-absolute paths, path/identity
mismatch, non-finite or negative numeric options, unknown message variants, and test
checkpoints outside the injected test supervisor. `requestId` rejects stray IPC.
Every crossing value is structured-clone data; no `Database`, function, config object,
or lock capability crosses the boundary.

## H database and the real lock order

H is a sibling database, not N or K. `resolveCodexHistorySerializationDatabasePath`
returns the final database path for effective user plus canonical `CODEX_HOME` plus
canonical state-DB identity; callers append nothing. H uses
`busy_timeout=0` and `BEGIN IMMEDIATE` with bounded async outer acquisition. There is
no PID/mtime stale takeover; process/connection death releases SQLite exclusion.

The previous plan's statement that H and N are never held simultaneously was false.
`readCodexTransitionState` opens a `BEGIN IMMEDIATE` initialization transaction
(`src/codex/transition-state.ts:473-489`), and
`updateCodexHistoryTransition` opens another `BEGIN IMMEDIATE` terminal transaction
(`src/codex/transition-state.ts:521-565`). The Worker invokes both while H protects the
history surfaces. The actual edge is therefore:

```text
current high-level root: N -> retained native mutation -> authorize typed operation
                         through same N -> commit/release N -> spawn Worker
history Worker:          H -> short N(read/claim) -> release N
                        H -> mutate/probe
                        H -> short N(terminal CAS) -> release N -> release H
```

The high-level line above now means: acquire N, execute the retained synchronous native
mutation, authorize its exact compatibility operation through the same open N handle,
then commit/release N before spawn. Where restore already uses catalog serialization,
that callback follows N → K; any nested config-generation guard remains K → C. The
checkable global order is still **H → N → K → C**. `N → H` is forbidden: scheduling
commits and releases N before spawn/await. H never enters K or the config-generation
lock, and K/config paths never enter H. WP11 later replaces this narrow compatibility
handoff with its full async native-lock API and broader adoption, but it preserves the
same release-before-dispatch rule. WP12 dispatches only after releasing native
coordination. A busy N claim/terminal attempt leaves the durable operation pending,
releases H, and retries later; it never waits indefinitely while retaining H. No cycle
appears because the only history edge enters N from H, while every N owner is forbidden
from acquiring or awaiting H.

“Through the same open N handle” is a connection-counted invariant, not shorthand for
re-entering the owner. The handoff reads the complete existing row once after
acquisition and closes over it; first adoption publishes the durable
`adoption-pending` row before that acquisition, while recovery closes over the complete
valid row read from the final database and the current closed high-level intent.
The callback can retain any stale pre-N
observation, but no API accepts it. Any `readCodexTransitionState` call or other
coordinator connection created inside the callback is a test failure.

The lock-order contract test contains allowed fixtures for `H -> N` claim/terminal
calls and forbidden fixtures for `N -> H`, `K -> H`, `H -> K`, and
config-lock-to-H edges. Reversing the schedule/spawn order to await the Worker while N
is live must turn that test red.

## Typed manifest evidence — absence is not success

The current `readBackup` collapses a missing file, malformed JSON, unsupported shape,
and a manifest for another state DB into an empty manifest
(`src/codex/history-provider.ts:204-217`). The pending probe then initializes
`backupEntries = 0` and suppresses manifest failures
(`src/codex/history-provider.ts:749-755`). Combined with a missing DB returning
`pendingRows = 0` (`src/codex/history-provider.ts:756`), unread evidence can certify a
false zero/zero convergence.

WP10 consumes the contract-owned typed manifest read. The reader must preserve these
distinct states through mutation and post-probe:

| Evidence | Classification | May certify zero entries? |
|---|---|---|
| manifest absent and DB readable | `missing`, `backupEntries: 0` | Yes, only after the DB probe also succeeds. |
| valid present matching v1 manifest with `entries: {}` | `ready`, present manifest, validated `backupEntries: 0` | Yes; it certifies a present empty file, not absence. |
| valid present matching v1 manifest with entries | `ready` with a validated positive count | Yes. |
| malformed JSON | `malformed`, null count | No. |
| readable unsupported version/shape | `unsupported`, null count | No. |
| unreadable/permission failure | unreadable | No. |
| manifest identifies another state DB | `foreign-state-db`, null count | No. |
| DB missing while a valid backup has entries | pending/blocked restore work | No. |

Only a successful typed DB probe and successful typed manifest read may produce
numeric counts. `unreadable` maps to `unknown/unreadable`, malformed/unsupported maps
to `unknown/schema`, and a foreign manifest maps to
`blocked/foreign-state-db`, all with null manifest count. Generic restore never treats
a foreign-DB manifest as empty and never deletes it; manifest-independent legacy recovery does not
consume the manifest at all.

Fixtures cover malformed JSON, unreadable file, unsupported shape, wrong DB identity,
and missing DB with a nonempty backup. The tenth absence-as-guarantee fixture also
seeds the accepted current shape `{ version: 1, stateDbPath, entries: {} }`: preflight
must return present `ready` zero, generic restore must take the empty-manifest branch
and eject residual routed rows (`src/codex/history-provider.ts:656-665`), and the
post-probe must still report present `ready` zero without changing the manifest bytes.
This plan uses one `ready` variant with a branded non-negative count because presence
is already carried by `manifest:T`; a separate `ready-empty` branch would add control
flow without preserving more evidence. Reintroducing `catch { return emptyManifest }`,
`catch { backupEntries = 0 }`, requiring a positive ready count, or mapping ready-zero
to missing/unsupported must turn its named fixture red.

## Writer reachability: one permitted production root

`history-provider.ts` currently mixes read exports with mutators: read-only
`readLatestSessionMeta`, `readThreadFieldsFromRollout`, and
`countPendingOpencodexHistory` coexist with `syncCodexHistoryProvider`,
`restoreLegacyOpenaiHistory`, and `migrateHistoryToOpenai`
(`src/codex/history-provider.ts:263-274,348-422,565-579,701-731,749-775`). Split it so
the production graph has one writer root:

```text
history-worker.ts -> history-lock.ts (H)
history-worker.ts -> transition-state.ts (durable operation claim/terminal CAS)
history-worker.ts -> internal/history-writer.ts
internal/history-writer.ts -> manifest writes/deletes
                           -> rollout line-one patch + append + fsync
                           -> history DB transactions
```

No CLI, server, guardian, `inject.ts`, `sync.ts`, compatibility wrapper, barrel,
re-export, or dynamic import may reach `internal/history-writer.ts` or its mutating
symbols. Tests invoke the public job/Worker boundary; focused writer unit fixtures may
import the internal module only from the test allowlist.

The guard is symbol-level, not regex counting. Build a TypeScript `Program` and
`TypeChecker`, resolve import aliases, re-exports, namespace access, and string-literal
dynamic imports, then compute reachability from every production entry symbol to the
writer symbols. The current route-count test merely counts the literal text
`await convergeCodexCatalog()` (`tests/codex-convergence-contract.test.ts:232-250`);
that approach cannot prove this boundary.

The graph fixture includes negative variants that must fail:

- wrapper calls writer, caller imports wrapper;
- barrel re-exports writer under another name;
- aliased named import calls writer;
- namespace import calls writer;
- string-literal dynamic import calls writer;
- new production module reaches writer without appearing in the caller table.

## Current production caller inventory

WP10 rewires the existing high-level operations, not a nonexistent full funnel. The
symbol-level test owns this table as data and proves each listed command/route reaches
`runCodexHistoryJob` when its current semantics request history, never a writer.

| Production command/route | Current history-bearing chain | WP10 terminal edge | Named broken change that must fail |
|---|---|---|---|
| `ocx init`, `ocx setup` | command dispatch -> `runInit` -> `injectCodexConfig` (`src/cli/index.ts:727-732`; `src/cli/init.ts:194-198`) | typed apply operation -> job | Restore direct `injectCodexConfig` history mutation or remove the job await from init. |
| `ocx start` | `handleStart` -> `syncModelsToCodex`; starts guardian (`src/cli/index.ts:318-321`) | apply job + durable guardian retry | Startup stops arming the guardian, or inject runs inline. |
| `ocx ensure` | existing/live and spawned paths call `syncModelsToCodex` (`src/cli/index.ts:358-412`) | apply job | Either ensure branch bypasses/does not await the job. |
| `ocx sync` | command -> `syncModelsToCodex` (`src/cli/index.ts:827-842`) | apply job | Sync calls provider writer directly. |
| `ocx restore back`, `ocx eject back` | command -> `syncModelsToCodex` (`src/cli/index.ts:745-764`) | apply job | Back-switch returns before job dispatch. |
| `ocx restore`, `ocx eject` | command -> `restoreNativeCodex` (`src/cli/index.ts:765-790`) | generic restore job | Restore keeps the current inline `syncCodexHistoryProvider("openai")`. |
| `ocx stop` | `handleStop` -> `restoreNativeCodex` (`src/cli/index.ts:456-551`) | generic restore job | Stop reports completion without awaiting Worker join. |
| `ocx uninstall`, `ocx remove` | `handleUninstall` -> `restoreNativeCodex` (`src/cli/index.ts:554-593,795-798`) | generic restore job | Uninstall invokes synchronous restore wrapper. |
| `ocx restart` | `handleStop` then `handleEnsure` (`src/cli/index.ts:968-973`) | restore job then apply job | Restart overlaps the two jobs or skips either await. |
| hidden `__tray-start`, `__tray-restart` | tray start launches the ordinary start process; restart awaits `handleStop` then tray start (`src/cli/index.ts:415-453,944-954`) | startup apply job; restart restore then apply | Tray restart starts before restore joins, or direct start bypasses ordinary startup. |
| `ocx recover-history --legacy-openai` | `handleRecoverHistory` -> `restoreLegacyOpenaiHistory` (`src/cli/index.ts:711-724,792-794`) | manifest-independent legacy-eject job | Recovery maps to generic restore and consumes manifest. |
| `ocx provider ... --sync` | provider mutation -> `syncModelsToCodex` (`src/cli/provider.ts:232-238`) | apply job | Provider sync imports writer or drops job await. |
| `ocx models/model ...` live sync | model mutation -> `syncModelsToCodex` (`src/cli/models.ts:102-108`) | apply job | Model sync returns after catalog only. |
| `ocx v2 mode/on/off` | dynamic import of `syncModelsToCodex` (`src/cli/v2.ts:143-170,177-196`) | apply job | Dynamic-import alias bypasses the job; this exercises alias/dynamic reachability. |
| `POST /api/sync` | route -> `syncModelsToCodex` (`src/server/management/config-routes.ts:261-268`) | automatic apply job | Route responds while history remains inline or untracked. |
| `POST /api/stop` | route -> `restoreNativeCodex` (`src/server/management-api.ts:220-247`) | automatic generic restore job + drain join | Route schedules process exit before Worker join. |
| `ocx service stop` | service command -> `restoreNativeCodex` (`src/service.ts:2564-2595`) | explicit generic restore job | Service stop calls sync restore. |
| `ocx service start` | service command starts the installed daemon (`src/service.ts:2560-2564`) | daemon's ordinary startup apply job | Service-specific startup bypasses the ordinary startup/guardian root. |
| `ocx service uninstall/remove` | service command -> `restoreNativeCodex` (`src/service.ts:2610-2635`) | explicit generic restore job | Service uninstall drops/does not await job. |
| graceful SIGINT/SIGTERM/SIGHUP shutdown | drain then cleanup (`src/cli/index.ts:277-310`) | cancel/join active job, then await generic restore when policy requires it | Shutdown leaves history inline in `syncCleanup` or exits before join. |
| `process.on("exit")` / forced exit | synchronous callback at `src/cli/index.ts:310` | no history mutation; any existing durable pending operation remains for next startup | Exit hook imports writer or tries to spawn/await a Worker. |
| history guardian retry | timer currently calls provider directly (`src/codex/history-migration-guardian.ts:43-95`) | reread durable operation -> automatic job | Fake-clock test still passes after guardian startup dispatch is removed. |

The table is exhaustive for production references to the current history-bearing
helpers, derived from `injectCodexConfig`, `restoreNativeCodex`,
`syncModelsToCodex`, `restoreLegacyOpenaiHistory`, and
`startHistoryMigrationGuardian`. Adding a new command/route that reaches one of those
symbols without an inventory row fails the inventory test. Adding a direct writer
bypass anywhere fails the graph test even if route counts are unchanged.

## Failure, timeout, retry, and drain

The parent owns one process-local flight per durable operation identity only to avoid
duplicate Worker threads; H provides cross-process exclusion. Same-operation callers
may join. A newer durable operation supersedes an older one: the old Worker either
rejects it at the under-H claim or loses the terminal CAS, releases H, and leaves the
newer operation pending for repair. For compatibility native roots, “newer” is not
arrival luck at the authorizer: N spans native mutation through authorization, so the
order of committed schedules is the order of retained native mutations.

Outcome classification remains evidence-bearing:

- H or history DB busy -> `pending/db-busy` with a next retry;
- permission/refusal -> `blocked/permission`;
- unreadable DB/manifest -> `unknown/unreadable`, nullable counts;
- supported read but unsupported schema/shape -> `unknown/schema`, nullable counts;
- watchdog -> `unknown/timeout`;
- graceful cancellation -> `unknown/shutdown-cancelled`, then join;
- Worker error, malformed terminal IPC, or early close -> reread durable state before
  conditionally publishing `unknown/worker-died`;
- superseded identity/terminal CAS conflict -> typed overtaken/superseded result, no
  self-retry of the loser;
- terminal N update failure -> `unknown/record-write-failed`, preserving pending work.

The Worker closes in `finally`; parent cancellation and shutdown await actual thread
exit using the existing join discipline (`src/storage/worker-lifecycle.ts:150-209`).
A watchdog contains one attempt; it never certifies convergence.

Make execution policy invocation-local:

| Caller mode | H / SQLite wait | Attempts / delay | Result |
|---|---:|---:|---|
| automatic (startup, management, guardian, graceful stop) | 100 ms | 1 / 0 ms | Defer durably and keep listener/drain bounded. |
| explicit CLI | 5,000 ms | 2 / 500 ms | Preserve the current operator wait budget inside the Worker. |

The current defaults are a module-global 5,000 ms busy timeout and two attempts with a
500 ms synchronous delay (`src/codex/history-provider.ts:31-49,526-548`). Automatic
mode never calls `sleepSync` on the parent. Explicit delay may occur inside the Worker
while H remains held so another process cannot overtake between attempts.

The guardian uses capped exponential backoff with deterministic injected jitter,
keeps at most one timer/Worker for the current durable operation, and has no finite
lifetime attempt cap. Startup immediately re-arms unresolved durable work. This
replaces the current sixty-tick terminal stop
(`src/codex/history-migration-guardian.ts:34-35,47-48,87-95`).

## Deterministic tests

### Cross-process all-surface serialization

Seed a production-shaped DB, valid manifest, and rollouts under temporary homes.
Cover both orderings named by the latest review with production callbacks, not writer
stubs:

1. A authorizes one operation, enters its Worker, and pauses after the first real
   rollout write while retaining H. B acquires N, completes the opposite retained
   native mutation, replaces A's `running` identity with B's durable pending schedule,
   and reaches H. Resume A; its terminal update changes zero rows, H releases, and B
   repairs manifest, rollouts, and DB. Reverse operation direction and repeat.
2. A acquires N, completes its retained native mutation, and pauses immediately before
   the transaction-bound compatibility authorization. Start B at the point where it
   would authorize first in the broken design. B must not enter its native callback or
   publish any schedule while A owns N. Resume A so it authorizes and releases; only
   then may B mutate native state and authorize the newer opposite operation. This is
   the executable proof that authorization order matches native order.

No test stub mutates a surface; both processes enter production
`history-job`/Worker/H and the second fixture checkpoints the real native callback.

Broken changes: release H after the DB transaction but before manifest/rollout/probe;
dispatch the writer without H; restore the terminal-only compatibility predicate; or
acquire/release N only after/before the retained native callback. The sentinels
interleave, B's newer operation disappears, or B publishes first during A's handoff;
the terminal-CAS/final-state/order assertion fails.

### Transaction-observed authority and compatibility adoption

Before B acquires N, give it a deliberately stale copy of the complete transition
row. Let A publish a newer pending schedule and release N, then run B's real retained
native callback through the handoff. B must publish over A using the row read from its
already-open handle; the stale object is not accepted by any call. Instrument
coordinator connection creation so a second handle throws. **Broken changes:** add an
`expected` parameter to `authorize`, call `readCodexTransitionState` in the callback,
or open another coordinator connection; B conflicts after its native mutation or the
connection trap fires.

In `tests/codex-native-residue.test.ts`, under temporary homes, seed routed config,
catalog, history DB rows, rollouts, and a matching manifest but no coordinator
database. Run one real high-level apply through
`injectCodexConfig` (`src/codex/inject.ts:482-654`) and one real high-level restore
through `restoreNativeCodex` (`src/codex/inject.ts:765-800`). Each must commit the
exact generation-zero `adoption-pending` identity by atomic no-clobber publication
before its native callback, then change that row to the exact pending compatibility
schedule before Worker dispatch. Its Worker must repair/terminally own that identity.
The restore fixture proves recovery does not depend on residue still being present
after the native callback. Table-drive
negative observe/read, guardian/Worker retry, explicit recovery, intent/operation
mismatch, invalid legacy JSON, indeterminate residue, and existing unversioned/rowless
database cases; they create no row and do not invoke the native callback. **Broken
changes:** send compatibility roots through the strict clean-only initializer, let
residue alone authorize adoption, publish a rowless/unscheduled `{0,null}` database,
dispatch a Worker from `adoption-pending`, or re-observe only post-restore clean state;
the real fixture returns `legacy-ambiguous`/loses its schedule, history runs before
native completion, or a negative fixture creates authority.

In `tests/codex-transition-state.test.ts`, add the creation race that the static
rowless fixture cannot cover. Processes A and B each finish a complete validated v1
temp database after seeing final-path absence, then race no-replace publication.
Exactly one valid `adoption-pending` final database wins; the loser receives `EEXIST`,
scrubs only its temp, opens the winner as existing ready state, and never replaces or
unlinks it. Separately seed a foreign unversioned/rowless final database and require
strict refusal before a retained-native-callback sentinel runs. **Broken changes:**
restore the stale `databaseWasAbsent` flag plus SQLite `create:true`, publish by
ordinary rename, or treat existing rowless bytes as authority; the winner is
clobbered/malformed or the callback sentinel fires.

In `tests/codex-transition-state.test.ts` and
`tests/codex-native-residue.test.ts`, run child-process kill checkpoints after
exclusive temp creation but before SQLite open, after SQLite open/complete commit but
before publication, immediately after no-replace publication but before alias
cleanup/final reopen, and during the retained native callback. The first two leave the
final path absent; a subsequent real apply/restore publishes normally. The latter two
leave a complete validated `adoption-pending` row; the next real apply/restore reads it
as ready, re-runs its current native callback under N, changes it to the exact pending
schedule, and dispatches its Worker. Callback throw and authorization rejection leave
that same durable row and return the documented rerun action. **Broken changes:**
create the final path before schema/row commit, use replacing rename, unlink the final
database in `finally`, or let Worker/guardian dispatch `adoption-pending`; the child
leaves permanent rowless refusal, clobbers a winner, erases authority, or runs history
before native completion.

### H namespace and lock order

Two child processes vary `HOME`, `USERPROFILE`, `TMPDIR`, `XDG_RUNTIME_DIR`, `TEMP`,
`TMP`, and `LOCALAPPDATA` while retaining the same effective uid/SID, canonical
`CODEX_HOME`, and canonical state DB. They must resolve the same H final path. A second
canonical state DB under that home must resolve a different H while N/K remain the
same, and H must equal neither N nor K. Run the allowed `H -> N` and forbidden
`N/K/C -> H` symbol fixtures.

Broken changes: hash the raw request path/environment home, omit state-DB identity,
reuse N/K's database, or introduce an inverse edge. Path-equality/inequality or graph
fixture fails.

### Operation binding

For every `CodexHistoryOperation` variant, schedule it durably, tamper any diagnostic
request copy to a different operation, and assert the Worker either derives the
durable value or rejects before mutation. The manifest-independent recovery fixture keeps the
manifest byte-identical; the generic restore fixture consumes it only after successful
restore.

Broken change: dispatch from request `targetProvider`/direction instead of the durable
operation. The variant and tamper cases fail.

### Manifest truth

Run the malformed, unreadable, unsupported-shape, wrong-DB, and missing-DB-with-backup
fixtures through both the preflight and under-H post-probe. None may return numeric
zero/zero convergence. Separately run a valid present matching v1 `entries:{}` fixture
through preflight, generic restore/residual ejection, and post-probe; every read is
`ready` zero, the residual row is ejected, and the present manifest remains
byte-identical under the current empty branch.

Broken changes: map any manifest read failure to an empty manifest, initialize an
unknown count to zero, require `ready` to be positive, or map a present ready-zero file
to `missing`/`unsupported`. Its named fixture fails.

### Retry, death, and guardian activation

Advance a fake monotonic clock through exponential growth and the cap. Assert startup
arms the guardian from durable unresolved state, every fired attempt goes through
`history-job`, and a later timer remains after retryable failure. Cover Worker error,
malformed terminal IPC, early close, watchdog, cancellation, and terminal-N failure;
assert join exactly once and preserve distinct reasons.

Broken changes: remove the startup guardian call, let guardian call a writer directly,
or stop after a fixed tick count. The activation/reachability/backoff cases fail.

### Responsiveness for every root class

Hold a real `BEGIN IMMEDIATE` on the history DB and overlap health/data-plane traffic
with each root class: `POST /api/sync`, `ocx init/setup` command handler,
graceful shutdown, and explicit legacy recovery. Bind server port `0` and use temporary
homes. Health responses remain 200, the stream completes, command/shutdown deadlines
remain bounded, durable state records non-success, and every Worker joins. Release the
holder and prove a later serialized job succeeds.

Broken changes: run one root's probe/mutation on its caller thread or fail to await its
Worker during drain. The corresponding table row's responsiveness/drain case fails;
one responsive route cannot hide another inline caller.

### Symbol graph and inventory mutation checks

Run every wrapper/alias/re-export/dynamic-import negative graph fixture and every
production command/route inventory row. For each inventory row, mutate its terminal
edge to a direct writer or no history dispatch and prove the test fails before
restoring the fixture.

Broken change: add a seventh route, wrapper, alias, or new command that reaches a
writer outside the inventory. Symbol reachability fails even if regex counts do not
change.

## Verification

```bash
bun run typecheck
bun test tests/codex-history-provider.test.ts tests/codex-history-worker.test.ts
bun test tests/codex-transition-state.test.ts tests/codex-native-residue.test.ts tests/history-migration-guardian.test.ts
bun test tests/codex-history-process-routing.test.ts tests/codex-convergence-contract.test.ts
bun test tests/codex-sync-api.test.ts tests/shutdown-drain.test.ts
bun test tests/codex-history-worker-responsive.test.ts --timeout 30000
bun run privacy:scan
bun run test
```

All process tests use `mktemp -d`/temporary homes and port `0`. No command invokes
`ocx start`, `ocx stop`, `ocx sync`, `ocx restore`, `ocx ensure`, or `ocx service *`;
the installed service and live proxy on 10100 remain untouched.

## Accept criteria — each criterion has a red test

| Criterion | Passing evidence | Concrete broken change that turns it red |
|---|---|---|
| **C3 — caller responsiveness** | Table-driven responsiveness covers management, init/setup, graceful shutdown, and explicit recovery while real SQLite contention overlaps health/SSE progress. | Move any listed root's probe or mutation back to the caller thread. That root's latency/progress case fails. |
| **C4 — durable unresolved work** | Guardian activation/backoff test proves unresolved typed operation survives failure/restart and never becomes zero-looking success. | Remove startup arming, restore the 60-tick stop, or persist zero counts after failed evidence. The activation/backoff/evidence case fails. |
| **C15 — cross-process all-surface serialization** | Opposite operations serialize manifest, rollout, DB, post-probe, and terminal update under one H; N spans each retained native mutation through compatibility authorization, the newer schedule replaces even running work, and its Worker repairs stale work. | Release H between surfaces, bypass H, release/acquire N inside the native-to-authorization span, or restore terminal-only authorization. The sentinel/order/final-state case fails. |
| **Transaction-observed authority** | A stale pre-N row cannot be supplied to the one-shot authorizer; B authorizes from the complete row read on its one already-open N handle. | Restore `authorize(expected, next)`, call `readCodexTransitionState` inside the callback, or open a second N connection. The stale-row or connection-count case fails after B's real native mutation. |
| **Atomic adoption publication** | Two complete temp databases race no-replace publication; one valid v1 `adoption-pending` final row wins, while a pre-existing foreign rowless database still refuses. | Restore stale `databaseWasAbsent` + SQLite `create:true`, use replacing rename, or treat existing rowless bytes as authority. The winner is malformed/clobbered or the callback sentinel fires. |
| **Process-death adoption recovery** | Child termination before publication leaves final absence; termination immediately after publication or during the retained callback leaves a valid `adoption-pending` row that the next real apply/restore resumes into its exact pending schedule. | Create the final path before schema/row commit, unlink final authority in `finally`, or leave `adoption-pending` undispatchable and unrecoverable by the real handoff. The subsequent operation reaches rowless refusal or cannot reach its callback/schedule assertion. |
| **Compatibility adoption** | Real apply and restore fixtures start with routed config/catalog/history and no coordinator DB, publish exact generation-zero `adoption-pending` authority before native mutation, then commit the exact pending compatibility schedule; every non-high-level or ambiguous case remains refused. | Route the handoff through strict clean-only initialization, let residue/observation/retry request adoption, publish an unscheduled row, dispatch history from `adoption-pending`, or require post-callback residue. The real routed fixture or its named negative row fails. |
| **Operation authority** | Every operation variant is derived/validated from durable state, including no-op and manifest-independent recovery. | Trust request `targetProvider`/direction. Tamper and manifest-preservation cases fail. |
| **Real lock order** | Architecture fixtures allow `H -> N -> K -> C`; the compatibility root may execute retained native/K/C work and authorize through already-held N, then must release N before dispatch. Every inverse/cross-domain edge remains rejected. | Await/spawn H while N is held, open N only after native mutation, release N before authorization, or call K from the Worker. Dependency/order fixture fails. |
| **One H namespace per canonical history DB** | Environment-divergent child processes resolve one H for the same effective user/home/DB, a different H for a second DB, and paths distinct from N/K. | Key by environment/raw alias, omit DB identity, or reuse N/K. Resolver equality/inequality case fails. |
| **Manifest evidence** | Malformed, unreadable, unsupported, wrong-DB, and missing-DB-with-backup fixtures remain non-converged with nullable unknown counts; a valid present matching v1 empty manifest is `ready` zero through preflight, restore/ejection, and post-probe. | Convert any failed read to empty/zero, require ready-positive, or classify present ready-zero as missing/unsupported. Its fixture fails. |
| **No writer bypass** | TypeScript symbol reachability permits only `history-worker.ts` as a production writer root and catches wrappers, aliases, re-exports, namespace and dynamic imports. | Add any direct/indirect production writer path. Graph test fails. |
| **Complete current caller routing** | Inventory covers every production command/route and each history-bearing row reaches `runCodexHistoryJob`; named disconnect mutations are red. | Remove init, guardian, shutdown, service, or any other row's job edge, or add an unlisted caller. Inventory test fails. |
| **N2 — independently landable** | WP10 typechecks and focused/full suites pass while executable convergence remains catalog-only; current operation semantics are preserved through the N-backed compatibility handoff and H. | Import/call full `convergeCodex`, require WP11's full async lock/receipt/`CommitExpectation`, omit the narrow N handoff, or leave a temporary inline path. Typecheck/routing/order test fails at the WP10 commit. |
