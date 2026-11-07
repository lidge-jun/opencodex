# Automatic activation admission — draft unit

**Status:** architect proposal received; exact contract and diff need independent
roadmap audit before implementation. This unit precedes any automatic restart.

## Problem and contract

The ordinary terminal shutdown starts a permanent admission fence, waits for
temporary drains and active turns, then aborts remaining turns after its deadline
(`src/server/lifecycle.ts:520`). Automatic installation must not rely on that
deadline as an idle check. A temporary drain cannot be held while the shutdown
path waits for temporary drains (`src/server/lifecycle.ts:131`).

The existing automatic restart path already acquires a temporary fence, allows
an authority veto and transfers to permanent shutdown before releasing that
fence (`src/server/management/system-restart.ts:385`, `:439`). Extend and
reuse that handoff where its ownership and timeout contract fits; do not build
a competing restart path. It does not by itself prove the complete update-specific
idle, candidate and policy contract proposed below.

An automatic update therefore needs a runtime-owned, operation- and
installation-bound reservation. It fences new data-plane admission, checks all
relevant activity, and exposes an expiring, one-use capability. Immediately
before activation it revalidates runtime identity, target, policy, owner and
idle while the fence remains held. An atomic handoff sets the existing permanent
shutdown latch and releases this reservation before shutdown waits for temporary
drains. Busy, uninspectable, expired, cancelled or changed state releases the
temporary fence and keeps the runtime serving. Exact ownership and failure
semantics must be reviewed against all runtime entry points; the reservation
is not proof that untracked work is idle.

## Activity owners to fence

The admission contract must be implemented across these distinct owners; a
single sampled count is insufficient. The exact fence APIs and cross-process
behavior remain audit blockers until verified in the implementation map.

| Owner | Current evidence | Required automatic-update treatment |
| --- | --- | --- |
| Proxy turns and streamed responses | `tryAdmitTurn` checks `isDraining` (`src/server/lifecycle.ts:174`); admitted turns are tracked (`:365`, `:538`). | Acquire the existing global temporary fence before observing zero; hold it until transfer/cancel. A turn admitted before the fence blocks activation. |
| Codex WebSockets | Registry and metric owner `src/codex/websocket-registry.ts:3`, `:51`; lifecycle reports it separately (`src/server/lifecycle.ts:369`). | Determine whether a connection is idle or executing; fence new work at its actual admission owner. If that distinction cannot be proved, defer while any connection is present. |
| Cursor background shells | `src/adapters/cursor/native-exec-shell.ts:379`; lifecycle reports and shuts them down (`src/server/lifecycle.ts:370`, `:536`). | Treat active or unknown shell work as busy; block new shell creation before idle is accepted. Never rely on forced shutdown to terminate a shell. |
| Storage mutation slots | `src/storage/storage-mutation-coordinator.ts:35`, `:71`, `:91`. | Fence new mutation admission and require all relevant slots idle; account for other processes and unavailable ownership evidence. |
| Storage worker reservations | `src/storage/worker-lifecycle.ts:40`, `:92`, `:118`. | Fence worker starts and require no owned or uninspectable work; prove any process-tree exit before activation. |
| Tracked background work | `src/lib/background-work.ts:21` tracks already-started promises. | Fence creation before work starts and require all registered work settled; merely sampling the current list cannot prevent a later start. |
| Optional subsystems and plugins | `src/server/background-lifecycle.ts` starts periodic work; registered teardown hooks are separate from proof of idle. | Register quiescence owners through core-owned slots and defer when active or uninspectable; preserve the Lab import boundary. |

These metrics do not prove that this is an exhaustive inventory. Trace all
background and optional owners reachable in the running configuration before
locking the plan; an unknown owner must keep automatic activation deferred.

