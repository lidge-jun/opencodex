# Part 2 — history mutation must leave the server event loop

Research doc. No implementation diffs here. This records the blocking boundary,
the process split, and the acceptance test the later phase design must satisfy.

## The failure this substrate must prevent

A dashboard OFF cannot call the current history restore in the server process.
`restoreNativeCodex()` calls `syncCodexHistoryProvider("openai")` synchronously,
and `POST /api/stop` calls `restoreNativeCodex()` before it schedules drain and
exit (`src/codex/inject.ts:764-794`, `src/server/management-api.ts:167-194`).
The incident audit rejected that shape because two 5-second SQLite waits, one
500 ms synchronous sleep, and row-dependent file work can freeze the listener
that is meant to keep serving every other client
(`devlog/_fin/260803_codex_desktop_toggle/008_audit_synthesis_wp4_r2.md:25-30`).

The invariant for this part is therefore narrower than “history eventually
converges”: while a Codex history operation is waiting on SQLite or walking
rollouts, `/healthz` and existing data-plane traffic must continue to run on the
server event loop (`src/server/index.ts:536-550`).

## What the current history path does synchronously

The normal provider-sync path is synchronous from entry to return. The exported
function runs a synchronous no-op probe when requested, otherwise wraps the
entire unsafe mutation in a synchronous retry loop
(`src/codex/history-provider.ts:551-579`).

### SQLite wait and retry budget

- Every normal writable database connection sets `PRAGMA busy_timeout` from
  `historyDbBusyTimeoutMs`, whose production default is 5,000 ms
  (`src/codex/history-provider.ts:25-49`).
- `withHistoryRetry` makes two attempts by default. After the first recoverable
  failure it calls `Bun.sleepSync(500)` before trying the whole mutation again
  (`src/codex/history-provider.ts:526-548`).
- The lock-contention portion can therefore consume roughly `5,000 + 500 +
  5,000 = 10,500 ms`. This is not a whole-operation ceiling: it excludes every
  row scan, rollout read/write, fsync, manifest operation, and successful SQLite
  statement before or after the contended statement
  (`src/codex/history-provider.ts:526-548`,
  `src/codex/history-provider.ts:581-699`).
- Recoverable currently includes SQLite busy/locked, filesystem busy, and
  permission failures. All of those collapse to `failed: true`; hard failures
  throw (`src/codex/history-provider.ts:511-524`,
  `src/codex/history-provider.ts:577-578`).

### Rows, rollouts, and database writes

The forward direction materializes every resumable `openai` row and every
interactive `opencodex`/`exec` row with synchronous `.all()` calls. It then
iterates both arrays once for rollout mutation and again inside the SQLite
transaction before executing two set-based updates
(`src/codex/history-provider.ts:585-650`).

The restore direction reads every backup entry into an array, mutates each
entry's rollout, updates each entry inside a transaction, consumes the manifest,
then queries and iterates every remaining interactive `opencodex` row in the
ejection pass (`src/codex/history-provider.ts:656-695`,
`src/codex/history-provider.ts:475-508`). When the manifest is empty, restore
goes directly to that unbounded ejection query (`src/codex/history-provider.ts:656-665`).

For each rollout selected for a provider/source change, the path can do all of
the following synchronously:

1. Read the entire JSONL file into memory, split it into lines, and scan backward
   for the latest `session_meta` (`src/codex/history-provider.ts:258-274`,
   `src/codex/history-provider.ts:419-431`).
2. Reopen the file read/write and grow a 64 KiB probe until the first newline,
   with a 16 MiB first-line stop; a safe shrink writes line one in place and
   calls `fsyncSync` (`src/codex/history-provider.ts:102-157`).
3. Reopen with `O_APPEND`, write the trailing metadata line in a loop, call
   `fsyncSync` again, and close the descriptor (`src/codex/history-provider.ts:67-79`,
   `src/codex/history-provider.ts:444-457`).

The line-one probe is bounded at 16 MiB, but the preceding full-rollout read is
not. The selected database row count, backup-entry count, number of rollout
files, total rollout bytes, and filesystem flush latency have no cap in this
module (`src/codex/history-provider.ts:102-124`,
`src/codex/history-provider.ts:263-274`,
`src/codex/history-provider.ts:585-650`,
`src/codex/history-provider.ts:656-695`).

