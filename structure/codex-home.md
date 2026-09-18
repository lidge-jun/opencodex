# Codex Home

Catalog HTTP acquisition follows the [proxy-routing contract](catalog.md#remote-catalog-http-proxy-routing).

A lock in the Codex credential store is governed by [descriptor identity and age](catalog.md#accounts-namespaces-and-pool-rotation), so the mere presence of its filename is neither acquisition nor release authority. Failed path-identity probes leave the lock for stale recovery and preserve the refresh callback outcome. Cooperating lock metadata changes serialize through the existing SQLite mutation transaction; release keeps the descriptor open through identity comparison and any unlink, then closes it. Failed metadata writes remove only a matching owned path after successful coordination; unknown identity, failed probes or unavailable coordination retain the path for stale recovery. Async refresh work holds no metadata transaction.

CLI installation inspection reason codes, including Windows deferral, follow the [runtime inspection contract](runtime.md#lifecycle).

Explicit Codex CLI installation observation does not discover a Codex home or read/write its state. See the [read-only observation contract](runtime.md#explicit-codex-cli-installation-observation).

## Orca source-owned account import

`src/codex/orca-import.ts` reads only accounts listed in an explicitly selected Orca registry.
Each host-managed home must match its UUID directory and ownership marker. Preview is offline
and read-only; applying requires an initialized target and a stopped proxy. Existing main,
configured and orphan credential identities participate in account-ID deduplication.
Retry can complete an interrupted registration only for a sole, untouched importer-owned
pending credential matching the registered source path and identity; it retains that record's ID.

Imported pool records retain an access-token snapshot and a local source reference, with no
refresh token. `src/codex/orca-auth-source.ts` bounds reads and rejects linked or nonlocal paths.
`src/codex/account-store.ts` rereads the source before returning credentials, pins account and
subject identity, and fails closed for missing, expired or changed-identity sources. Orca owns
refresh; even forced refresh never exchanges its refresh token. A new source bearer advances
the target generation while retaining validation state and the same account's quota-history identity.
Writers captured under the old generation become stale; already retained history is not reset.
New imports remain validation-pending.

`src/codex/auth-api/pool-quota-probe.ts` also rechecks linked sources after asynchronous quota validation before
issuing deferred inference warmups. Already dispatched requests retain their captured bearer.

## Codex home

`src/codex/paths.ts` resolves Codex state from `CODEX_HOME` when set and valid, otherwise from
`~/.codex`. An unset `CODEX_HOME` falls back to `~/.codex`, including WSL discovery. An explicitly
set path that is unreadable or not a directory is an error, not a fallback: silently using a
different home than the operator named would write provider state where nobody is looking for it.
The managed files are:

```text
$CODEX_HOME/config.toml
$CODEX_HOME/opencodex.config.toml
$CODEX_HOME/opencodex-catalog.json
$CODEX_HOME/opencodex-journal.json
$CODEX_HOME/models_cache.json
$CODEX_HOME/.opencodex-native-main-profiles/
```

Never assume macOS-only paths. Windows, service installs, and app-launched Codex can all depend on
the resolved `CODEX_HOME`.

Observed catalog/cache rows and restore output follow the [retired-native policy](catalog.md#shared-catalog).
Restore filters retired bare and trusted account-qualified native rows from its output with or
without a backup. The original backup, historical user-selected settings and session records remain intact.

Journal restoration compares config and profile independently against their saved originals and
recorded injected hashes. If either changed artifact lacks its injected hash, the config/profile
pair and journal remain untouched and the result is explicitly unverified; callers must not
convert that refusal into successful fallback cleanup. Already-original bytes need no rewrite,
and absence is distinct from an empty file. The injector checks a retained hashless journal against
the same `baselineContent` it snapshots, plus the current profile, before writing or assigning a new
injected hash. Native content can establish a fresh snapshot; routed content cannot promote an
unverified older original. Existing hash-backed edit preservation and external-provider opt-out
remain separate paths.

The source-built Docker image explicitly keeps `CODEX_HOME=/home/bun/.codex` separate
from `OPENCODEX_HOME=/home/bun/.opencodex`. Compose persists them in `codex-state` and
`ocx-state` respectively, retaining a read-only root. The image creates owner-only
writable homes for `bun`; existing volume ownership and permissions are not repaired.
The catalog resolver is unchanged; a writable empty home is not a materialized catalog.

> Decision record: [ADR-0005](decisions/ADR-0005-codex-home.md)

`docker compose down` retains both volumes. `docker compose down --volumes` deletes
both `ocx-state` and `codex-state`, including their credentials and catalog/state;
treat it as destructive, not as an upgrade or restart command.

Service install-state ownership uses this same resolver. In WSL, an unset `CODEX_HOME` may resolve
to the single discoverable Windows Desktop home; recording Linux `~/.codex` instead would make a
later repair or uninstall look foreign even though the service and runtime were started from the
same environment. An explicit `CODEX_HOME` remains authoritative, and existing foreign ownership
records are never migrated implicitly.

> Decision record: [ADR-0006](decisions/ADR-0006-codex-home.md)

SQLite-backed thread state may live outside `CODEX_HOME`. The one resolver in `src/codex/paths.ts`
uses Codex's precedence: root `sqlite_home` in the effective `config.toml`, then
`CODEX_SQLITE_HOME`, then the effective `CODEX_HOME`; relative SQLite homes resolve from the current
working directory. History jobs resolve the database and its hashed backup identity together at
call time, and admission/residue checks consume the same database path. Storage retention still
owns the Codex-home tree separately and does not gain deletion authority over an external SQLite
root from this resolver alone. Durable service launchers preserve an explicitly supplied
`CODEX_SQLITE_HOME` so a background service resolves the same split state as the installing shell.
Service install state records that effective SQLite home beside `CODEX_HOME` and `OPENCODEX_HOME`,
and a lifecycle command requires the recorded value to match the current effective resolution; a
legacy record without the field keeps its existing behavior.
An absent `config.toml` or absent root `sqlite_home` permits the environment/home fallback. Any
other read failure, malformed TOML, wrong-typed or blank `sqlite_home` is indeterminate and fails
closed so history code cannot select a different database by accident. This strict parse is scoped
to SQLite ownership; the tolerant root-string helper used by injection and catalog reads is unchanged.

> Decision record: [ADR-0007](decisions/ADR-0007-codex-home.md)

Native-main profile ownership is bound to the real `CODEX_HOME`, not to an OpenCodex instance.
Its encrypted vault, transaction journal, recovery marker, and referenced quarantine files live in
the owner-only `.opencodex-native-main-profiles` directory. The unchanged
`.opencodex-native-profile.lock.sqlite` beside that directory serializes every process sharing the
home. Only plaintext login staging is instance-local under
`$OPENCODEX_HOME/native-main-profile-staging`; a stage from one instance is invalid in another.
These paths and the OS keyring are owner-only: the operating-system account that owns them is the
trust boundary and already has direct access to active native credentials. OpenCodex detects and
fails closed on file identities that change during an operation, but it does not claim isolation
from a malicious process already running as that same trusted OS account.

Startup and the periodic stage cleaner do not acquire the profile transaction lock when both the
stage registry and this instance's staging tree are proven absent. This keeps an unused profile
subsystem from fencing native traffic or creating lock contention. Presence, an unsafe entry type,
or any observation error still takes the locked sweep and fails closed; the fast path is based only
on proven absence, never on an unreadable path.

The native main slot also accepts one same-identity device reauth (#3898):
`/api/codex-auth/main/reauth-device` (start/status/cancel) plus
`ocx account main reauth`. The grant is the OpenAI deviceauth grant already
used for pool accounts, but nothing routes through the pool login surface —
`/api/codex-auth/login` keeps rejecting `__main__` — and the commit is a
sibling of the refresh write: same-identity check against the snapshot
captured at start, owner-independent exclusive claim (a headless hub runs no
owner lifecycle), path/hash/inode re-verification inside the claim, and one
atomic write of access/refresh/id token + account_id. The old identity token
is never retained beside the new grant. No claim is held while the human
completes the device page, and no DTO, log, or error carries tokens, emails,
or raw account ids. Cancellation is bound to the commit's exclusive claim and
is rechecked immediately before publication, so a cancel delivered while the
claim is contended aborts the wait and a cancelled flow cannot replace
`auth.json` or clear its reauthentication quarantine. A cancel that arrives
after the write still reports `succeeded`: the credential was replaced, so
that is the honest terminal.

> Decision record: [ADR-0008](decisions/ADR-0008-codex-home.md)

The native-write coordinator is keyed by the canonical `CODEX_HOME` in the effective-user runtime
namespace. A pathname alone is not authority: SQLite can expose a zero-byte file before its first
schema write, and a terminated process can leave that remnant behind. Eligibility treats the file
as non-authoritative only after an immutable SQLite read proves version zero with no tables, the
filesystem identity remains unchanged, and the file has been settled for at least one second; a
fresh zero-byte creator stays on the coordinated path so its lock cannot be bypassed. `ocx doctor` inspects the
coordinator with immutable read-only SQLite flags so diagnosis never creates WAL/SHM sidecars. It
distinguishes absent, zero-byte, unversioned, rowless, valid, unsupported, changed, unsafe, and
unreadable states and prints the exact path. Explicit recovery is available only after the proxy is
stopped and only for a proven zero-byte state. The command revalidates the same private
regular-file identity under a non-blocking SQLite write lock and moves it to a same-directory
backup; it never deletes or auto-adopts legacy routed residue.

> Decision record: [ADR-0009](decisions/ADR-0009-codex-home.md)

OpenCodex never overrides an explicit `CODEX_HOME`. On Windows, `ocx doctor` and `ocx status`
nevertheless diagnose the high-confidence Orca dual-home case: both `CODEX_HOME` and
`ORCA_CODEX_HOME` select Orca's `orca/codex-runtime-home/home`, while the ChatGPT/Codex app uses the
default `%USERPROFILE%\\.codex`. Sync and restore output always prints the exact target Codex home;
display and JSON paths redact the OS username. The diagnostic tells users to invoke OpenCodex with
the app home explicitly rather than silently claiming that an unrelated app was configured. If a
service was installed under the Orca home, it must first be uninstalled from that original Orca
environment and then reinstalled under the app home; changing only the current shell cannot migrate
the recorded service ownership.

> Decision record: [ADR-0010](decisions/ADR-0010-codex-home.md)

`atomicWriteFile` uses a temp file named `{path}.ocx.{pid}.{seq}.tmp` (process ID + incrementing
sequence number) to avoid collisions when concurrent writers (e.g. `ocx stop` and the proxy's own
shutdown handler) both restore Codex config simultaneously. The temp is renamed atomically into place.
Storage cleanup run metadata uses the field-scoped persisted-config mutation path, so a background
Worker cannot restore unrelated API keys or provider settings from a snapshot read before the lock.
If that metadata write is unavailable after cleanup has already completed, the job retains the
cleanup outcome and exposes a bounded persistence error instead of relabeling the run as a Worker failure.

Cleanup manifests and satellite backups share the stage-local atomic publisher: an exclusive
private temporary file is fully written and file-synced before the existing Windows-tolerant
rename replaces the destination. Handled publication failures retain the previous record;
directory syncing remains best-effort. This does not make a partial permanent purge reversible:
restore still fails closed when a recorded logical entry has no surviving file.

Windows secret-file hardening resolves the effective token SID through an absolute, trusted
PowerShell path before granting the owner and removing inherited broad ACL entries. The normal
path obtains System32 from `GetSystemDirectoryW`. Windows ARM64 Bun builds that cannot execute
`bun:ffi` use a narrower ACL-only fallback to the fixed protected default installation path
`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`. The fallback never applies to UAC or
Task Scheduler launch, never consults environment variables or `PATH`, and fails closed when the
fixed executable is absent.

Direct PowerShell children rely on the process launcher's `windowsHide`/hidden-host mechanism and
must not also receive the PowerShell CLI pair `-WindowStyle Hidden`. On affected Windows 11 systems,
Bun 1.3.14 exits that direct invocation before the command runs, which turns a valid SID or process
lookup into `EACLIDENTITY` or a failed sync. This does not apply to `Start-Process -WindowStyle
Hidden` inside an already-running PowerShell script, nor to .NET/VBS process-window settings.

> Decision record: [ADR-0011](decisions/ADR-0011-codex-home.md)

> Decision record: [ADR-0012](decisions/ADR-0012-codex-home.md)

The durable response-spill directory `~/.opencodex/responses-state-spill/` is bounded in
aggregate, not only per file. Continuation state demoted out of the in-memory cap
(`MAX_STORED_RESPONSE_BYTES`) is written there, and eviction past
`MAX_SPILLED_RESPONSE_BYTES` removes oldest-first through the same deletion point that serves
TTL and count eviction, so an evicted entry unlinks its file. One function owns that ceiling and
three callers drive it: mutation pruning, the lazy load that follows a restart, and the periodic
sweep. The periodic caller is not redundant — the mutation path runs only when traffic arrives, so a
process that comes up over budget from a snapshot written under a larger ceiling would otherwise
stay over it while idle.

The ceiling bounds what the store can account for, which is every entry in the map plus the
superseded generations queued for unlink, and deliberately not the directory as a whole. Spill files
orphaned by a crash are absent from the map, so this accounting can neither see nor price them; they
remain with the `recoverOrphanedResponseSpills` grace sweep described below, which is the only
mechanism that reclaims them. A host that crashes repeatedly can therefore hold spill bytes above
this ceiling for up to `RESPONSE_SPILL_ORPHAN_GRACE_MS` past each crash. Without that aggregate bound the
directory was limited only per file (256 MiB) and per entry (1000) — a 250 GiB product — which
left `RESPONSE_TTL_MS` as the only effective limit and made disk use a function of client
request rate rather than of anything the process controls.

> Decision record: [ADR-0013](decisions/ADR-0013-codex-home.md)

Response-state loading performs a bounded recovery pass for interrupted snapshot writes. It only
matches regular files named `responses-state.json.ocx.<pid>.<sequence>.tmp`, waits at least 15
minutes, and skips the current or any live PID. Eligible files are truncated before unlinking so a
matching stale path is unlinked without following it. Path-based truncation is intentionally avoided:
a same-user replacement could otherwise turn cleanup into a write through a symlink. Unrelated
temporary files, symlinks, directories, and young/active writes are never touched; directory entries
are consumed incrementally and at most 512 stale files are attempted per process start.

> Decision record: [ADR-0014](decisions/ADR-0014-codex-home.md)

Windows runtime response spills never wait on `icacls` through `Bun.spawnSync`. Linux and macOS
retain the immediate synchronous publication path. On Windows, the resident continuation enters one
serialized publication queue and remains replayable while `hardenSecretDirAsync` and
`hardenSecretPathAsync` run. Publication installs a spill stub only when the map still contains the
same resident object; a superseded job deletes its newly published file instead of overwriting newer
state. Pending payloads are pinned and capped at 256 MiB, so an ACL outage cannot grow an unbounded
queue or be misreported as evictable memory. One caller-owned retry is allowed after a real
`ETIMEDOUT`; the first timeout does not install a `spill-failed` tombstone. Required ACL failures
remain fail-closed after that bounded recovery. Optional config-directory hardening uses a separate
per-directory async single-flight, while required config mutation writers retain their existing
awaited or synchronous fail-closed boundary.

Each ordinary async spill write attempt owns one 30-second ACL budget shared across directory, temp,
and exclusive-copy destination hardening; the single timeout retry receives one fresh whole-attempt
budget. No harden step may reopen an independent 30-second window inside either attempt.
Both icacls and effective-principal subprocess waits are settlement-bounded: at deadline the child is
killed, unref'd, and abandoned without awaiting `proc.exited`. The caller-level deadline also bounds
injected/shared runners, so a child that ignores termination cannot pin the serialized spill queue.

Graceful shutdown drains that serialized publication queue to a stable fixed point before snapshot
serialization. The drain has a wall-clock cap with a reserved synchronous fallback budget; expiry
supersedes the async writer, claims and removes any temp or destination it still owns, and only then
starts fallback publication. The writer rechecks supersession before no-replace publication, while
the fallback splits its reserve across the directory and file ACL hardens. This ordering is
load-bearing because resident entries over 2 MiB are deliberately excluded from
`responses-state.json`: serializing first could omit the resident before its durable spill stub
exists, losing the continuation on restart. Cleanup is attempted for every abandoned writer; any
failure is retained while fallback and snapshot persistence continue, then returned through the
shutdown status so process exit is non-zero without sacrificing unrelated replay state.
If the fallback reserve expires, every remaining resident candidate is terminalized as a bounded
`spill-failed` tombstone before pruning, so no payload remains eligible for shutdown requeue and the
snapshot flush always regains control.
The terminalization pass itself is hard-capped at `MAX_STORED_RESPONSES + 1`; exceeding that
structural bound records a bounded failure, fail-closes every remaining resident, and returns control
to snapshot persistence instead of relying on the progress argument alone.

> Decision record: [ADR-0015](decisions/ADR-0015-codex-home.md)

## Codex-home diagnostics

Desktop executable membership uses the [discovered installation root](runtime.md#codex-desktop-process-membership), independently of the Codex state directory resolved here.

Some Codex-home conditions are reported rather than repaired, because repairing them would overwrite
a deliberate user choice:

- Bundled-plugin marketplace state on Windows (`src/codex/plugins-doctor.ts`), surfaced by
  `ocx status`.
- Project-level Codex config that bypasses managed routing
  (`src/codex/project-config-warnings.ts`), surfaced by `ocx doctor` as a warning rather than an
  override.

Codex display-cache expiry, retained blocking main-policy evidence, and reset history follow the
[quota cache contract](providers/openai-tiers.md#quota-cache-and-short-window-history).

Plan-based automatic exclusions leave native credential files untouched and preserve the native-main exemption in the [selection policy](providers/openai-tiers.md#automatic-pool-plan-exclusions).

## Prompt text probe

`src/codex/prompt-text-probe.ts` reports the prompt Codex assembles for the resolved Codex home. It
runs `codex debug prompt-input` in that home, bounded in time and in bytes, maps each rendered section
onto a layer, and takes no caller-supplied directory. Captured process output is never serialized
back: a failure is a classified kind plus a fixed phrase and the resolved command.

The base prompt is absent from that output, because Codex discards `base_instructions` before
rendering `prompt.input`. It is read from configuration instead, and it is read before the subprocess
starts, so an unresolved Codex runtime, a failed probe and a cancelled request all still answer with
it. Precedence follows Codex: a `model_instructions_file` decides the answer whenever the key is set,
including when the file it names is missing, blank or unreadable, and otherwise the selected model's
catalog row supplies `base_instructions`, with `model_messages.instructions_template` as the fallback.
Only the first form is reported as text Codex sends. A template is reported as a template and the
legacy `base-instructions` layer slot carries no text for it: that slot has five coarse reasons and no
representation, and its dialog labels every readable layer as text sent to the model.

Each configured source is opened once, non-blocking, and read to at most the probe's byte ceiling,
which is what keeps a FIFO, a device node or an oversized file from stalling or ballooning a
synchronous request. The regular-file check reads the opened descriptor rather than the path, and the
whole TOML document parses before any key from it is trusted, because Codex rejects a malformed
config outright. Every failure is a reason on the response rather than an exception, so the
management read degrades instead of returning an error page.

## Paginated history writer boundary

`src/codex/history-provider.ts` rejects provider-history changes with `history_paginated_requires_native_writer` when a target begins with an ordinal-bearing record, later contains a paginated record after a legacy start (#4311), or declares `history_mode=paginated`. The first line alone is not sufficient: a rollout that started unnumbered and was later migrated is also refused. Apply, manifest-backed restore, and explicit legacy recovery preflight all selected targets before changing database rows or manifests. The append boundary checks again. Codex owns ordinal allocation and the live projection cursor; reading the last ordinal and appending N+1 is not safe concurrent coordination. Legacy unnumbered rollouts retain their existing behavior. This guard prevents the observed stable-format corruption; it does not implement native-writer integration.

Injection preflights affected history using the normalized config candidate before writing config/profile/journal, then checks again after the complete artifact write. Native restore also rechecks after successful journal restoration or fallback removal, while exact config/profile/journal preimages and any coordinated remove transaction remain available for compensation.

The preflight opens the state store read-write-free and in that order deliberately. `{ readonly: true }` is the primary open and the only one that joins a live writer's WAL shared memory, so a thread another process just migrated to paginated history is visible and refuses here. A WAL store whose last writer closed cleanly has no `-shm` to join and a read-only connection may not create one, so that open fails `SQLITE_CANTOPEN` on a perfectly healthy store and the catch-all turned it into `history_injection_preflight_unavailable` on every attempt (#4943). The immutable fallback (`immutable=1` over a `file:` URI, the same idiom as the storage scanner and the log-guard inspector) is admitted only when neither `-wal` nor `-shm` is on disk, because that is the state in which the main database is the whole store and an immutable read is exact rather than stale. Either sidecar present, or any other open failure, keeps the original error and the refusal that follows: an immutable read is a snapshot, and a refusal this preflight fails to observe is a config transition over history Codex owns. The guard covers the whole primary attempt, not only the constructor. `sqlite3_open_v2` never reads page 1, so a WAL header is not inspected until the first prepare, and on macOS that is where the absent `-shm` is raised; the first read therefore happens inside the attempt, where the error can still be classified. Bun's bundled SQLite on Linux materializes both sidecars on that same read and never fails, which is why Linux and Windows evidence could not see this gap.

What a detected migration does depends on which refusal it is, and on direction. The reason that stands down is one exported constant, `HISTORY_RELABEL_STANDS_DOWN` in `src/codex/history-provider.ts`, because apply and restore have to agree on it exactly and once did not.

On apply, that reason retires the relabel unit and the config/profile/journal write stands when the admitted candidate preserves any existing provider table. Retention is decided before witness construction and does not depend on history preflight passing: apply keeps any existing provider definition while selecting the requested root provider. This also protects references when native migration begins after artifact commit or during worker startup, without compensating over newer native writes. Background worker failures remain reported, and candidate bytes never change after admission. Any other reason there — an unreadable state database, a changed rollout identity, a preflight that could not run — may succeed on a later attempt, so it still restores all three preimages before returning a structured refusal, including on legacy-uncoordinated homes.

On restore and removal, that same reason no longer refuses the config half. It selects a degraded restore: every OpenCodex root routing key comes out, `[model_providers.opencodex]` is retained verbatim including its ownership marker, and the history relabel is skipped rather than attempted. The retained table is captured from the pre-transform bytes and re-appended into the same buffer, so the write is one atomic transformation — a config carrying root `model_provider = "opencodex"` without a matching table fails the whole Codex config load, not one thread, which makes that intermediate state strictly worse than the routing it replaces. `resolveRestoreHistoryDisposition` in `src/codex/inject/restore.ts` is the single place that reads the preflight reason and answers the separate question of whether routing may come out. Every other reason keeps the hard refusal and compensates on every artifact, because retiring a provider definition its thread rows still name would orphan them. A failed config restore stops catalog/history work; coordinated restore rolls back its published remove transition. Legacy first-line provider patches are bound to the validated file identity before and after writing. These compensating checks do not provide a native-writer lock or authorize external ordinal allocation.

The legacy external writer is now refused for affected rows in any store whose schema includes history_mode, even while their row mode is still legacy. This deliberately sacrifices automatic relabeling on migration-capable stores rather than racing native conversion. It no longer costs the home its ability to be uninstalled: synchronous and asynchronous restore, inline journal restore, and direct config removal all take routing down on that reason while keeping the provider table, so an already-paginated home can be stopped and uninstalled and plain `codex` returns to the built-in provider. Rows naming `opencodex` still resolve through the retained table; their requests reach a proxy that is gone and fail with an ordinary connection error, which is a per-conversation failure rather than a broken config. `ocx restore --remove-codex-provider-table` removes the table for a user who accepts that those conversations stop opening; nothing selects it implicitly.

A degraded restore reports `artifacts.config.state = "partial"` with `action = "routing-restored-provider-retained"`, carries the retained lines and the follow-up command, and leaves `historyPreflightRefusal` unset — that field still means nothing was attempted at all, and a stop obligation that was in fact discharged must release its receipt rather than preserve it.

Native restore preflight also checks manifest-owned targets whose rows already returned to `openai`, including interrupted restores. Preimage capture distinguishes absent files from unreadable artifacts and aborts before mutation when a complete snapshot cannot be read.
A config restoration that was attempted and failed retains its failed artifact in the restore
result; unattempted catalog and history artifacts remain skipped. Successful preimage compensation
preserves config/profile/journal bytes without relabeling the failure as a skipped operation.
Incomplete compensation still raises the explicit partial-write error.

The [explicit model-capability contract](config.md#explicit-per-model-capability-declarations) preserves operator declarations through provider storage and catalog capture; it does not infer upstream capability or change this surface's routing behavior.

Exact [model input declarations](config.md#explicit-per-model-capability-declarations) now feed text-only eligibility and catalog hints; existing image-description/omission handling consumes them before the main upstream send.

Provider-scoped approval reviewer settings are projected by the [catalog owner](catalog.md#provider-scoped-approval-reviewer); this surface retains its existing routing, transport and account-selection behavior.

Private pool credential metadata follows the [quota-history publication identity contract](providers/openai-tiers.md#quota-history-publication-identity); credential-only and account DTO projections omit it.

Pool quota producers and account commands follow the [bounded raw-observation contract](providers/openai-tiers.md#bounded-pool-quota-observations), separate from the latest display snapshot and capacity estimates.

The account history response can include a [low-confidence effective capacity estimate](providers/openai-tiers.md#observed-effective-token-capacity); usage normalization retains local-answer provenance so local responses cannot supply samples.

Codex pool settings and their consumers follow the [reset-first ordering contract](providers/openai-tiers.md#reset-first-account-ordering), including independent-quota fallback, preserved affinity, strategy-specific threshold summaries, and shared short-observation freshness for switch warnings.

Upstream API-key usage follows the [physical-attempt account attribution contract](gui-and-management-api.md#upstream-key-account-attribution), independently of subscription quota observations.

Stored Direct substitution follows the [credential identity contract](providers/openai-tiers.md#sidecars-management-and-ui): both synchronous and asynchronous materializers discard the caller account header before applying the stored credential; ordinary native Direct passthrough is unchanged.