Proposed acquisition sequence for one attempt is the home-scoped sync/update
mutex, installation ownership lease, global turn fence, WebSocket admission
fence, background-shell fence, storage mutation/worker admission fence, then
registered background/optional-owner quiescence. Each fence closes admission
before its owner is observed. `tryAdmitTurn`, `tryReserveCodexWebSocket`, shell
spawn admission, `tryBeginStorageMutation`, `tryReserveStorageWorker` and
`withStorageWorkerSpawnGate` must consult their owner's reversible fence. A
missing participant, unconfirmed cleanup or uninspectable other process makes
the result unknown and releases this attempt's fences. The updater's own
status/journal path is excluded from the data-plane fence but still uses its
own serialized operation owner. Release acquired fences in reverse order on
precommit refusal. Do not hold client/configuration transactions across RPC or
installer waits; preserve `N → L → C` where those locks are needed. The exact
cross-process exclusion and exhaustive owner roster remain audit blockers.

### Concrete participants and queued work

The update admission owner maintains a core-owned registry of the active
participants for the actual runtime instance. Each registration supplies
`closeAdmission(operationId)`, `inspectClosed(operationId)` and
`releaseAdmission(operationId)`; registration, close and inspection identify the
same owner generation. Close happens synchronously before observing work; a
missing registration, changed generation, failed close or unknown inspection
defers. Composition registers enabled optional owners through a core slot; no
core request-path file imports an optional subsystem. A temporary close is not
the existing terminal shutdown and must be reversible without discarding work.

| Participant | Concrete admission sites to change and test | Required zero/queue rule |
| --- | --- | --- |
| HTTP and streamed turns | `src/server/admitted-http-turn.ts:26`, `src/server/index/serve-options.ts:1756`, `src/server/responses/jev-model-invoke.ts:139`, and `src/server/claude-messages.ts:1043` call `tryAdmitTurn` | All admitted turn leases settle before commit. A racing request either acquires before closure and blocks the update, or receives the existing retryable admission refusal. |
| Codex WebSockets and WebSocket turns | `src/server/index/serve-options.ts:629`, `src/server/index/websocket-handler.ts:296`, `src/codex/websocket-registry.ts:28` | Close upgrade/turn admission; in v1 any live connection is busy, since connection-idle semantics are unproven. A close result must be observed, never forced. |
| Cursor background processes | `src/adapters/cursor/native-exec-shell.ts:421` gates before `:433` spawn | Close before acquiring a new shell lease; any live or unconfirmed child blocks. No forced kill is used to turn busy into idle. |
| Storage mutations | `src/storage/storage-mutation-coordinator.ts:83`, `src/storage/cleanup-job.ts:41`, `src/storage/restore-job.ts:292`, `src/storage/policy-job.ts:389`; Log Guard separately calls `noteStorageMutationCompleted` from `src/server/management/storage-log-guard-routes.ts:165` | Gate before all mutations, including the Log Guard path that does not currently acquire a slot. An already admitted slot or unknown other process is busy/unknown; an epoch update alone is not an admission fence. |
| Storage workers | `src/storage/worker-lifecycle.ts:91`, `:126`; worker creators in `src/storage/policy-job.ts:310` and `src/storage/restore-job.ts:164` | A queued reservation counts as work before a Worker exists. A reversible update fence must not use shutdown's destructive queue cancellation as its idle proof; queued work completes or the attempt defers. Require confirmed worker closure and OS join before zero. |
| Tracked background creation | `src/config/paths.ts:53`, `src/oauth/anthropic-session-affinity-store.ts:127`, `src/codex/auth-api/pool-mode-gate.ts:340`, `src/codex/auth-context.ts:1575`, `src/server/index.ts:818`, `src/server/management/codex-cli-update-routes.ts:46` | Introduce a thunk-based admission API before starting work; `trackBackgroundWork` alone receives an already-created promise (`src/lib/background-work.ts:24`). Migrate each creator and test a start racing the closed fence. Required writes are never dropped; if one is queued, defer rather than stop. |
| Process loops and activated optional owners | `src/server/background-lifecycle.ts:88`, `:196`; optional shutdown slots in `src/lib/optional-shutdown-hooks.ts:42`, `:87` | Each active timer or subsystem registers its own reversible admission and in-flight inspection. A periodic tick may be rescheduled only if its owner proves that losing the tick on process restart preserves semantics; otherwise it blocks. Shutdown hooks alone do not establish idle. |