**INFERRED cost model:** for forward sync, the unbounded term is driven by
`N = openaiRows + execRows` and the sum of those rollouts' bytes. For restore it
is driven by `E = backup entries`, plus `R = remaining opencodex rows` found by
the ejection pass, and the sum of the corresponding rollout bytes. A changed
rollout can add two synchronous fsyncs, so file count matters independently of
byte count (`src/codex/history-provider.ts:67-79`,
`src/codex/history-provider.ts:102-157`,
`src/codex/history-provider.ts:585-650`,
`src/codex/history-provider.ts:656-695`). There is no finite worst-case duration
to quote from the code; `~10.5 s + row/file work` is the honest bound statement.

### Backup manifest handling

The manifest path is derived from the normalized `state_5.sqlite` path and lives
under the OpenCodex config directory. Reading it uses synchronous existence,
whole-file read, and JSON parse; writing either synchronously unlinks an empty
manifest or creates its parent and atomically rewrites the whole JSON object
(`src/codex/history-provider.ts:16-22`,
`src/codex/history-provider.ts:204-227`, `src/config.ts:190-230`). Invalid JSON,
an invalid version/shape, or a manifest naming a different state DB is treated as
an empty manifest (`src/codex/history-provider.ts:204-217`).

Forward sync inserts every selected row into that in-memory object before one
whole-manifest write (`src/codex/history-provider.ts:229-238`,
`src/codex/history-provider.ts:606-608`). Restore materializes all manifest
values and removes the manifest only after the transaction succeeds
(`src/codex/history-provider.ts:656-691`). Manifest size is therefore another
row-count-dependent synchronous term, not a constant-size marker.

### Other synchronous work in the file

The quarantine reconstruction helpers are not on the normal provider-sync call
graph, but they are also synchronous: plain rollouts use `readFileSync`; `.zst`
rollouts use `readFileSync` plus `zstdDecompressSync`, capped at 64 MiB decoded,
then scan every JSONL line (`src/codex/history-provider.ts:14-14`,
`src/codex/history-provider.ts:340-389`). They must remain outside the server
event loop if a later caller exposes them through management.

The read-only pending probe still synchronously reads/parses the whole manifest,
opens SQLite read-only, sets a 100 ms busy timeout, and performs `count(*)`
(`src/codex/history-provider.ts:743-775`). It is short with respect to SQLite
contention, but its manifest read remains proportional to manifest size.

## Which process blocks today

The distinction is not “CLI command versus dashboard button”; it is the process
in which the final call executes.

