# Codex Home

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

Some Codex-home conditions are reported rather than repaired, because repairing them would overwrite
a deliberate user choice:

- Bundled-plugin marketplace state on Windows (`src/codex/plugins-doctor.ts`), surfaced by
  `ocx status`.
- Project-level Codex config that bypasses managed routing
  (`src/codex/project-config-warnings.ts`), surfaced by `ocx doctor` as a warning rather than an
  override.