An update-owned journal/permit write uses its own serialized operation owner
and is exempt from its own data-plane fence; it cannot start unrelated work.
Acquire the outer update/ownership/link locks in the `060` order before the
runtime participant fences; release participant fences in reverse order before
outer locks on precommit refusal. No network or installer wait occurs under the
inner client/config/journal locks. Other processes that can mutate the same
installation or required state must participate in a shared identity-bound
exclusion mechanism or cause an unknown result; a process-local counter is not
cross-process evidence. Enumerate their actual owners and lease protocol before
this unit is locked.

Add deterministic barrier cases to
`tests/server/update-activation-admission.test.ts`,
`tests/storage/storage-update-admission.test.ts`, and focused tests for each
named creator: pause immediately before admission, close the fence, release the
caller and assert no uncounted work starts; then release the fence and prove
the work resumes or receives its documented refusal. Exercise an already queued
worker, Log Guard, an optional owner absent from the registry and a second
process with unknown ownership. A source-oracle test that checks the enumerated
creator/registration list is an early warning for drift, not proof that all
possible work is registered; call-graph and platform review remain mandatory.

### Existing cross-process locks and limits

| Lock | Existing authority | Update requirement |
| --- | --- | --- |
| `U` sync/update mutex | `src/update/sync-update-mutex.mjs:46` takes a nonblocking lock under the canonical OpenCodex home; `src/update/orchestrated-session.mjs:192` holds it during an orchestrated mutation. Delegation is limited to a recorded live parent/child (`sync-update-mutex.mjs:74`). | Reacquire for activation and retain the existing marker and sync exclusion. Different homes have different `U` locks, so `U` alone does not establish exclusivity for a shared installation. |
| `O` service ownership lease | `src/service/ownership-mutation-lease.mjs:46` derives its authority from the final service-state path. `src/update/ownership-transaction.ts:30` spans stop/replacement/recovery and explicitly releases for a service-manager start whose child cannot join, then reacquires before direct mutation. | Preserve the release/reacquire and revalidation behavior. This lock protects its participating ownership mutations; it does not by itself count every data-plane or storage writer. |
| `A` link apply | `src/client/link-home.ts:149` uses an outer SQLite lifecycle lock keyed to the link-apply path before native/lifecycle/config operations. | Preserve its existing ordering and serialize binding changes relevant to a linked update; do not assume it protects standalone, other homes or worker processes. |
| `N → L → C` | `src/client/lifecycle-lock.ts:1` documents native-integration, effective-user lifecycle and configuration ordering; the lifecycle lease is a SQLite transaction (`:57`). | Never acquire `N` inside `L` or hold these inner locks while waiting for network, installer or target health. Recheck bound state after a lock is released. |

The automatic unit must define an installation-scoped participant authority
whose key is the validated installation/owner identity, not only the invoking
home. Every process capable of mutating that installation or its relevant
runtime state must join or expose an authenticated participant before the
owner can establish zero activity. Map the existing launch and mutation
entrypoints and their failure behavior in the implementation diff; older,
foreign or uninspectable participants make the result unknown. Test two
isolated homes pointing at one fixture installation, an owner change during
the service-manager lease release window, and a process exiting while holding
its participant lease. Automatic activation remains disabled for an owner
until the actual cross-process mechanism and recovery are verified.