| Entry | Process that executes history work | Consequence |
|---|---|---|
| `ocx start` | **Server process.** The listener is bound first, then the same process awaits `syncModelsToCodex`, whose injection calls history sync/migration. | The already-live listener can stop progressing during startup history work. (`src/cli/index.ts:195-204`, `src/cli/index.ts:318-322`, `src/codex/sync.ts:49-58`, `src/codex/sync.ts:110-110`, `src/codex/inject.ts:598-603`) |
| History migration guardian | **Server process.** `handleStart` creates it after sync; each timer tick calls the synchronous pending probe and then a one-attempt migration. | It removes `sleepSync`, but one 5-second SQLite wait and all row/file work still run on the event loop. (`src/cli/index.ts:318-322`, `src/codex/history-migration-guardian.ts:43-70`, `src/codex/history-provider.ts:713-731`) |
| `POST /api/sync` | **Server process.** The management route awaits `syncModelsToCodex`, which reaches injection and history. | A dashboard/provider refresh can block all clients. (`src/server/management/config-routes.ts:261-268`, `src/codex/sync.ts:83-110`, `src/codex/inject.ts:598-603`) |
| `POST /api/stop` | **Server process.** It calls `restoreNativeCodex` synchronously before scheduling drain. | This is the direct incident path: the server is still serving when history restore runs. (`src/server/management-api.ts:167-194`, `src/codex/inject.ts:764-794`) |
| Signal/exit cleanup | **Server process.** `syncCleanup` may restore after the async drain, and is also registered on process exit. | It can delay shutdown; after drain it is not the normal availability hazard, but it uses the same blocking primitive. (`src/cli/index.ts:242-265`, `src/cli/index.ts:284-310`) |
| `ocx stop` | **Both.** The CLI first asks the live proxy to `POST /api/stop`; after that returns/exits, `handleStop` calls restore again in the CLI process. | The first restore can freeze the server; only the second restore is acceptably self-blocking. (`src/lib/process-control.ts:55-94`, `src/cli/index.ts:479-528`) |
| `ocx restore` / `eject` | **CLI process.** It calls restore directly. | Blocking only that command is acceptable, provided its result remains truthful. (`src/cli/index.ts:745-775`) |
| `ocx sync`, `restore back`, or `ensure` against an already-live proxy | **CLI process.** These commands call `syncModelsToCodex` in their own process. | Their own terminal can wait without starving the proxy. (`src/cli/index.ts:365-380`, `src/cli/index.ts:747-760`, `src/cli/index.ts:827-840`) |
| `ocx ensure` when it starts a proxy | **Both.** The child runs the startup sync after binding; the parent later performs another sync. | The child's startup sync is a server-loop hazard; the parent's sync is not. (`src/cli/index.ts:384-412`, `src/cli/index.ts:195-204`, `src/cli/index.ts:318-322`) |
| `ocx service stop` / uninstall | **Server, then CLI, when a tracked proxy is live.** Service cleanup reaches `stopProxy`, which uses `/api/stop`; the service command later restores in its own process. | As with `ocx stop`, the server-side first pass is the hazard. (`src/service.ts:2172-2197`, `src/lib/process-control.ts:64-94`, `src/service.ts:2564-2595`, `src/service.ts:2610-2632`) |
| `ocx recover-history --legacy-openai` | **CLI process.** It calls the legacy restore directly. | Its synchronous wait is local to the command. (`src/cli/index.ts:711-724`) |

There is no current Codex toggle management route. The native-integration module
explicitly excludes Codex because its state spans multiple artifacts and a live
database (`src/server/management/native-integration-routes.ts:1-15`). Any new
dashboard OFF route would become a server-process caller unless the substrate
changes this boundary.

## What `skipWhenProvablyNoop` actually buys

`restoreNativeCodex` enables `skipWhenProvablyNoop` only for Design B/loopback,
derived as `!shouldInjectApiAuthHeader(loadConfig())`; unreadable config and
legacy/non-loopback mode retain the unconditional write-open behavior
(`src/codex/inject.ts:775-783`).

When enabled for the `openai` direction and the state DB exists, the optimization
runs `countPendingOpencodexHistory`. It skips only when the read succeeds, zero
interactive rows remain tagged `opencodex`, and the backup manifest has zero
entries (`src/codex/history-provider.ts:551-575`). A failed/unknown probe, any
pending row, any backup entry, a non-`openai` direction, or a caller that omitted
the option falls through to the full write attempt
(`src/codex/history-provider.ts:551-579`).

The migration helper has the same proof-of-no-work gate unconditionally, while
its guardian reduces attempts to one (`src/codex/history-provider.ts:713-731`,
`src/codex/history-migration-guardian.ts:43-45`). Existing tests pin both the
byte-identical steady-state skip and the required fall-through when work remains
(`tests/codex-history-provider.test.ts:398-422`,
`tests/codex-history-provider.test.ts:443-456`).

It helps the server only in the already-converged steady state. It does not help
the OFF case this unit must make safe: routed threads or backup entries are the
reason history work is necessary, and either fact deliberately disables the
skip. It also cannot bound the file work after a successful probe identifies
pending rows (`src/codex/history-provider.ts:560-579`,
`src/codex/history-provider.ts:656-695`).

## Options

### A. Fail-fast automatic convergence only

Automatic/server callers can use one attempt and a very short writable SQLite
busy timeout, then return a classified deferred result instead of sleeping or
waiting five seconds. The retry helper already proves that `attempts: 1` performs
no sleep, and the read probe already establishes a 100 ms precedent
(`src/codex/history-provider.ts:536-548`,
`src/codex/history-provider.ts:743-775`,
`tests/codex-history-provider.test.ts:358-369`).

User observation: OFF can return quickly under active SQLite contention with
“Codex is off; history is pending because the database is busy.” The proxy keeps
serving because the lock wait is short, but a small event-loop pause remains.

Correctness: no history mutation is declared complete on contention; desired OFF
and config/catalog removal can remain committed while history is explicitly
pending. The next automatic retry or a manual CLI restore can finish it.

Limit: fail-fast bounds only SQLite waiting. If the lock is free, the same server
call can still iterate an unbounded row set, read unbounded rollout bytes, and
fsync per changed file (`src/codex/history-provider.ts:585-650`,
`src/codex/history-provider.ts:656-695`). **INFERRED:** option A alone cannot prove
the `/healthz` invariant for a large but uncontended history.

GUI requirement: render OFF and history convergence as separate facts. A green
OFF badge cannot imply that routed threads are visible; the previous restore
result already allows `success: true` while only the message says history failed
(`src/codex/inject.ts:787-794`,
`devlog/_fin/260803_codex_desktop_toggle/001_native_restore_thesis.md:92-110`).

### B. Move the entire history operation off the event loop

The repository already uses Bun `Worker` for synchronous filesystem/SQLite
storage work specifically to keep it off the proxy event loop
(`src/storage/policy-worker.ts:1-5`, `src/storage/policy-job.ts:295-344`). A
separate liveness test blocks that Worker for 1.2 seconds while sampling
`/healthz` and an active stream (`tests/storage-restore-job-responsive.test.ts:152-216`).

User observation: the OFF request can remain in “converging history” while the
proxy continues serving. With an async job response, the route can return before
an unbounded history walk completes; the GUI polls the durable state.

Correctness: the worker runs the existing ordered mutation and reports its
structured result. Server shutdown must join or terminate it without allowing a
later worker to overlap the same history files.

Bun-specific constraint from this repository: `Worker.terminate()` does not wait
for thread reclamation. Windows and macOS need explicit close tracking,
serialized spawns, and post-close settle time; the existing lifecycle records
1,500 ms on Windows and 250 ms on macOS
(`src/storage/worker-lifecycle.ts:1-17`,
`src/storage/worker-lifecycle.ts:43-60`,
`src/storage/worker-lifecycle.ts:150-209`). Reusing the idea without its lifecycle
discipline would trade an event-loop freeze for teardown races.

A second Bun/test constraint is path binding. `history-provider.ts` derives
`STATE_DB_PATH` from a module-level `CODEX_HOME` constant
(`src/codex/history-provider.ts:16-22`, `src/codex/paths.ts:6-29`). Existing
integration tests use a subprocess with `CODEX_HOME` and `OPENCODEX_HOME` set
before import for exactly this reason
(`tests/codex-inject-integration.test.ts:13-42`). A history Worker must receive
explicit resolved state/backup paths, or set its environment before dynamically
importing the module; it must not assume a parent test's late environment mutation
is visible. The storage Worker already passes explicit home/env data because
Workers may not see parent mutations on every platform
(`src/storage/policy-worker.ts:7-18`, `src/storage/policy-worker.ts:30-44`).

A subprocess gives stronger crash and module-environment isolation, and this repo
already launches Bun/TypeScript child work with `process.execPath`
(`tests/codex-inject-integration.test.ts:15-42`,
`src/update/job.ts:390-409`). Its costs are process startup, a separate IPC/result
contract, and cross-platform child ownership. Detached Windows children can also
inherit a listener handle, which the update path avoids with a platform-specific
launcher (`src/update/job.ts:380-430`). **INFERRED:** a non-detached, owned child
can avoid that particular leak, but it still needs explicit shutdown and output
bounds.

GUI requirement: show `converging` while the worker/job is active, then either
`converged` or an actionable unresolved state. Do not hold the switch in an
indeterminate visual state with no durable status behind it.

### C. Worker plus fail-fast automatic mode — recommended

Use an owned Worker for every server-process history mutation, and give automatic
attempts a short SQLite timeout with no synchronous retry sleep. Keep the current
full retry budget for explicit CLI-only recovery, where blocking the invoking
terminal does not deny proxy service (`src/codex/history-provider.ts:526-548`,
`src/cli/index.ts:711-724`, `src/cli/index.ts:745-775`).