Proposed concrete authority: `src/lib/installation-activity-registry.ts` owns
an effective-user runtime-root registry, keyed by a digest of the canonical
installation path and validated owner identity; each record also binds the
current filesystem identity so replacement or an alias cannot silently join a
different installation. Use a private, no-follow directory and required Windows
ACLs, matching the existing effective-user lifecycle storage approach
(`src/client/lifecycle-lock.ts:31`, `:57`). A short SQLite transaction serializes
participant registration, activity-count changes and update-fence generation;
it is never held across network or installer work. Each participant also holds
an OS-released exclusive SQLite lease in its own private lease file for its
process lifetime. Register only after that lease is held and withdraw before
releasing it. After a crash, a verifier may retire a record only after acquiring
that same lease and confirming the recorded process instance is no longer live;
an unreadable file, ambiguous process or unconfirmed lease is `unknown`.

The shared storage/locking protocol is SQLite rollback-journal mode with
`busy_timeout=0`, a short registry transaction and one exclusive participant
lease database per process instance. Bun keeps each `Database` handle strongly
owned from acquisition through withdrawal; garbage collection must not release
a live lease. Native Desktop and the guardian use the same SQLite file format
and locking protocol through a directly pinned, bundled `rusqlite = 0.40.2`
adapter (`libsqlite3-sys = 0.38.2` in the resulting lockfile); the current
Desktop lock has neither dependency, so this is a new security-reviewed
dependency and must be locked, built and tested on all supported platforms.
Do not substitute the shell's unrelated `flock`/`LockFileEx` protocol.

Node 18 cannot assume a native SQLite built-in. Its launcher starts a
publisher-verified, installation-bound bundled Bun broker with a private,
authenticated IPC channel; the broker owns the same SQLite protocol and keeps
the lease handle alive. Register only after the launcher verifies the broker's
process instance and ready receipt. A lost broker or unverified parent makes the
participant unknown and stops new work; a signed broker is obtained and
verified before first use, including bootstrap and rollback. The guardian's
native adapter and broker must observe each other's actual locks, not merely
agree on filenames. Test Bun, Node 18 and native Rust contention in separate
processes, garbage collection, process death and both lease directions on
macOS, Linux and Windows. The isolated macOS Bun/system-SQLite probe is
feasibility only; it does not prove this native adapter or platform matrix.

All cooperating launch and mutation paths register before opening the selected
installation or starting associated work. Under the short registry transaction,
new work increments its participant count only when no update fence exists; a
fence closes admission before checking every registered count and participant
lease. Closing and inspecting are one generation-bound decision; committing the
existing runtime latch and durable update-stop intent transfers the fence to the
external installer owner. The owner keeps the installation fence through stop,
verified replacement and recovery; a newly started owner joins only through
the recorded operation handoff. Retire the fence only after owner/process
readback and journal reconciliation. Map the concrete CLI, Desktop, service,
linked worker and manager entry points in the implementation and prove each
joins before enabling its adapter.

This cooperative registry does not restrict an arbitrary same-account process
that ignores it. Before automatic mutation, owner-specific checks must establish
that the selected manager and all known writers participate, and refuse an
unknown or unsupported configuration; the security review must assess the
remaining nonparticipating-writer boundary and any required OS enforcement.
Do not call a database row a system-wide lock. Add
`tests/service/installation-activity-registry.test.ts` with isolated homes and
real competing processes for registration/fence races, stale/dead leases,
replacement identity, two homes sharing one install, process death and
unreadable/foreign writer outcomes. The planned mechanism and every platform's
lease/ACL behavior remain unimplemented until those tests and independent
security review pass.

## Candidate file changes

| Operation | Path | Before → after |
| --- | --- | --- |
| NEW if needed | `src/server/update-admission.ts` | Update-specific reservation state and typed outcomes: reserve, inspect, commit, cancel/expire. Capability binds exact process/runtime and selected update operation. No dependency from core runtime into an optional subsystem. |
| MODIFY | `src/server/management/system-restart.ts` | Reuse or extract its existing automatic temporary-fence, veto and shutdown handoff (`:385`, `:439`) as a shared primitive; keep package-tree restart's existing respawn semantics distinct from update stop-to-installer. |
| MODIFY if needed | `src/server/lifecycle.ts` | Existing owner-scoped fence and shutdown latch (`:91`, `:122`) → expose only the minimal activity and atomic transfer seam actually needed; preserve normal shutdown and all existing lease semantics. File-size ratchet may require moving existing code byte-for-byte to an owned sibling. |
| MODIFY | `src/server/management-api.ts`, `src/lib/process-control.ts`, `src/cli/stop-restore.ts`, `desktop/src-tauri/src/runtime_stop.rs`, `desktop/src-tauri/src/exit.rs` | Design a separately authenticated update-stop disposition through the actual receipt-backed `ocx stop` path. The existing `/api/stop` executes teardown and shutdown (`management-api.ts:480`, `:522`), while Desktop calls `runtime_stop::run` (`exit.rs:614`). The automatic disposition must carry the exact reservation and consume it before manager stop/teardown; it must not route to `/api/system/restart`, whose handler supplies no automatic admission callbacks (`system-routes.ts:205`) and normally starts a replacement. Unproven manager ownership or a stop path that cannot preserve the reservation refuses before disruption. The exact authenticated wire format and service-manager ordering remain audit blockers. |
| MODIFY | Focused `tests/service/shutdown-drain.test.ts`, relevant management/update admission and ownership tests | Failing-first race cases using fake clocks, controlled in-flight streams, and isolated runtime identities. New files must be added to test-layout maps and expected shards. |
| MODIFY | `structure/runtime.md`, `structure/ops/service-and-sidecars.md`, `structure/ops/desktop-supervision.md` and any additional mapped owners | Document the shipped seam and bind invariants to real tests; run the ownership gate. |

The desired disposition is **stop for a verified installer**, not restart the
old package: after reservation and policy revalidation, the existing external
stop owner claims its teardown receipt, transfers the fence into terminal stop,
observes the owned process exit and returns the receipt-bound outcome to the
installer. Only then may the installer activate the already verified stage and
the existing owner start the replacement. A supervisor must not respawn the old
tree between stop and activation; where the current manager cannot guarantee
that, automatic activation remains refused. Failure before irreversible stop
releases the fence and keeps serving; after stop, recovery follows existing
owner-specific rules and never reports health without observing the target.

For a service, commit durably records `await-external-owner-stop`, fences new
work and returns acceptance without asking the supervisor to restart the old
tree. Only after the external CLI receives or reconciles that acceptance may it
stop the revalidated bound manager and observe inactivity. If the runtime dies
or the reply is lost before the manager action, reconcile the same operation
and recorded runtime/manager state; never substitute a force-stop or a second
operation. Unmanaged and Desktop owners similarly bind the receipt and process
exit before installation. Startup inhibition is a private durable operation
record outside the replaced tree, checked by CLI startup, native supervision,
service startup and recovery before any old-tree launch. Each unsupported
owner stays deferred until its check and recovery path are demonstrated.

Proposed update-specific descriptor `ocx.update.activation/1` binds an operation
ID and attempt generation, process instance and endpoint, selected installation
and owner, exact verified candidate/stage digest, policy revision, stop owner and
reservation deadline. A dedicated authenticated runtime admission surface offers
`reserve`, `inspect`, `commit` and `cancel`: reserve acquires the required
fences and returns an opaque short-lived permit or a bounded deferral reason;
inspect reports the same attempt; commit rechecks all bindings and makes the
permanent transfer once; cancel releases only the uncommitted attempt. A lost
commit response remains uncertain until observed. Existing restart capabilities,
plan hashes and teardown receipts are not interchangeable with this operation.