The Worker is an execution boundary, not mutation authority. Part 4's read-only
ownership/provenance admission must pass before dispatch; `SQLITE_BUSY`,
permissions, or an unreadable manifest remain unresolved capability facts and do
not grant permission to mutate (`devlog/_plan/260804_codex_write_substrate/004_ownership_and_convergence.md:49-71`,
`devlog/_plan/260804_codex_write_substrate/004_ownership_and_convergence.md:203-214`).

This combination closes both dimensions of the incident:

- The Worker moves successful large row/file walks and fsyncs off the listener's
  event loop (`src/storage/policy-worker.ts:1-5`,
  `src/storage/policy-job.ts:295-344`).
- Fail-fast mode prevents one automatic job from occupying the history mutation
  slot for 10.5 seconds when Codex owns the database, and leaves retries to the
  durable convergence scheduler (`src/codex/history-provider.ts:526-548`,
  `src/codex/history-migration-guardian.ts:54-92`).

Prefer the in-repo Worker pattern over a new subprocess protocol unless Worker
teardown testing finds a history-specific Bun defect. The project already owns
admission, spawn serialization, close tracking, timeout, and drain concepts for
Workers (`src/storage/worker-lifecycle.ts:30-44`,
`src/storage/worker-lifecycle.ts:92-143`,
`src/storage/worker-lifecycle.ts:150-209`). **INFERRED:** history needs its own
single-flight/admission key rather than sharing storage cleanup's global worker
slot, because the resources and user-visible job states are different; both must
still be drained during server shutdown.

## “Unresolved history” is a durable fact

The backup manifest is recovery material, not a sufficient status record. It can
be empty while no-backup `opencodex` rows still need the ejection path, and a
failed read probe returns zero-looking counts with `failed: true`
(`src/codex/history-provider.ts:656-665`,
`src/codex/history-provider.ts:734-775`). The GUI must never derive “done” from
manifest absence or numeric zero while `failed` is set.

Record convergence under the OpenCodex config root, not in `CODEX_HOME`. The
recommended concrete location is `getConfigDir()/integrations/codex.json`, with
desired integration state and history convergence in the same atomic record; do
not create a second history-only status file. The existing integration state
convention places owned durable records below `getConfigDir()/integrations` and
writes them atomically
(`src/integrations/ownership.ts:60-66`,
`src/integrations/ownership.ts:74-106`). For this unit, the concrete durable fact
should live in the Codex desired-state record from Part 1, with a history section
keyed by the normalized state-DB identity already used for backup naming
(`src/codex/history-provider.ts:16-22`).

The record needs these semantics, not merely these labels:

| Field | Meaning |
|---|---|
| desired integration state | `off` is committed before the history attempt. It is the authority that makes a restart retry removal instead of re-injecting. |
| history state | `pending`, `running`, `blocked`, `converged`, or `unknown`; `converged` is legal only after a clean post-probe reports zero pending rows and zero backup entries. |
| reason | At minimum distinguish SQLite contention from permission failure, unreadable/schema-unknown state, worker failure/timeout, and cancellation during shutdown. Current `failed: true` conflates these classes (`src/codex/history-provider.ts:511-524`, `src/codex/history-provider.ts:734-775`). |
| evidence | Last-attempt time, attempt count, nullable pending-row/backup-entry counts, and the state-DB identity. Counts are null/unknown when the probe failed. |
| retry | Next eligible retry time and whether automatic retry remains armed. |

**INFERRED state rule:** write `pending` in the same durable desired-state
operation before dispatching the Worker; change it to `converged` only after the
Worker succeeds and a clean post-probe proves both counts are zero. A crash
between those writes therefore leaves a retryable false negative (“pending even
if work landed”), never a false green. The existing guardian already uses a
post-probe before treating zero-row success as done
(`src/codex/history-migration-guardian.ts:68-83`).

Retry ownership should be explicit:

- The running server schedules bounded automatic attempts while desired state is
  OFF; its current guardian already has unref'd timed ticks and a finite budget,
  but today it stops after about an hour and only logs the failure
  (`src/codex/history-migration-guardian.ts:34-40`,
  `src/codex/history-migration-guardian.ts:54-92`).
- Every proxy startup re-arms a durable pending/unknown record; startup must
  dispatch the Worker rather than run the mutation inline. The current startup
  starts its guardian only after the synchronous initial sync, which is the
  boundary this unit changes (`src/cli/index.ts:318-322`).
- An explicit CLI restore/recover command can request the full retry budget in
  its own process and must update the same durable result afterward
  (`src/cli/index.ts:711-724`, `src/cli/index.ts:745-775`).

The user learns the truth through all control surfaces. The Codex integration
GET response should expose desired state plus history state/reason/counts; the
GUI should render “Off — history pending” and say routed threads can remain hidden
until retry succeeds. `ocx doctor` already reports clean, pending counts, and
locked/unreadable unknown state from the read-only probe, so it should add the
durable reason/next retry rather than invent a second definition
(`src/cli/doctor.ts:891-902`).

## Acceptance tests

### The gate: real SQLite contention while `/healthz` stays responsive

Add a server-boundary test beside the existing Worker responsiveness test. It
must use isolated `CODEX_HOME` and `OPENCODEX_HOME`; the repository already has a
helper that creates and restores an isolated Codex home
(`tests/helpers/isolated-codex-home.ts:1-23`).

Concrete method:

1. In the isolated Codex home, create a production-shaped `state_5.sqlite`, one
   interactive `opencodex` row, and its rollout. The current fixture schema and
   row shape are pinned in `tests/codex-history-provider.test.ts:27-89`.
2. Spawn an owned Bun child process that opens that exact SQLite file, executes
   `BEGIN IMMEDIATE`, writes a ready marker, and holds the transaction until a
   release marker appears. Existing multiprocess lock tests use the same owned
   child + marker handshake and enforce cleanup in `finally`
   (`tests/oauth-refresh-lock-multiprocess.test.ts:58-101`,
   `tests/config-mutation-lock.test.ts:48-92`). This is real cross-process SQLite
   writer contention, not a mocked `SQLITE_BUSY`.
3. After the ready marker, start `startServer(0)` and issue the future Codex OFF
   management request. Give the history Worker a test-only busy timeout/hold long
   enough to sample deterministically (for example 1,200 ms), while production
   automatic mode remains short. The server test seam already forwards management
   dependencies after authentication (`src/server/index.ts:351-367`,
   `src/server/index.ts:541-550`).
4. Do not await OFF first. While its promise is pending, issue at least six
   `/healthz` requests at 40 ms intervals, require every response to be 200, and
   assert each post-warmup latency is below one third of the contention window.
   This is the existing measured liveness pattern, not a sleep-and-assume check
   (`tests/storage-restore-job-responsive.test.ts:175-210`).
5. Also keep one streaming data-plane response active during the same window and
   prove all chunks arrive. `/healthz` alone proves listener scheduling; the
   stream proves an already-admitted client continues to receive service
   (`tests/storage-restore-job-responsive.test.ts:182-210`).
6. Release the child transaction in `finally`, await its zero exit, await/drain
   the history Worker, and shut the server down. Worker tests must join threads
   before deleting homes because Bun termination is not a join
   (`src/storage/worker-lifecycle.ts:1-17`,
   `tests/storage-restore-job-responsive.test.ts:53-80`).
7. Assert the OFF response/status says history is unresolved with reason
   `sqlite_busy`, that the durable record survives a fresh server instance, and
   that a later retry after lock release converges and clears the warning. A clean
   post-probe must report both counts as zero
   (`src/codex/history-provider.ts:734-775`,
   `src/codex/history-migration-guardian.ts:68-83`).

The liveness pass condition is quantitative: the OFF operation is demonstrably
still contending while every health sample stays well below the contention
window and the stream completes. A unit test that merely injects a busy error, or
a test that checks `/healthz` only before and after OFF, does not exercise the
incident.

### Other tests required by the recommendation

- `tests/codex-history-worker.test.ts` — Worker result parity: forward, manifest restore, no-manifest ejection,
  line-one patch, trailing append, and manifest consumption match the existing
  synchronous results (`tests/codex-history-provider.test.ts:92-290`).