Proposed transport is a dedicated local management endpoint
`/api/update/activation` with `reserve`, `inspect`, `commit` and `cancel`
actions, bounded JSON and a body-bound, operation-scoped local capability
derived from the owning runtime's private process secret. `src/lib/local-management-capability.ts` owns the
existing local capability machinery and is the extension point; the ordinary
restart capability remains unchanged. The permit is an opaque runtime-issued
value with a five-second monotonic lifetime, scoped to the descriptor and
single use. A private operation file carries the update-stop invocation's
descriptor to the bundled CLI without command-line secrets. Neither a public
status response nor the dashboard snapshot contains the permit. This is a
proposed protocol, not evidence of a deployed security boundary.

The local caller first reads the selected process's private runtime record and
verifies its loopback challenge exactly as the existing bound restart client
does (`src/cli/system-restart-client.ts:93`, `:111`, `:125`). The proposed
mutation capability is a **new** domain-separated HMAC-SHA-256 operation, not
the existing GET-only capability (`src/lib/local-management-capability.ts:60`).
Its input is the exact bounded UTF-8 request body digest, method, fixed path,
runtime PID and port, challenge nonce, action, operation ID, generation and
expiry; use unambiguous length-prefixed fields and compare MACs in constant
time. The owning caller derives it from that runtime record's process secret;
the secret and permit never enter logs, arguments or dashboard state. A
replacement PID, changed record, duplicate JSON key, wrong body, expired nonce
or unsupported capability refuses. Runtime-record access and an attested
connection are local ownership prerequisites, not person-consent or a guarantee
against another process running as the same account. Add a dedicated
`src/lib/local-update-admission-capability.ts`, server verifier and caller
sibling; do not widen the existing local GET allowlist.

The request is a strict `ocx.update.activation/1` object with `action`,
`operationId`, positive `generation`, `runtimeInstance`, `pid`, `port`,
`installationId`, `ownerKind`, `candidateDigest`, `stageDigest`,
`policyRevision` and `deadlineMs`; `commit` and `cancel` also carry the opaque
permit returned by `reserve`. `inspect` instead uses a fresh process-bound,
body-authenticated request for the operation and generation, without consuming
or requiring a previously consumed permit. A response is the strict
`ocx.update.activation-result/1` with the same operation and generation,
`state` (`reserved`, `accepted`, `deferred`, `refused`, `cancelled`,
`expired` or `uncertain`), bounded `reason`, and permit only on `reserved`.
Runtime admission uses a monotonic five-second deadline for a reservation;
wall-clock request expiry only bounds transport replay. The secret-derived
MAC authenticates each action and body; it is distinct from the one-use permit.
Final encoding vectors and the response readback/authentication chain require
independent security review before implementation.

The external owner writes a private durable inhibition record outside the
replaceable installation before `commit`, binding operation/generation,
selected owner and runtime instance, prior running intent and stage digest.
Only the owner holding the installation lease can create, advance or clear it;
updates are atomic and durable. Before acceptance, expiry or owner loss releases
the reversible fence and the owner clears the matching intent after confirming
no commit. At acceptance, admission transfers into the existing shutdown latch
and records the matching accepted generation; it cannot expire back to serving.
For service ownership the runtime returns acceptance before the external owner
stops the revalidated manager; for Desktop or unmanaged ownership it enters the
receipt-backed stop path. If the response is lost, the owner reconciles the
same runtime, record and manager/process state; it never invents a second
operation or treats a missing reply as an accepted stop. Readback after runtime
exit/replacement uses the private durable operation journal through an
authenticated local owner, not the dead runtime's process secret; a missing or
contradictory record is `uncertain`. If the owner dies after acceptance and no
mutation started, a successor must reconcile the exact runtime and manager:
an alive runtime with the permanent latch still closed is stopped through the
accepted receipt and observed exited before the same owner's prior running
intent is restored. It must not clear inhibition and call that fenced process
healthy. If state or exit is unknown, retain inhibition and report `uncertain`.
A later explicit Stop/Quit intent takes precedence over restart. Test the lost
reply before and after permit consumption, expired permit, process replacement
and owner death while the old runtime remains alive but permanently fenced.