- `tests/codex-history-convergence.test.ts` — automatic fail-fast: one real busy attempt performs no `sleepSync`, persists
  unresolved state, and schedules a later attempt; hard errors retain their
  classified reason (`tests/codex-history-provider.test.ts:293-369`,
  `tests/history-migration-guardian.test.ts:40-79`).
- `tests/codex-history-worker.test.ts` — no-op: clean Design B state does not spawn a Worker or write the DB/rollout;
  pending rows and manifest entries do spawn one
  (`tests/codex-history-provider.test.ts:398-456`,
  `tests/history-migration-guardian.test.ts:24-38`).
- `tests/codex-history-convergence.test.ts` — crash/cancel: killing or timing out the Worker leaves durable `pending` or
  `unknown`, never `converged`, and the next server start retries. Teardown joins
  before a second worker starts (`src/storage/worker-lifecycle.ts:123-143`,
  `src/storage/worker-lifecycle.ts:150-209`).
- `tests/codex-history-worker-responsive.test.ts` — the real-contention `/healthz`
  and active-stream measurement specified above
  (`tests/storage-restore-job-responsive.test.ts:152-216`).
- `tests/codex-history-process-routing.test.ts` — process routing: direct CLI restore uses the full synchronous budget; startup,
  `/api/sync`, `/api/stop`, guardian, and the future toggle never call the
  synchronous mutation on the server event loop. The current call sites to pin
  are `src/cli/index.ts:318-322`, `src/server/management/config-routes.ts:261-268`,
  `src/server/management-api.ts:167-194`, and
  `src/codex/history-migration-guardian.ts:59-83`.
- `tests/codex-integration-history-state.test.ts` plus the owning GUI test — API/GUI truth: OFF with pending history is not a success-only envelope; state,
  reason, counts/unknown, retry, and the hidden-thread warning survive reload.
  The current string-only failure attached to `success: cfg.success` is the
  regression target (`src/codex/inject.ts:787-794`).

## Existing tests that pin current behavior

`tests/codex-history-provider.test.ts` is the primary contract. It pins forward
retagging, append-only metadata, line-one in-place restoration, oversized first
line handling, backup restore, foreign-DB manifest refusal, exec-source repair,
no-backup ejection, and explicit legacy recovery
(`tests/codex-history-provider.test.ts:92-290`). It also pins recoverable error
classification, two-attempt retry, no retry for hard errors, custom attempt
budgets, the no-sleep one-attempt mode, pending counts, idempotent migration,
missing-DB manifest retention, and `skipWhenProvablyNoop`
(`tests/codex-history-provider.test.ts:293-456`).

`tests/history-migration-guardian.test.ts` pins the current scheduler semantics:
no work in steady state, retries through contention, finite give-up, cancellation,
retry after an unknown probe, and refusal to call zero-row success complete while
backup entries remain (`tests/history-migration-guardian.test.ts:24-136`).

`tests/codex-inject-integration.test.ts` pins isolated-process path binding and
the external-provider guard that prevents history/config mutation when another
provider owns Codex (`tests/codex-inject-integration.test.ts:13-42`,
`tests/codex-inject-integration.test.ts:247-355`).

The service/CLI tests currently pin call ordering only: service stop restores
after tracked proxy stop, service uninstall restores after uninstall, and the CLI
exposes restore/legacy recovery (`tests/service.test.ts:646-661`,
`tests/uninstall.test.ts:17-27`). No existing Codex-history test measures server
liveness under real SQLite contention; the closest proven pattern is the storage
Worker liveness test (`tests/storage-restore-job-responsive.test.ts:152-216`).

## Recommendation

Choose **C: an owned Worker for every server-process history operation, plus a
fail-fast automatic SQLite budget and durable unresolved-history state**. Keep
the full synchronous retry path only for explicit CLI-process recovery.

The hardest constraint is not the 10.5-second lock budget. It is that a successful
history mutation has no finite work bound: row count, manifest entries, rollout
count, total JSONL bytes, and fsync latency all scale with user history
(`src/codex/history-provider.ts:585-650`,
`src/codex/history-provider.ts:656-695`). Only moving the whole mutation off the
server event loop can satisfy the availability invariant in both contended and
uncontended large-history cases.