Startup readers must include the start path in `src/cli/index.ts:515`, the
service manager's launch entry, Desktop supervision
in `desktop/src-tauri/src/` and the recovery worker. They check the same bound
record before launching an old installation; an unreadable or foreign record
does not grant permission to proceed. The implementation unit must trace the
actual entry paths on each platform and prove no owner bypasses this check;
until then that owner is ineligible for automatic installation. These are
proposed state transitions and ownership requirements, not existing behavior.

The proposed external entry is `ocx stop --for-update --operation-file <private-file>
--json`, returning a separately versioned `ocx.update.stop/1` result with
operation identity, stop/manager observation and teardown disposition. The
ordinary stop and existing `ocx-stop/1` stay unchanged. Automatic update-stop
must not take the ordinary forced-stop fallback, and no installer starts on an
unconfirmed exit or ambiguous manager result. These wire shapes and authority
checks still need exact definitions and independent review.

For Desktop, the native exit coordinator claims the stop and preserves newer
Stop/Quit intent before calling the new stop disposition. For a service, the
external owner reserves idle **before** stopping the bound manager and proves
manager inactivity before activation. For an unmanaged runtime, the external
owner observes process exit before activation. A durable inhibition record
outside the replaceable tree prevents eligible startup owners from restarting
the old tree during activation; owners that do not honor it are not eligible
for unattended installation. Connected-client and guest Desktop paths require
their own equivalent proof and remain open scope until it exists. The complete
cross-process activity roster, startup-owner integration and lock ordering are
still blockers, not assumed capabilities.

## Required failing-first scenarios

- A long-lived admitted stream makes reserve or commit defer; it receives no
  abort and the runtime remains healthy. Unknown activity is also deferred.
- A turn racing reservation is either admitted before the fence and blocks the
  update, or refused after it; it never starts after the idle verdict and before
  shutdown. Policy, process identity, selected installation and target are
  revalidated under the reservation immediately before commit.
- Cancellation, expiry, owner death, failed verification and a mismatched or
  replayed capability release only their own fence. A concurrent unrelated
  temporary drain is not released or converted by this operation.
- Successful commit makes shutdown admission permanent atomically, releases the
  update reservation, and reaches the existing stop/drain without waiting on
  itself. An abort or lost response is classified as uncertain until the owner
  is observed; no second installer starts on an unknown outcome.
- Desktop-supervised, service-owned and unsupervised runtimes preserve their
  existing ownership and Stop/Resume rules; explicit manual shutdown behavior
  and Lab core-path boundary remain unchanged.

## Candidate verification

Run the exact focused lifecycle, update admission, desktop ownership, service
and concurrency suites with isolated homes and deterministic barriers; first
demonstrate the regression tests fail on the unfixed behavior. Run
`bun run typecheck`, `bun run privacy:scan`, `bun run structure:check`, the
Lab core-boundary test, and exact-head PR CI. A separate independent security
review PASS is required. Before roadmap lock, resolve the command paths and
prove each observes the changed code; no full root suite.

Baseline on 2026-11-07: `bun test tests/service/shutdown-drain.test.ts`
passed 22 tests and `bun test tests/server/system-restart-admission.test.ts`
passed 34 tests (both exit 0). The former imports lifecycle and uses isolated
loopback listeners; the latter exercises the restart admission with fake
dependencies. The existing automatic-restart test explicitly verifies that a
turn can be cut at grace expiry, so a separate failing-first automatic-update
case is necessary. These baseline results do not prove the proposed update
admission behavior.

Proposed new regression files: `tests/server/update-activation-admission.test.ts`,
`tests/cli/cli-update-stop-admission.test.ts`,
`tests/service/update-stop-manager-contract.test.ts`,
`tests/storage/storage-update-admission.test.ts`,
`tests/clients/desktop-auto-update-stop-contract.test.ts`, and
`tests/update/update-activation-handoff.test.ts`. Place each in its listed
domain and register it in both layout and expected-fixture maps. These do not
exist yet and are not claimed as executed verifiers.
